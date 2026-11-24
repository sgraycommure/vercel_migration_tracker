"use client";

import { createClient, type Session } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { catalogKinds, day, labels, stamp, statuses, table, tools, validLink, type Entry, type Kind, type Tab, type ToolKey } from "./model";

import { feedbackSheetScope, feedbackSheetUrl, feedbackSyncKey, readFeedbackSheet } from "./feedback-sheet";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const client = url && key ? createClient(url, key, {
  auth: { flowType: "pkce", storageKey: "commure-tooling-tracker-session" }
}) : null;

const tabs: { key: Tab; name: string }[] = [
  { key: "overview", name: "Overview" }, { key: "catalog", name: "Features & metrics" },
  { key: "feedback", name: "Feedback" }, { key: "plan", name: "Build plans" },
  { key: "test", name: "Usage tracker" }
];

type Draft = { kind: Kind; entry?: Entry; parent?: Entry };
type Scope = ToolKey | "all";

function Mark({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`mark ${tone}`} aria-hidden="true">{children}</span>;
}

function Badge({ children }: { children: string }) {
  return <span className="badge" data-status={children}>{children}</span>;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [scope, setScope] = useState<Scope>("all");
  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [tester, setTester] = useState("");
  const [environment, setEnvironment] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [focused, setFocused] = useState<Entry | null>(null);
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [checkedUser, setCheckedUser] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProblem, setSyncProblem] = useState("");
  const userId = session?.user.id;
  const canManage = /^(admin|exec)$/i.test(role ?? "");

  useEffect(() => {
    if (!client) { setReady(true); return; }
    const authError = new URLSearchParams(window.location.hash.slice(1)).get("error_description");
    if (authError) setProblem("Google sign-in could not finish. Try again from this deployment.");
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const db = client;
    if (!db || !userId) {
      setRole(null);
      setCheckedUser(null);
      setEntries([]);
      setDraft(null);
      setFocused(null);
      return;
    }
    let active = true;
    async function load() {
      if (!db) return;
      setLoading(true);
      setProblem("");
      try {
        const access = await db.rpc("vercel_migration_tracker_access");
        if (!active) return;
        if (access.error) throw access.error;
        setRole(access.data);
        if (!access.data) return;
        const all: Entry[] = [];
        const pageSize = 500;
        for (let offset = 0; active; offset += pageSize) {
          const result = await db.from(table).select("*").order("created_at", { ascending: false })
            .order("id").range(offset, offset + pageSize - 1);
          if (result.error) throw result.error;
          all.push(...(result.data as Entry[]));
          if (result.data.length < pageSize) break;
        }
        if (active) setEntries(all);
      } catch {
        if (active) setProblem("The tracker could not load. Refresh to retry.");
      } finally {
        if (active) {
          setLoading(false);
          setCheckedUser(userId ?? null);
        }
      }
    }
    void load();
    return () => { active = false; };
  }, [userId, refresh]);

  useEffect(() => {
    const db = client;
    const pending = sessionStorage.getItem(feedbackSyncKey);
    if (!db || !canManage || checkedUser !== userId || !pending) return;
    sessionStorage.removeItem(feedbackSyncKey);
    setTab("feedback");
    const token = session?.provider_token;
    if (!token || Date.now() - Number(pending) > 10 * 60_000) {
      setSyncProblem("Google authorization did not finish. Reconnect to refresh feedback.");
      return;
    }
    setSyncing(true);
    readFeedbackSheet(token).then(async snapshot => {
      const { data, error } = await db.rpc("vercel_migration_tracker_sync_feedback", { snapshot });
      if (error) throw new Error("The workbook was read, but the tracker could not save it. Try again.");
      setRefresh(value => value + 1);
      setNotice(`Refreshed ${data} feedback entries from Google Sheets.`);
    }).catch((error: unknown) => {
      setSyncProblem(error instanceof Error ? error.message : "Feedback sync failed. Try again.");
    }).finally(() => setSyncing(false));
  }, [canManage, checkedUser, session?.provider_token, userId]);

  async function connectFeedbackSheet() {
    if (!client || syncing) return;
    setSyncing(true);
    setSyncProblem("");
    sessionStorage.setItem(feedbackSyncKey, String(Date.now()));
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: new URL("/auth/callback", window.location.origin).href,
        scopes: feedbackSheetScope,
        queryParams: { hd: "commure.com", prompt: "consent" }
      }
    });
    if (error) {
      sessionStorage.removeItem(feedbackSyncKey);
      setSyncProblem("Google authorization could not start. Try again.");
      setSyncing(false);
    }
  }

  async function signIn() {
    if (!client) return;
    setSigningIn(true);
    setProblem("");
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: new URL("/auth/callback", window.location.origin).href, queryParams: { hd: "commure.com" } }
    });
    if (error) {
      setProblem("Google sign-in could not start. Try again.");
      setSigningIn(false);
    }
  }

  function navigate(nextTab: Tab, nextScope = scope) {
    setTab(nextTab);
    setScope(nextScope);
    setSearch("");
    setStatus("");
    setKind("");
    setTester("");
    setEnvironment("");
    setNotice("");
    setFocused(null);
  }

  if (!ready || !session || !role || checkedUser !== userId) {
    return <main className="signin">
      <section className="sign-card">
        <Mark tone="blue">TT</Mark>
        <p className="eyebrow">Enterprise Operations</p>
        <h1>Tooling Tracker</h1>
        <p className="muted">Track features, metrics, build plans, and testing across the five tools.</p>
        {problem && <p className="alert" role="alert">{problem}</p>}
        {!ready || (session && (loading || checkedUser !== userId)) ? <p role="status">Checking access…</p>
          : !client ? <p className="alert">Supabase connection settings are missing for this deployment.</p>
          : session ? <>
            {!problem && <p className="alert">Access requires an active Commure account in the Enterprise Operations user directory.</p>}
            <div className="actions">
              <button className="secondary" onClick={() => void client.auth.signOut()}>Sign out</button>
              {problem && <button className="primary" onClick={() => setRefresh(value => value + 1)}>Retry</button>}
            </div>
          </> : <button className="primary" disabled={signingIn} onClick={() => void signIn()}>{signingIn ? "Opening Google…" : "Sign in with Google"}</button>}
      </section>
    </main>;
  }

  const scoped = entries.filter(entry => (scope === "all" || entry.tool_key === scope)
    && !(entry.kind === "feedback" && entry.feedback_sheet_present === false));
  const selectedTool = tools.find(tool => tool.key === scope);
  const summary = selectedTool ? scoped.find(entry => entry.kind === "tool") : undefined;
  const tests = scoped.filter(entry => entry.kind === "test");
  const plans = scoped.filter(entry => entry.kind === "plan" && entry.status !== "Shipped");
  const feedback = scoped.filter(entry => entry.kind === "feedback" && entry.status !== "Resolved");
  const catalog = scoped.filter(entry => catalogKinds.has(entry.kind));
  const currentTab = tabs.find(item => item.key === tab)!;
  const tabRows = tab === "catalog" ? catalog : scoped.filter(entry => entry.kind === tab);
  const statusOptions = tab === "catalog" ? statuses.feature : tab === "overview" ? [] : statuses[tab];
  const people = [...new Set(tests.map(entry => entry.actor_email).filter((email): email is string => !!email))].sort();
  const query = search.trim().toLowerCase();
  const filtered = tabRows.filter(entry =>
    (!status || entry.status === status) && (!kind || entry.kind === kind)
    && (!tester || entry.actor_email === tester) && (!environment || entry.environment === environment)
    && (!query || [entry.title, entry.details, entry.area, entry.owner, entry.actor_email, entry.metric_source, entry.feedback_requester, entry.feedback_response, entry.feedback_sheet_status,
      tools.find(tool => tool.key === entry.tool_key)?.name].some(value => value?.toLowerCase().includes(query)))
  );
  if (tab === "catalog") filtered.sort((a, b) => (a.area ?? "").localeCompare(b.area ?? "") || a.title.localeCompare(b.title));
  const itemById = new Map(entries.map(entry => [entry.id, entry]));
  const canEdit = (entry: Entry) => entry.kind !== "tool" && entry.kind !== "test" && !entry.feedback_sheet_tab && (canManage || entry.created_by === userId);

  function onSaved(entry: Entry) {
    setEntries(current => [entry, ...current.filter(item => item.id !== entry.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
    navigate(entry.kind === "feature" || entry.kind === "metric" ? "catalog" : entry.kind as Tab, scope);
    setDraft(null);
    setNotice(`${labels[entry.kind]} saved.`);
  }

  return <div className="shell">
    <a className="skip" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Workspace">
      <button className="identity" onClick={() => navigate("overview", "all")}>
        <Mark tone="brand">TT</Mark><span><strong>Tooling Tracker</strong><small>Enterprise Operations</small></span>
      </button>
      <div className="side-group">
        <p className="side-label">WORKSPACE</p>
        <button className={scope === "all" ? "side-link active" : "side-link"} aria-current={scope === "all" ? "page" : undefined} onClick={() => navigate("overview", "all")}>
          <span className="all-icon" aria-hidden="true">▦</span> All tools
        </button>
      </div>
      <div className="side-group">
        <p className="side-label">TOOLS</p>
        {tools.map(tool => <button key={tool.key} className={scope === tool.key ? "side-link active" : "side-link"}
          aria-current={scope === tool.key ? "page" : undefined} onClick={() => navigate("overview", tool.key)}>
          <Mark tone={tool.color}>{tool.short}</Mark>{tool.name}</button>)}
      </div>
      <div className="sidebar-footer">
        <span title={session.user.email}>{session.user.email}</span>
        <button onClick={() => void client?.auth.signOut()}>Sign out</button>
      </div>
    </aside>
    <main id="main-content">
      <header className="topbar">
        <span>{scope === "all" ? "Workspace" : "Tools"} <span aria-hidden="true" className="slash">/</span> <strong>{selectedTool?.name ?? "All tools"}</strong></span>
        <button className="primary" onClick={() => setDraft({ kind: "test" })}>＋ Log test action</button>
      </header>
      <div className="content">
        <section className="hero">
          <p className="eyebrow">{selectedTool ? "Tool overview" : "Operations portfolio"}</p>
          <h1>{selectedTool?.name ?? "Tooling portfolio"}</h1>
          <p>{summary?.details ?? "Review what’s built, what’s planned, and what users have tested."}</p>
          {summary && <div className="hero-links">
            {validLink(summary.deployment_url) && <a href={validLink(summary.deployment_url)!} target="_blank" rel="noreferrer">Open production ↗</a>}
            <a href={`https://vercel.com/sgray-5128/${selectedTool?.repo}`} target="_blank" rel="noreferrer">Vercel deployments ↗</a>
            {validLink(summary.source_url) && <a href={validLink(summary.source_url)!} target="_blank" rel="noreferrer">GitHub ↗</a>}
          </div>}
        </section>
        <nav className="tabs" aria-label="Tracker sections">
          {tabs.map(item => <button key={item.key} aria-current={item.key === tab ? "page" : undefined} onClick={() => navigate(item.key)}>{item.name}</button>)}
        </nav>
        {notice && <p className="notice" role="status">{notice}</p>}
        {problem && <p className="alert" role="alert">{problem} <button className="link-button" onClick={() => setRefresh(value => value + 1)}>Refresh</button></p>}
        {loading && <p role="status" className="muted">Loading tracker…</p>}
        {tab === "overview" ? <>
          <section className="stats" aria-label="Tracking totals">
            <Stat title="Catalog entries" value={catalog.length} detail={`${catalog.filter(entry => entry.kind === "feature").length} features · ${catalog.filter(entry => entry.kind === "metric").length} metrics`} onClick={() => navigate("catalog")} />
            <Stat title="Open build plans" value={plans.length} detail="Backlog through testing" onClick={() => navigate("plan")} />
            <Stat title="Open feedback" value={feedback.length} detail="New or triaged" onClick={() => navigate("feedback")} />
            <Stat title="Test actions" value={tests.length} detail={`${people.length} ${people.length === 1 ? "tester" : "testers"} · ${tests.filter(entry => entry.status === "Passed").length} passed`} onClick={() => navigate("test")} />
          </section>
          {scope === "all" ? <section className="section">
            <div className="section-head"><h2>Tools</h2></div>
            <div className="tool-grid">
              {tools.map(tool => {
                const rows = entries.filter(entry => entry.tool_key === tool.key);
                return <button className="tool-card" key={tool.key} onClick={() => navigate("overview", tool.key)}>
                  <div className="tool-card-top"><Mark tone={tool.color}>{tool.short}</Mark><span aria-hidden="true">↗</span></div>
                  <h3>{tool.name}</h3><p>{rows.find(entry => entry.kind === "tool")?.details}</p>
                  <span className="tool-count">{rows.filter(entry => entry.kind === "feature").length} features · {rows.filter(entry => entry.kind === "metric").length} metrics</span>
                </button>;
              })}
            </div>
          </section> : <section className="section">
            <div className="section-head"><h2>Evaluation follow-up</h2><button className="secondary" onClick={() => navigate("catalog")}>View catalog</button></div>
            <EntryTable rows={catalog.filter(entry => ["Needs verification", "Data gap"].includes(entry.status))} visibleTool={false} onOpen={setFocused} items={itemById} />
          </section>}
          <section className="section">
            <div className="section-head"><h2>Recent testing</h2><button className="secondary" onClick={() => navigate("test")}>View usage tracker</button></div>
            <EntryTable rows={tests.slice(0, 5)} visibleTool={scope === "all"} onOpen={setFocused} items={itemById} empty="No test actions recorded yet." />
          </section>
        </> : <section className="section">
          <div className="section-head"><div><h2>{currentTab.name}</h2>
            {tab === "test" && <p className="muted">Test actions recorded by signed-in users, with deployment, outcome, and notes.</p>}
            {tab === "catalog" && <p className="muted">Expand a tool to see its features, metrics, and metric sources.</p>}
            {tab === "feedback" && <p className="muted">Feedback from the migration spreadsheet and entries submitted here.</p>}
          </div><div className="actions">
            {tab === "feedback" && <>
              <a className="secondary" href={feedbackSheetUrl} target="_blank" rel="noreferrer">Open feedback sheet ↗</a>
              {canManage && <button className="secondary" disabled={syncing} onClick={() => void connectFeedbackSheet()}>
                {syncing ? "Syncing…" : "Sync Google Sheet"}
              </button>}
            </>}
            {tab === "catalog" ? canManage && <>
              <button className="secondary" onClick={() => setDraft({ kind: "feature" })}>Add feature</button>
              <button className="secondary" onClick={() => setDraft({ kind: "metric" })}>Add metric</button>
            </> : tab !== "test" && <button className="primary" onClick={() => setDraft({ kind: tab })}>Add {labels[tab].toLowerCase()}</button>}
          </div></div>
          {tab === "feedback" && syncProblem && <p className="alert" role="alert">{syncProblem}</p>}
          <div className="filters">
            <input aria-label="Search entries" placeholder="Search entries" type="search" value={search} onChange={event => setSearch(event.target.value)} />
            {tab === "catalog" && <select aria-label="Entry type" value={kind} onChange={event => setKind(event.target.value)}><option value="">All types</option><option value="feature">Features</option><option value="metric">Metrics</option></select>}
            <select aria-label="Status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statusOptions.map(value => <option key={value}>{value}</option>)}</select>
            {tab === "test" && <>
              <select aria-label="Tester" value={tester} onChange={event => setTester(event.target.value)}><option value="">All testers</option>{people.map(person => <option key={person}>{person}</option>)}</select>
              <select aria-label="Environment" value={environment} onChange={event => setEnvironment(event.target.value)}><option value="">All environments</option><option>Preview</option><option>Production</option><option>Local</option></select>
            </>}
          </div>
          {tab === "catalog" || tab === "feedback" ? <ToolGroups key={`${tab}-${scope}`}
            scope={scope} tab={tab} rows={filtered} items={itemById} onOpen={setFocused}
            filterKind={kind} filtering={!!(query || kind || status)} />
            : <EntryTable rows={filtered} visibleTool={scope === "all"} onOpen={setFocused} items={itemById} usage={tab === "test"}
              empty={tabRows.length ? "No entries match these filters." : "No entries recorded yet."} />}
        </section>}
      </div>
    </main>
    {focused && <EntryDetails entry={focused} parent={focused.parent_id ? itemById.get(focused.parent_id) : undefined}
      close={() => setFocused(null)} edit={canEdit(focused) ? () => { setDraft({ kind: focused.kind, entry: focused }); setFocused(null); } : undefined}
      add={focused.kind !== "test" ? nextKind => { setDraft({ kind: nextKind, parent: focused }); setFocused(null); } : undefined}
    />}
    {draft && <Editor draft={draft} scope={scope} entries={entries} onClose={() => setDraft(null)} onSaved={onSaved} />}
  </div>;
}

function Stat({ title, detail, value, onClick }: { title: string; detail: string; value: number; onClick: () => void }) {
  return <button className="stat" onClick={onClick}><span>{title}</span><strong>{value}</strong><small>{detail}</small></button>;
}

function ToolGroups({ scope, tab, rows, filterKind, filtering, items, onOpen }: {
  scope: Scope; tab: "catalog" | "feedback"; rows: Entry[]; filterKind: string; filtering: boolean;
  items: Map<string, Entry>; onOpen: (entry: Entry) => void;
}) {
  const [expanded, setExpanded] = useState<Partial<Record<ToolKey, boolean>>>({});
  const groups = tools.filter(tool => scope === "all" || tool.key === scope);
  return <div className="tool-groups">
    {groups.map(tool => {
      const groupRows = rows.filter(entry => entry.tool_key === tool.key);
      const features = groupRows.filter(entry => entry.kind === "feature");
      const metrics = groupRows.filter(entry => entry.kind === "metric");
      const open = expanded[tool.key] ?? (scope !== "all" || filtering || tab === "feedback");
      return <div className="tool-group" key={tool.key}>
        <h3><button className="tool-group-toggle" aria-expanded={open} aria-controls={`${tab}-${tool.key}-entries`}
          onClick={() => setExpanded(current => ({ ...current, [tool.key]: !open }))}>
          <Mark tone={tool.color}>{tool.short}</Mark><span className="group-name">{tool.name}</span>
          <span className="group-count">{tab === "catalog" ? `${features.length} features · ${metrics.length} metrics` : `${groupRows.length} feedback`}</span>
          <span className="group-chevron" aria-hidden="true">⌄</span>
        </button></h3>
        <div id={`${tab}-${tool.key}-entries`} className="tool-group-content" hidden={!open}>
          {open && (tab === "feedback"
            ? <EntryTable rows={groupRows} visibleTool={false} variant="feedback" items={items} onOpen={onOpen}
                empty={filtering ? "No feedback matches these filters." : "No feedback recorded for this tool."} />
            : <>
              {filterKind !== "metric" && <section><h4>Features</h4>
                <EntryTable rows={features} visibleTool={false} items={items} onOpen={onOpen} empty="No matching features." />
              </section>}
              {filterKind !== "feature" && <section><h4>Metrics</h4>
                <EntryTable rows={metrics} visibleTool={false} variant="metric" items={items} onOpen={onOpen} empty="No matching metrics." />
              </section>}
            </>)}
        </div>
      </div>;
    })}
  </div>;
}

function EntryTable({ rows, visibleTool, usage, variant, items, onOpen, empty = "No follow-up entries." }: {
  rows: Entry[]; visibleTool: boolean; usage?: boolean; variant?: "metric" | "feedback"; items: Map<string, Entry>; onOpen: (entry: Entry) => void; empty?: string;
}) {
  const showTest = usage || rows[0]?.kind === "test";
  const showPlan = rows[0]?.kind === "plan";
  if (!rows.length) return <p className="empty">{empty}</p>;
  return <div className="table-wrap"><table>
    <thead><tr><th>{showTest ? "Action" : variant === "metric" ? "Metric" : variant === "feedback" ? "Feedback" : "Entry"}</th>{visibleTool && <th>Tool</th>}<th>{showTest ? "Outcome" : "Status"}</th>
      {showTest ? <><th>Tester</th><th>Environment</th><th>Logged (ET)</th></> :
        showPlan ? <><th>Owner</th><th>Target date</th></> : variant === "feedback" ? <><th>Requested by</th><th>Source</th></>
          : variant === "metric" ? <><th>Area</th><th>Metric source</th></> : <th>Area / type</th>}</tr></thead>
    <tbody>{rows.map(entry => <tr key={entry.id}>
      <td><button className="row-link" onClick={() => onOpen(entry)}>{entry.title}</button>
        {entry.parent_id && <small className="subline">{items.get(entry.parent_id)?.title}</small>}</td>
      {visibleTool && <td>{tools.find(tool => tool.key === entry.tool_key)?.name}</td>}
      <td><Badge>{entry.status}</Badge>{entry.feedback_sheet_status && <small className="subline">{entry.feedback_sheet_status}</small>}</td>
      {showTest ? <><td>{entry.actor_email ?? "—"}</td><td>{entry.environment}</td><td className="nowrap">{stamp.format(new Date(entry.created_at))}</td></>
        : showPlan ? <><td>{entry.owner ?? "—"}</td><td>{entry.due_date ? day.format(new Date(entry.due_date)) : "—"}</td></>
        : variant === "feedback" ? <><td>{entry.feedback_requester ?? entry.actor_email ?? "—"}</td><td>
          {entry.feedback_sheet_tab && validLink(entry.source_url)
            ? <a href={validLink(entry.source_url)!} target="_blank" rel="noreferrer">{entry.feedback_sheet_tab} ↗</a> : "Tracker"}
        </td></> : variant === "metric" ? <><td>{entry.area ?? "—"}</td><td>
          <span>{entry.metric_source || "—"}</span>
          {validLink(entry.source_url) && <span className="subline"><a href={validLink(entry.source_url)!} target="_blank" rel="noreferrer">View source ↗</a></span>}
        </td></> : <td>{[entry.area, labels[entry.kind]].filter(Boolean).join(" · ")}</td>}
    </tr>)}</tbody>
  </table></div>;
}

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return <dialog ref={dialog} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="dialog-head"><h2 id="dialog-title">{title}</h2><button type="button" className="close" aria-label="Close" onClick={close}>×</button></header>
    {children}
  </dialog>;
}

function EntryDetails({ entry, parent, close, edit, add }: {
  entry: Entry; parent?: Entry; close: () => void; edit?: () => void; add?: (kind: Kind) => void;
}) {
  const source = validLink(entry.source_url);
  const deployment = validLink(entry.deployment_url);
  return <Modal title={entry.title} close={close}>
    <div className="dialog-body">
      <div className="detail-meta">{tools.find(tool => tool.key === entry.tool_key)?.name} <Badge>{entry.status}</Badge></div>
      {entry.area && <p className="muted">{entry.area} · {labels[entry.kind]}</p>}
      <p className="details-copy">{entry.details || "No notes added."}</p>
      {entry.metric_source && <p><strong>Metric source</strong> {entry.metric_source}</p>}
      {entry.feedback_requester && <p><strong>Requested by</strong> {entry.feedback_requester}</p>}
      {entry.feedback_sheet_status && <p><strong>Sheet status</strong> {entry.feedback_sheet_status}</p>}
      {entry.feedback_response && <p className="details-copy"><strong>Response</strong> {entry.feedback_response}</p>}
      {entry.feedback_sheet_present === false && <p className="muted">This entry was removed from the source sheet.</p>}
      {parent && <p><strong>Related entry</strong> {parent.title}</p>}
      {entry.actor_email && <p><strong>{entry.kind === "test" ? "Tester" : "Submitted by"}</strong> {entry.actor_email}</p>}
      {entry.environment && <p><strong>Environment</strong> {entry.environment}</p>}
      {entry.owner && <p><strong>Owner</strong> {entry.owner}</p>}
      {entry.due_date && <p><strong>Target date</strong> {day.format(new Date(entry.due_date))}</p>}
      <p className="muted">{entry.kind === "test" ? "Logged" : "Last updated"} {stamp.format(new Date(entry.updated_at))} ET</p>
      <div className="actions">{deployment && <a href={deployment} target="_blank" rel="noreferrer">Open deployment ↗</a>}
        {source && <a href={source} target="_blank" rel="noreferrer">{entry.feedback_sheet_tab ? "Open sheet row" : "Review source"} ↗</a>}</div>
    </div>
    {(edit || add) && <footer className="dialog-footer">
      {edit && <button className="secondary" onClick={edit}>Edit</button>}
      {add && <><button className="secondary" onClick={() => add("feedback")}>Add feedback</button>
        <button className="secondary" onClick={() => add("plan")}>Add build plan</button>
        <button className="primary" onClick={() => add("test")}>Log test</button></>}
    </footer>}
  </Modal>;
}

function Editor({ draft, scope, entries, onClose, onSaved }: {
  draft: Draft; scope: Scope; entries: Entry[]; onClose: () => void; onSaved: (entry: Entry) => void;
}) {
  const { kind, entry, parent } = draft;
  const [tool, setTool] = useState<string>(entry?.tool_key ?? parent?.tool_key ?? (scope === "all" ? "" : scope));
  const [related, setRelated] = useState(entry?.parent_id ?? parent?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const relatedEntries = entries.filter(item => item.id !== entry?.id && item.tool_key === tool && (catalogKinds.has(item.kind) || item.kind === "plan" || item.kind === "feedback"))
    .sort((a, b) => a.title.localeCompare(b.title));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || saving) return;
    const form = new FormData(event.currentTarget);
    const read = (name: string) => String(form.get(name) ?? "").trim();
    const title = read("title");
    const deployment = read("deployment_url");
    const source = read("source_url");
    if (!title || !tool) { setProblem("Select a tool and enter a title."); return; }
    if ((deployment && !validLink(deployment)) || (source && !validLink(source))) {
      setProblem("Use a valid https:// link."); return;
    }
    const values = {
      title, details: read("details"), status: read("status"), parent_id: related || null,
      area: read("area") || null, owner: read("owner") || null, due_date: read("due_date") || null,
      deployment_url: deployment || null, source_url: source || null,
      ...(kind === "metric" ? { metric_source: read("metric_source") || null } : {})
    };
    setSaving(true);
    setProblem("");
    try {
      const result = entry
        ? await client.from(table).update(values).eq("id", entry.id).select().single()
        : await client.from(table).insert({ ...values, tool_key: tool, kind, environment: read("environment") || null }).select().single();
      if (result.error) throw result.error;
      onSaved(result.data as Entry);
    } catch {
      setProblem("This entry could not be saved. Check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={entry ? `Edit ${labels[kind].toLowerCase()}` : kind === "test" ? "Log test action" : `Add ${labels[kind].toLowerCase()}`} close={() => { if (!saving) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-body form">
        {problem && <p className="alert wide" role="alert">{problem}</p>}
        <label className="wide">Tool<select required value={tool} disabled={!!entry || !!parent} onChange={event => { setTool(event.target.value); setRelated(""); }}>
          <option value="">Select a tool</option>{tools.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
        <label className="wide">{kind === "test" ? "Action tested" : "Title"}<input name="title" required maxLength={160} defaultValue={entry?.title} /></label>
        <label>{kind === "test" ? "Outcome" : "Status"}<select name="status" defaultValue={entry?.status ?? (catalogKinds.has(kind) ? "Needs verification" : statuses[kind][0])}>
          {statuses[kind].map(value => <option key={value}>{value}</option>)}</select></label>
        {kind === "test" && <label>Environment<select name="environment"><option>Preview</option><option>Production</option><option>Local</option></select></label>}
        {catalogKinds.has(kind) && <label>Area<input name="area" maxLength={80} defaultValue={entry?.area ?? ""} /></label>}
        {kind === "plan" && <>
          <label>Owner<input name="owner" maxLength={160} defaultValue={entry?.owner ?? ""} /></label>
          <label>Target date<input type="date" name="due_date" defaultValue={entry?.due_date ?? ""} /></label>
        </>}
        <label className="wide">Related entry <select value={related} onChange={event => setRelated(event.target.value)}>
          <option value="">None</option>{relatedEntries.map(item => <option key={item.id} value={item.id}>{labels[item.kind]} · {item.title}</option>)}</select></label>
        <label className="wide">{kind === "test" ? "Steps and observations" : kind === "plan" ? "Scope and acceptance criteria" : "Details"}
          <textarea name="details" rows={4} maxLength={5000} defaultValue={entry?.details} required={kind === "feedback" || kind === "plan"} /></label>
        {(kind === "test" || kind === "plan") && <label className="wide">Deployment link <input name="deployment_url" type="url" maxLength={1000} placeholder="https://…" defaultValue={entry?.deployment_url ?? ""} /></label>}
        {kind === "metric" && <label className="wide">Metric source<input name="metric_source" maxLength={500} defaultValue={entry?.metric_source ?? ""} /></label>}
        {catalogKinds.has(kind) && <label className="wide">Source link <input name="source_url" type="url" maxLength={1000} placeholder="https://…" defaultValue={entry?.source_url ?? ""} /></label>}
      </div>
      <footer className="dialog-footer"><button className="secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button></footer>
    </form>
  </Modal>;
}
