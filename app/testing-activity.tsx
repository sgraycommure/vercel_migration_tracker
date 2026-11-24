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

const outcomes = ["Passed", "Failed", "Blocked", "Started", "Succeeded", "Viewed", "Not recorded"];

export function TestingActivity({ db, scope, compact, onOpen }: {
  db: SupabaseClient;
  scope: Scope;
  compact?: boolean;
  onOpen: (id: string) => void;
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
  const pageSize = compact ? 8 : 50;
  const selectedTool = scope === "all" ? tool || null : scope;

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

  return <>
    {!compact && <>
      <p className="muted activity-note">Includes recorded app opens, page views, clicks, and saved actions. Clicks without an outcome are marked “Not recorded.”</p>
      <form className="filters" onSubmit={event => { event.preventDefault(); setPage(null); setQuery(search.trim()); }}>
        <input aria-label="Search testing activity" placeholder="Tester, page, action, or session" value={search} onChange={event => setSearch(event.target.value)} />
        <button className="secondary">Search</button>
        {scope === "all" && <select aria-label="Filter testing tool" value={tool} onChange={event => { setPage(null); setTool(event.target.value); }}>
          <option value="">All tools</option><option value="tracker">Tooling Tracker activity</option>
          {tools.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
        </select>}
        <select aria-label="Filter testing outcome" value={outcome} onChange={event => { setPage(null); setOutcome(event.target.value); }}>
          <option value="">All outcomes</option>{outcomes.map(value => <option key={value}>{value}</option>)}
        </select>
        <button type="button" className="secondary" onClick={reload}>Refresh activity</button>
      </form>
    </>}
    {problem && <p className="alert" role="alert">Testing activity could not load. <button className="link-button" onClick={reload}>Retry</button></p>}
    {rows.length > 0 && <div className="table-wrap"><table>
      <thead><tr><th>Time (ET)</th><th>Tester</th><th>Tool / environment</th><th>Function tested</th><th>Action</th><th>Outcome</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.event_key}>
        <td className="nowrap">{stamp.format(new Date(row.occurred_at))}</td>
        <td>{row.actor || "Unknown tester"}{row.session_id && <small className="subline" title={row.session_id}>Session {row.session_id.slice(0, 8)}</small>}</td>
        <td>{tools.find(item => item.key === row.tool_key)?.name ?? row.source}<small className="subline">{[row.source, row.environment].filter(Boolean).join(" · ")}</small></td>
        <td>{row.page || "Application"}</td>
        <td>{row.entry_id ? <button className="row-link" onClick={() => onOpen(row.entry_id!)}>{row.action}</button> : row.action}</td>
        <td><span className="badge" data-status={row.outcome === "Succeeded" ? "Passed" : row.outcome}>{row.outcome}</span></td>
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
