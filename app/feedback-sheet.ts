import { feedbackStatuses, type Entry, type ToolKey } from "./model";

const spreadsheetId = "10xuhvk-AlT83RaYQ3en2jD3n3L1zNmNpJ2oRHirJ6RM";
export const feedbackSheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
export const feedbackSheetScope = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const feedbackWriteScope = "https://www.googleapis.com/auth/spreadsheets";
export const feedbackWriteKey = "tooling-tracker-feedback-write";
export const feedbackSyncKey = "tooling-tracker-feedback-sync";

const tabs: Record<string, ToolKey> = {
  "implementation tracker": "launch",
  "enterprise launch tracker": "launch",
  "launch tracker": "launch",
  "efficiency log": "efficiency",
  "enterprise efficiency log": "efficiency",
  "px dashboard": "px",
  "capacity management": "capacity",
  "enterprise capacity management": "capacity",
  "customer operations": "customer-ops",
  "customer operations workspace": "customer-ops"
};

type SheetProperties = { sheetId: number; title: string };
type SheetFeedback = { row: number; title: string; requester: string; notes: string; status: string; response: string };
type FeedbackTab = { tool: ToolKey; gid: number; name: string; rows: SheetFeedback[] };
type WorkbookTab = FeedbackTab & { notesColumn: number; statusColumn: number };

export class SheetsAuthorizationError extends Error {}

async function request<T>(token: string, path: string, query = new URLSearchParams(), body?: unknown): Promise<T> {
    const result = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}?${query}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000)
    });
    if (result.status === 401) {
      throw new SheetsAuthorizationError("Google Sheets access expired. Select Sync Google Sheet to reconnect.");
    }
    if (result.status === 403) {
      const body = await result.json().catch(() => null);
      const reasons = [
        ...(body?.error?.details ?? []).map((detail: { reason?: string }) => detail.reason),
        ...(body?.error?.errors ?? []).map((detail: { reason?: string }) => detail.reason)
      ];
      if (reasons.includes("SERVICE_DISABLED") || reasons.includes("accessNotConfigured")) {
        throw new Error("Enable the Google Sheets API in the Google Cloud project used for tracker sign-in, then retry.");
      }
      if (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || reasons.includes("insufficientPermissions")) {
        throw new SheetsAuthorizationError("Google Sheets read permission is required. Select Sync Google Sheet to reconnect.");
      }
      throw new Error("Google denied access to the workbook. Check that the connected account can open Vercel Migration Feedback.");
    }
    if (!result.ok) throw new Error(`Google Sheets could not be read (HTTP ${result.status}). Try again.`);
    return result.json();
  }

async function readWorkbook(token: string): Promise<WorkbookTab[]> {
  const metadata = await request<{ sheets: { properties: SheetProperties }[] }>(token, "", new URLSearchParams({ fields: "sheets.properties(sheetId,title)" }));
  const mapped = metadata.sheets.flatMap(({ properties }) => {
    const tool = tabs[properties.title.trim().toLowerCase()];
    return tool ? [{ tool, gid: properties.sheetId, name: properties.title }] : [];
  });
  if (mapped.length !== 5 || new Set(mapped.map(tab => tab.tool)).size !== 5) {
    throw new Error("The sheet must have one recognized feedback tab for each of the five tools.");
  }

  const query = new URLSearchParams();
  for (const tab of mapped) query.append("ranges", `'${tab.name.replaceAll("'", "''")}'!A:E`);
  const { valueRanges } = await request<{ valueRanges: { values?: string[][] }[] }>(token, "/values:batchGet", query);
  if (valueRanges.length !== mapped.length) throw new Error("Google Sheets returned an incomplete workbook.");
  return mapped.map((tab, index) => {
    const [header = [], ...rows] = valueRanges[index].values ?? [];
    const columns = ["feedback", "requested by", "notes", "status", "response"].map(name =>
      header.findIndex(cell => String(cell).trim().toLowerCase() === name)
    );
    if (columns.some(column => column < 0)) {
      throw new Error(`${tab.name} is missing a feedback column. The previous import is still available.`);
    }
    const feedback = rows.flatMap((cells, rowIndex) => {
      const [title, requester, notes, status, response] = columns.map(column => String(cells[column] ?? "").trim());
      return title ? [{ row: rowIndex + 2, title, requester, notes, status, response }] : [];
    });
    return { ...tab, rows: feedback, notesColumn: columns[2], statusColumn: columns[3] };
  });
}

export async function readFeedbackSheet(token: string): Promise<FeedbackTab[]> {
  return (await readWorkbook(token)).map(({ tool, gid, name, rows }) => ({ tool, gid, name, rows }));
}

function normalizeStatus(value: string) {
  switch (value.trim().toLowerCase()) {
    case "reviewed - not proceeding":
    case "reviewed – not proceeding":
    case "no change":
    case "no code changes":
      return "Reviewed - Not Proceeding";
    case "done":
    case "resolved":
    case "closed":
    case "complete":
    case "completed":
      return "Resolved";
    default:
      return "Pending";
  }
}

export async function configureFeedbackStatuses(token: string) {
  const workbook = await readWorkbook(token);
  const requests = workbook.flatMap(tab => [
    {
      setDataValidation: {
        range: { sheetId: tab.gid, startRowIndex: 1, startColumnIndex: tab.statusColumn, endColumnIndex: tab.statusColumn + 1 },
        rule: {
          condition: { type: "ONE_OF_LIST", values: feedbackStatuses.map(userEnteredValue => ({ userEnteredValue })) },
          strict: true, showCustomUi: true
        }
      }
    },
    ...tab.rows.filter(row => row.status !== normalizeStatus(row.status)).map(row => ({
      updateCells: {
        start: { sheetId: tab.gid, rowIndex: row.row - 1, columnIndex: tab.statusColumn },
        rows: [{ values: [{ userEnteredValue: { stringValue: normalizeStatus(row.status) } }] }],
        fields: "userEnteredValue"
      }
    }))
  ]);
  await request(token, ":batchUpdate", undefined, { requests });
}

export async function writeFeedbackSheet(token: string, entry: Entry, changes: { status?: string; notes?: string }) {
  const tab = (await readWorkbook(token)).find(item => item.tool === entry.tool_key);
  const identity = (value: string, length: number) => Array.from(value.trim()).slice(0, length).join("").toLowerCase();
  const matches = tab?.rows.filter(row =>
    identity(row.title, 160) === identity(entry.title, 160) &&
    identity(row.requester, 300) === identity(entry.feedback_requester ?? "", 300)
  );
  if (!tab || matches?.length !== 1) {
    throw new Error("The workbook row could not be matched uniquely. Sync Google Sheet and reopen the feedback.");
  }
  const [row] = matches;
  if ((changes.status !== undefined && normalizeStatus(row.status) !== entry.status && row.status !== changes.status) ||
      (changes.notes !== undefined && row.notes !== entry.details && row.notes !== changes.notes)) {
    throw new Error("The workbook was edited since the last sync. Sync Google Sheet and reopen the feedback.");
  }
  const update = (column: number, value: string) => ({
    range: `'${tab.name.replaceAll("'", "''")}'!${String.fromCharCode(65 + column)}${row.row}`,
    values: [[value]]
  });
  const data = [];
  if (changes.status !== undefined && row.status !== changes.status) data.push(update(tab.statusColumn, changes.status));
  if (changes.notes !== undefined && row.notes !== changes.notes) data.push(update(tab.notesColumn, changes.notes));
  if (data.length) await request(token, "/values:batchUpdate", undefined, { valueInputOption: "RAW", data });
}
