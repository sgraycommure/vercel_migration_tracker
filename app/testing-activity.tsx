import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stamp, tools, type Scope } from "./model";

export type TrackedOutcome = "Not recorded" | "Viewed" | "Failed";

type Activity = {
  event_key: string;
  occurred_at: string;
  tool_key: string | null;
  source: string;
  actor: string | null;
  session_id: string | null;
  environment: string | null;
  page: string;
  action: string;
  outcome: string;
  entry_id: string | null;
};

const editableOutcomes = ["Passed", "Failed", "Blocked", "Started"];
const outcomes = [...editableOutcomes, "Succeeded", "Viewed", "Not recorded"];

export function TestingActivity({ db, scope, compact, group, showOutcomes = false, onOpen }: {
  db: SupabaseClient;
  scope: Scope;
  compact?: boolean;
  group?: string;
  showOutcomes?: boolean;
  onOpen: (id: string, outcome: string) => void;
}) {
  const [rows, setRows] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(false);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState("");
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState<{ time: string; key: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Activity | null>(null);
  const [selectedOutcome, setSelectedOutcome] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [notice, setNotice] = useState("");
  const pageSize = compact ? 8 : 50;
  const selectedTool = group ?? (scope === "all" ? tool || null : scope);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setProblem(false);
    void db.rpc("vercel_migration_tracker_testing_feed", {
      selected_tool: selectedTool, search_text: query, outcome_filter: outcome || null,
      before_time: page?.time ?? null, before_key: page?.key ?? null, page_size: pageSize + 1
    }).then(({ data, error }) => {
      if (!active) return;
      setLoading(false);
      if (error) { setProblem(true); return; }
      const received = data as Activity[];
      setMore(received.length > pageSize);
      const next = received.slice(0, pageSize);
      setRows(current => page ? [...current, ...next.filter(item => !current.some(previous => previous.event_key === item.event_key))] : next);
    });
    return () => { active = false; };
  }, [db, selectedTool, query, outcome, page, pageSize, revision]);

  function reload() {
    setPage(null);
    setRevision(value => value + 1);
  }

  async function saveOutcome() {
    if (!editing || saving) return;
    setSaving(true);
    setEditError("");
    const { data, error } = await db.rpc("vercel_migration_tracker_set_outcome", {
      test_event: editing.event_key, new_outcome: selectedOutcome || null, expected_outcome: editing.outcome
    });
    setSaving(false);
    if (error) {
      setEditError(error.code === "40001" ? "This outcome changed. Cancel and refresh before editing again." : "The outcome could not be saved.");
      return;
    }
    setRows(current => current.map(row => row.event_key === editing.event_key ? { ...row, outcome: data as string } : row)
      .filter(row => !outcome || row.outcome === outcome));
    setEditing(null);
    setNotice("Outcome saved.");
  }

  return <>
    {!compact && <>
      {!group && <p className="muted activity-note">Includes recorded app opens, page views, clicks, and saved actions.</p>}
      <form className="filters" onSubmit={event => { event.preventDefault(); setPage(null); setQuery(search.trim()); }}>
        <input aria-label="Search testing activity" placeholder="Tester, page, action, or session" value={search} onChange={event => setSearch(event.target.value)} />
        <button className="secondary">Search</button>
        {scope === "all" && !group && <select aria-label="Filter testing tool" value={tool} onChange={event => { setPage(null); setTool(event.target.value); }}>
          <option value="">All tools</option>
          {tools.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
        </select>}
        {showOutcomes && <select aria-label="Filter testing outcome" value={outcome} onChange={event => { setPage(null); setOutcome(event.target.value); }}>
          <option value="">All outcomes</option>{outcomes.map(value => <option key={value}>{value}</option>)}
        </select>}
        <button type="button" className="secondary" onClick={reload}>Refresh activity</button>
      </form>
    </>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {editError && <p className="alert" role="alert">{editError}</p>}
    {problem && <p className="alert" role="alert">Testing activity could not load. <button className="link-button" onClick={reload}>Retry</button></p>}
    {rows.length > 0 && <div className="table-wrap"><table>
      <thead><tr><th>Time (ET)</th><th>Tester</th><th>Tool / environment</th><th>Function tested</th><th>Action</th>{showOutcomes && <th>Outcome</th>}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.event_key}>
        <td className="nowrap">{stamp.format(new Date(row.occurred_at))}</td>
        <td>{row.actor || "Unknown tester"}{row.session_id && <small className="subline" title={row.session_id}>Session {row.session_id.slice(0, 8)}</small>}</td>
        <td>{tools.find(item => item.key === row.tool_key)?.name ?? row.source}<small className="subline">{[row.source, row.environment].filter(Boolean).join(" · ")}</small></td>
        <td>{row.page || "Application"}</td>
        <td>{row.entry_id ? <button className="row-link" onClick={() => onOpen(row.entry_id!, row.outcome)}>{row.action}</button> : row.action}</td>
        {showOutcomes && <td>{editing?.event_key === row.event_key ? <div className="outcome-editor">
          <select aria-label="Test outcome" value={selectedOutcome} disabled={saving} onChange={event => setSelectedOutcome(event.target.value)}>
            <option value="">Use recorded outcome</option>{editableOutcomes.map(value => <option key={value}>{value}</option>)}
          </select>
          <button className="secondary" disabled={saving} onClick={() => void saveOutcome()}>Save outcome</button>
          <button className="link-button" disabled={saving} onClick={() => { setEditing(null); setEditError(""); }}>Cancel</button>
        </div> : <div className="outcome-editor">
          <span className="badge" data-status={row.outcome === "Succeeded" ? "Passed" : row.outcome}>{row.outcome}</span>
          <button className="link-button" disabled={saving} onClick={() => {
            setEditing(row); setNotice(""); setEditError("");
            setSelectedOutcome(editableOutcomes.includes(row.outcome) ? row.outcome : "");
          }}>Edit outcome</button>
        </div>}</td>}
      </tr>)}</tbody>
    </table></div>}
    {loading && <p className="empty" role="status">Loading testing activity…</p>}
    {!rows.length && !loading && !problem && <p className="empty">No recorded activity matches this view.</p>}
    {!compact && more && <button className="secondary activity-more" disabled={loading} onClick={() => {
      const last = rows.at(-1);
      if (last) setPage({ time: last.occurred_at, key: last.event_key });
    }}>Load older activity</button>}
  </>;
}


export function WorkspaceTesting({ db, onOpen }: { db: SupabaseClient; onOpen: (id: string, outcome: string) => void }) {
  const [totals, setTotals] = useState<Record<string, { testers: number; actions: number }> | null>(null);
  const [error, setError] = useState(false);
  const [active, setActive] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setError(false);
    void db.rpc("vercel_migration_tracker_testing_totals").then(result => {
      if (!current) return;
      if (result.error) { setError(true); return; }
      setTotals(Object.fromEntries((result.data as { group_key: string; testers: number; actions: number }[])
        .map(row => [row.group_key, row])));
    });
    return () => { current = false; };
  }, [db, refresh]);
  return <section className="section" aria-label="Testing by tool">
    <div className="section-head"><div><h2>Testing by tool</h2>
      <p className="muted">Tester counts use distinct recorded identities. Actions tested include all captured activity, including opens, page views, clicks, and manual tests.</p>
    </div><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh testing</button></div>
    {error && <p className="alert" role="alert">Testing totals could not load.</p>}
    <div className="tool-groups">{tools.map(group => {
      const groupTotals = totals?.[group.key];
      const expanded = active === group.key;
      return <div className="tool-group" key={group.key}>
        <h3><button className="tool-group-toggle" aria-expanded={expanded} aria-controls={`testing-${group.key}`}
          onClick={() => setActive(expanded ? "" : group.key)}>
          <span>{group.name}</span><span className="group-count">
            {totals ? `${groupTotals?.testers ?? 0} testers · ${(groupTotals?.actions ?? 0).toLocaleString()} actions tested` : "—"}
          </span><span className="group-chevron" aria-hidden="true">⌄</span>
        </button></h3>
        <div id={`testing-${group.key}`} className="tool-group-content" hidden={!expanded}>
          {expanded && <TestingActivity key={refresh} db={db} scope="all" group={group.key} showOutcomes onOpen={onOpen} />}
        </div>
      </div>;
    })}</div>
  </section>;
}
