import type { ToolKey } from "./model";

const spreadsheetId = "10xuhvk-AlT83RaYQ3en2jD3n3L1zNmNpJ2oRHirJ6RM";
export const feedbackSheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
export const feedbackSheetScope = "https://www.googleapis.com/auth/spreadsheets.readonly";
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

export class SheetsAuthorizationError extends Error {}

export async function readFeedbackSheet(token: string): Promise<FeedbackTab[]> {
  async function request<T>(path: string, query: URLSearchParams): Promise<T> {
    const result = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
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

  const metadata = await request<{ sheets: { properties: SheetProperties }[] }>("", new URLSearchParams({ fields: "sheets.properties(sheetId,title)" }));
  const mapped = metadata.sheets.flatMap(({ properties }) => {
    const tool = tabs[properties.title.trim().toLowerCase()];
    return tool ? [{ tool, gid: properties.sheetId, name: properties.title }] : [];
  });
  if (mapped.length !== 5 || new Set(mapped.map(tab => tab.tool)).size !== 5) {
    throw new Error("The sheet must have one recognized feedback tab for each of the five tools.");
  }

  const query = new URLSearchParams();
  for (const tab of mapped) query.append("ranges", `'${tab.name.replaceAll("'", "''")}'!A:E`);
  const { valueRanges } = await request<{ valueRanges: { values?: string[][] }[] }>("/values:batchGet", query);
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
    return { ...tab, rows: feedback };
  });
}
