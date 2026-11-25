"use client";

import { createClient, type Session } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { catalogKinds, day, labels, launchCategories, stamp, statuses, table, tools, validLink, type Entry, type Kind, type Scope, type Tab, type ToolKey } from "./model";

import { configureFeedbackStatuses, feedbackSheetScope, feedbackSheetUrl, feedbackSyncKey, feedbackWriteKey, feedbackWriteScope, readFeedbackSheet, SheetsAuthorizationError, writeFeedbackSheet } from "./feedback-sheet";

import LaunchManagement, { completionStatus, LaunchProgress, launchProgressRows } from "./launch-management";
import { TestingActivity, WorkspaceTesting, type TrackedOutcome } from "./testing-activity";

import ReleaseTesting from "./release-testing";
import ReadinessPlan from "./readiness-plan";

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

type Draft = { kind: Kind; entry?: Entry; parent?: Entry; tool?: ToolKey; launchCategory?: string };
const activitySessionKey = "tooling-tracker-browser-session";
const environmentName = ({ preview: "Preview", production: "Production", development: "Local" } as Record<string, string>)[process.env.NEXT_PUBLIC_VERCEL_ENV ?? ""] ?? null;

function logActivity(tool: Scope, page: string, action: string, outcome: TrackedOutcome) {
  if (!client) return;
  let browserSession = sessionStorage.getItem(activitySessionKey);
  if (!browserSession) {
    browserSession = crypto.randomUUID();
    sessionStorage.setItem(activitySessionKey, browserSession);
  }
  void client.rpc("vercel_migration_tracker_log_activity", {
    browser_session: browserSession, tool: tool === "all" ? null : tool,
    app_page: page, app_action: action, result: outcome, build_environment: environmentName
  }).then(() => undefined);
}

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
  const [pendingChecks, setPendingChecks] = useState<string[]>([]);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [deletion, setDeletion] = useState<{ entries: Entry[]; tool: ToolKey | null } | null>(null);
  const [deleteProblem, setDeleteProblem] = useState("");
  const lastView = useRef("");
  const userId = session?.user.id;
  const isAdmin = /^admin$/i.test(role ?? "");
  const activityPage = tab === "launch" ? "Launch Management" : tab === "testing" ? "Usage tracker" : tabs.find(item => item.key === tab)?.name ?? "Overview";
  const canRecord = !!userId && !!role && checkedUser === userId;
  const canManage = /^(admin|exec)$/i.test(role ?? "");
  const showSources = canRecord && session?.user.email?.toLowerCase() === "sgray@commure.com";

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
      setDeletion(null);
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

  async function refreshFeedbackSheet(token: string) {
    if (!client) return;
    const snapshot = await readFeedbackSheet(token);
    const { data, error } = await client.rpc("vercel_migration_tracker_sync_feedback", { snapshot });
    if (error) throw new Error("The workbook was read, but the tracker could not save it. Try again.");
    setRefresh(value => value + 1);
    setNotice(`Refreshed ${data} feedback entries from Google Sheets.`);
  }

  useEffect(() => {
    const writePending = sessionStorage.getItem(feedbackWriteKey);
    const pending = writePending ?? sessionStorage.getItem(feedbackSyncKey);
    if (!pending || !canManage || checkedUser !== userId) return;
    sessionStorage.removeItem(feedbackSyncKey);
    sessionStorage.removeItem(feedbackWriteKey);
    setTab("feedback");
    const token = session?.provider_token;
    if (!token || Date.now() - Number(pending) > 10 * 60_000) {
      setSyncProblem("Google authorization did not finish. Select Sync Google Sheet to try again.");
      return;
    }
    setSyncing(true);
    (async () => {
      if (writePending) await configureFeedbackStatuses(token);
      await refreshFeedbackSheet(token);
      if (writePending) setNotice("Google Sheets editing is connected and status dropdowns are set on all five tabs.");
    })().catch(error => {
      setSyncProblem(error instanceof Error ? error.message : "Feedback sync failed. Try again.");
    }).finally(() => setSyncing(false));
  }, [canManage, checkedUser, session?.provider_token, userId]);

  useEffect(() => {
    if (!canRecord) { lastView.current = ""; return; }
    const view = `${userId}:${scope}:${activityPage}`;
    if (view !== lastView.current) {
      lastView.current = view;
      logActivity(scope, activityPage, "View page", "Viewed");
    }
    function recordClick(event: MouseEvent) {
      const element = event.target instanceof Element
        ? event.target.closest<HTMLElement>("button, summary, input[type=checkbox], a[data-activity]") : null;
      if (!element || element.matches(":disabled")) return;
      // Use control labels only. Titles from operational records and form contents stay out of telemetry.
      const action = element.dataset.activity || (
        element.matches(".row-link, .tool-link, .stat") ? "Open tracker record or view"
          : element.closest(".launch-checklist") ? "Use checklist control"
          : element.matches("summary") ? "Expand section"
          : element.getAttribute("aria-label") || element.textContent?.trim() || "Use application control"
      );
      logActivity(scope, activityPage, action.slice(0, 100), "Not recorded");
    }
    document.addEventListener("click", recordClick, true);
    return () => document.removeEventListener("click", recordClick, true);
  }, [canRecord, userId, scope, activityPage]);

  function storeEntries(saved: Entry[]) {
    const ids = new Set(saved.map(entry => entry.id));
    setEntries(current => [...saved, ...current.filter(item => !ids.has(item.id))].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }

  async function saveStatus(entry: Entry, nextStatus: string) {
    if (!client || !canManage || pendingChecks.includes(entry.id) || nextStatus === entry.status) return;
    setPendingChecks(current => [...current, entry.id]);
    try {
      const result = await client.from(table).update({ status: nextStatus })
        .eq("id", entry.id).eq("updated_at", entry.updated_at).select().single();
      if (result.error) throw result.error;
      storeEntries([result.data as Entry]);
      if (catalogKinds.has(entry.kind) && entry.status === "Removed") setRefresh(value => value + 1);
      setNotice(`${labels[entry.kind]} status saved.`);
    } catch {
      setNotice("The status could not be updated. Refreshing the latest record.");
      setRefresh(value => value + 1);
      logActivity(entry.tool_key, activityPage, "Save status", "Failed");
    } finally {
      setPendingChecks(current => current.filter(id => id !== entry.id));
    }
  }

  async function syncReadiness(copies: Entry[], checked: boolean) {
    if (!client || !canManage || readinessBusy) return;
    setReadinessBusy(true);
    try {
      const { data, error } = await client.rpc("vercel_migration_tracker_edit_readiness", {
        item_key: copies[0].readiness_group ?? copies[0].id,
        versions: Object.fromEntries(copies.map(item => [item.id, item.updated_at])),
        changes: { status: checked ? "Complete" : "Open" }
      });
      if (error) throw error;
      storeEntries(data as Entry[]);
      setNotice("Checklist status saved.");
    } catch {
      setNotice("The checklist status could not be saved. Reloading the latest plan.");
      setRefresh(value => value + 1);
    } finally {
      setReadinessBusy(false);
    }
  }

  async function moveReadiness(item: string, adjacent: string, placeAfter?: boolean) {
    if (!client || !canManage || readinessBusy) return false;
    setReadinessBusy(true);
    try {
      const { data, error } = await client.rpc("vercel_migration_tracker_move_readiness", {
        tool: scope === "all" ? null : scope, item_key: item, adjacent_key: adjacent,
        ...(placeAfter === undefined ? {} : { place_after: placeAfter })
      });
      if (error) throw error;
      storeEntries(data as Entry[]);
      return true;
    } catch {
      setNotice("The checklist order could not be saved. Reloading the latest plan.");
      setRefresh(value => value + 1);
      return false;
    } finally {
      setReadinessBusy(false);
    }
  }

  function confirmDeletion(entries: Entry[], tool: ToolKey | null) {
    setDeleteProblem("");
    setDeletion({ entries, tool });
  }

  async function deleteReadiness() {
    if (!client || !deletion || !canManage || readinessBusy) return;
    const { entries: copies, tool } = deletion;
    const [entry] = copies;
    setReadinessBusy(true);
    setDeleteProblem("");
    try {
      const { data, error } = await client.rpc("vercel_migration_tracker_delete_readiness", {
        selected_tool: tool,
        item_key: tool ? entry.id : entry.readiness_group ?? entry.id,
        versions: Object.fromEntries(copies.map(copy => [copy.id, copy.updated_at]))
      });
      if (error) throw error;
      const removed = new Set<string>(data);
      setEntries(current => current.filter(item => !removed.has(item.id)));
      setDeletion(null);
      setNotice(copies.length > 1 ? `Checklist item deleted from ${copies.length} tools.` : "Checklist item deleted.");
    } catch {
      setDeleteProblem("The item could not be deleted. Close this dialog and reopen the item to try again.");
      setRefresh(value => value + 1);
    } finally {
      setReadinessBusy(false);
    }
  }

  async function connectFeedbackSheet(enableEditing = false) {
    if (!client || !canManage || syncing) return;
    setSyncing(true);
    setSyncProblem("");
    setNotice("");
    try {
      if (session?.provider_token) {
        try {
          if (enableEditing) await configureFeedbackStatuses(session.provider_token);
          await refreshFeedbackSheet(session.provider_token);
          if (enableEditing) setNotice("Google Sheets editing is connected and status dropdowns are set on all five tabs.");
          return;
        } catch (error) {
          if (!(error instanceof SheetsAuthorizationError)) throw error;
        }
      }
      const pendingKey = enableEditing ? feedbackWriteKey : feedbackSyncKey;
      sessionStorage.setItem(pendingKey, String(Date.now()));
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: new URL("/auth/callback", window.location.origin).href,
          scopes: enableEditing ? feedbackWriteScope : feedbackSheetScope,
          queryParams: { hd: "commure.com", login_hint: session?.user.email ?? "" }
        }
      });
      if (error) {
        sessionStorage.removeItem(pendingKey);
        throw new Error("Google authorization could not start. Try again.");
      }
    } catch (error) {
      setSyncProblem(error instanceof Error ? error.message : "Feedback sync failed. Try again.");
    } finally {
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
    setTab(nextTab === "plan" && !showSources ? "overview" : nextTab);
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
  const feedback = scoped.filter(entry => entry.kind === "feedback" && entry.status === "Pending");
  const catalog = scoped.filter(entry => catalogKinds.has(entry.kind));
  const currentTab = tabs.find(item => item.key === tab);
  const tabRows = tab === "catalog" ? catalog : scoped.filter(entry => entry.kind === tab);
  const statusOptions = tab === "catalog" ? statuses.feature : tab === "overview" || tab === "testing" ? [] : statuses[tab];
  const people = [...new Set(tests.map(entry => entry.actor_email).filter((email): email is string => !!email))].sort();
  const query = search.trim().toLowerCase();
  const filtered = tabRows.filter(entry =>
    (!status || entry.status === status) && (!kind || entry.kind === kind)
    && (!tester || entry.actor_email === tester) && (!environment || entry.environment === environment)
    && (!query || [entry.title, entry.details, entry.area, entry.owner, entry.actor_email, entry.metric_source, entry.feedback_requester, entry.feedback_response,
      tools.find(tool => tool.key === entry.tool_key)?.name].some(value => value?.toLowerCase().includes(query)))
  );
  if (tab === "catalog") filtered.sort((a, b) => (a.area ?? "").localeCompare(b.area ?? "") || a.title.localeCompare(b.title));
  const itemById = new Map(entries.map(entry => [entry.id, entry]));
  const canEdit = (entry: Entry) => entry.kind !== "tool" && entry.kind !== "test" &&
    (canManage || (!entry.feedback_sheet_tab && entry.created_by === userId));

  function openEditor(entry: Entry) {
    setFocused(null);
    setDraft({ kind: entry.kind, entry });
  }

  async function saveSheetFeedback(entry: Entry, status: string, notes: string) {
    if (!session?.provider_token) throw new SheetsAuthorizationError();
    await writeFeedbackSheet(session.provider_token, entry, {
      ...(status !== entry.status ? { status } : {}),
      ...(notes !== entry.details ? { notes } : {})
    });
    try {
      await refreshFeedbackSheet(session.provider_token);
    } catch {
      throw new Error("Google Sheets was updated. Select Sync Google Sheet to refresh the tracker.");
    }
    setDraft(null);
    setNotice("Feedback saved to Google Sheets.");
  }

  function openTest(id: string, outcome: string) {
    const entry = itemById.get(id);
    setFocused(entry ? { ...entry, status: outcome } : null);
  }

  function onSaved(saved: Entry[]) {
    const [entry] = saved;
    const catalog = catalogKinds.has(entry.kind);
    if (entry.kind === "launch" && draft?.entry) {
      const previous = draft.entry;
      const removed = new Set(entries.filter(item => item.id === previous.id ||
        (previous.readiness_group && item.readiness_group === previous.readiness_group)).map(item => item.id));
      setEntries(current => current.filter(item => !removed.has(item.id)));
    }
    storeEntries(saved);
    if (catalog) setRefresh(value => value + 1);
    if (tab !== "launch" && tab !== "testing" && entry.kind !== "launch") {
      const nextScope = catalog && scope !== "all" && saved.length === 1 ? entry.tool_key : scope;
      navigate(catalog ? "catalog" : entry.kind as Tab, saved.length > 1 ? "all" : nextScope);
    }
    setDraft(null);
    setNotice(saved.length > 1 ? `${labels[entry.kind]} ${draft?.entry ? "updated on" : "added to"} ${saved.length} tools.` : `${labels[entry.kind]} saved.`);
  }

  return <div className="shell">
    <a className="skip" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Workspace">
      <button className="identity" onClick={() => navigate("overview", "all")}>
        <Mark tone="brand">TT</Mark><span><strong>Tooling Tracker</strong><small>Enterprise Operations</small></span>
      </button>
      <div className="side-group">
        <p className="side-label">WORKSPACE</p>
        <button className={scope === "all" && tab !== "launch" && tab !== "testing" ? "side-link active" : "side-link"} aria-current={scope === "all" && tab !== "launch" && tab !== "testing" ? "page" : undefined} onClick={() => navigate("overview", "all")}>
          <span className="all-icon" aria-hidden="true">▦</span> All tools
        </button>
        <button className={tab === "launch" ? "side-link active" : "side-link"} aria-current={tab === "launch" ? "page" : undefined}
          onClick={() => navigate("launch", "all")}><span className="all-icon" aria-hidden="true">☑</span> Launch Management</button>
        <button className={tab === "testing" ? "side-link active" : "side-link"} aria-current={tab === "testing" ? "page" : undefined}
          onClick={() => navigate("testing", "all")}><span className="all-icon" aria-hidden="true">✓</span> Testing</button>
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
        <span>{scope === "all" ? "Workspace" : "Tools"} <span aria-hidden="true" className="slash">/</span> <strong>{tab === "launch" ? "Launch Management" : tab === "testing" ? "Testing" : selectedTool?.name ?? "All tools"}</strong></span>
        <button className="primary" onClick={() => setDraft({ kind: "test" })}>＋ Log test action</button>
      </header>
      <div className="content">
        <section className="hero">
          <p className="eyebrow">{selectedTool ? "Tool overview" : "Operations portfolio"}</p>
          <h1>{tab === "launch" ? "Launch Management" : tab === "testing" ? "Testing" : selectedTool?.name ?? "Tooling portfolio"}</h1>
          <p>{tab === "launch" ? "Track the work each tool needs before rollout." : tab === "testing" ? "Review activity and record test outcomes by tool." : summary?.details ?? "Review what’s built, what’s planned, and what users have tested."}</p>
          {summary && showSources && <div className="hero-links">
            {validLink(summary.deployment_url) && <a href={validLink(summary.deployment_url)!} target="_blank" rel="noreferrer">Open production ↗</a>}
            <a href={`https://vercel.com/sgray-5128/${selectedTool?.repo}`} target="_blank" rel="noreferrer">Vercel deployments ↗</a>
            {validLink(summary.source_url) && <a href={validLink(summary.source_url)!} target="_blank" rel="noreferrer">GitHub ↗</a>}
          </div>}
        </section>
        {tab !== "launch" && tab !== "testing" && <nav className="tabs" aria-label="Tracker sections">
          {tabs.filter(item => item.key !== "plan" || showSources).map(item => <button key={item.key} aria-current={item.key === tab ? "page" : undefined} onClick={() => navigate(item.key)}>{item.name}</button>)}
        </nav>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {problem && <p className="alert" role="alert">{problem} <button className="link-button" onClick={() => setRefresh(value => value + 1)}>Refresh</button></p>}
        {loading && <p role="status" className="muted">Loading tracker…</p>}
        {tab === "testing" ? <>
          <ReleaseTesting entries={entries} managing={canManage} pending={pendingChecks} onOpen={setFocused}
            onStatus={(entry, status) => void saveStatus(entry, status)} />
          {isAdmin && client && <WorkspaceTesting db={client} onOpen={openTest} />}
        </>
        : tab === "launch" ? <LaunchManagement entries={entries} managing={canManage} showBuildPlans={showSources} pending={pendingChecks}
          onAdd={(tool, launchCategory) => setDraft({ kind: "launch", tool, launchCategory })} onEdit={entry => setDraft({ kind: entry.kind, entry, tool: entry.tool_key })}
          onDelete={entry => confirmDeletion([entry], entry.tool_key)}
          onCheck={(entry, checked) => void saveStatus(entry, completionStatus(entry, checked))} onOpen={setFocused} />
        : tab === "overview" ? <>
          {scope === "all" && <section className="section" aria-label="Launch progress by tool">
            <div className="section-head"><h2>Launch progress by tool</h2></div>
            <div className="tool-grid">
              {tools.map(tool => {
                const { features, readiness } = launchProgressRows(entries.filter(entry => entry.tool_key === tool.key));
                return <article className="tool-progress-card" key={tool.key} aria-labelledby={`overview-${tool.key}`}>
                  <h3 id={`overview-${tool.key}`}>
                    <button className="tool-link" onClick={() => navigate("overview", tool.key)}>
                      <Mark tone={tool.color}>{tool.short}</Mark><span>{tool.name}</span><span aria-hidden="true">↗</span>
                    </button>
                  </h3>
                  <LaunchProgress label={showSources ? "Planned features and builds" : "Planned features"} rows={features} />
                  <LaunchProgress label="Readiness preparation" rows={readiness} />
                </article>;
              })}
            </div>
          </section>}
          <section className="stats" aria-label="Tracking totals">
            <Stat title="Tracked features and metrics" value={catalog.length} detail={`${catalog.filter(entry => entry.kind === "feature").length} features · ${catalog.filter(entry => entry.kind === "metric").length} metrics`} onClick={() => navigate("catalog")} />
            <Stat title="Open feedback" value={feedback.length} detail="Pending" onClick={() => navigate("feedback")} />
            <Stat title="Logged test results" value={tests.length} detail={`${people.length} ${people.length === 1 ? "tester" : "testers"} · ${tests.filter(entry => entry.status === "Passed").length} passed`} onClick={() => navigate("test")} />
          </section>
          {(scope === "all" ? ["readiness"] : ["readiness", "punch"]).map(view =>
            <ReadinessPlan key={`${scope}-${view}`} entries={scoped} scope={scope} punchOnly={view === "punch"}
              managing={canManage} busy={loading || readinessBusy}
              onAdd={launchCategory => setDraft({ kind: "launch", tool: scope === "all" ? undefined : scope, launchCategory })}
              onEdit={copies => openEditor(copies[0])}
              onDelete={copies => confirmDeletion(copies, scope === "all" ? null : scope)}
              onCheck={(copies, checked) => copies.length === 1
                ? void saveStatus(copies[0], completionStatus(copies[0], checked))
                : void syncReadiness(copies, checked)}
              onMove={moveReadiness} onOpen={setFocused} pending={pendingChecks} />)}
          {scope !== "all" && <section className="section">
            <div className="section-head"><h2>Evaluation follow-up</h2><button className="secondary" onClick={() => navigate("catalog")}>View catalog</button></div>
            <EntryTable rows={catalog.filter(entry => ["Needs verification", "Data gap"].includes(entry.status))} visibleTool={false} onOpen={setFocused} items={itemById} />
          </section>}
          <section className="section">
            <div className="section-head"><h2>Recent testing</h2><button className="secondary" onClick={() => navigate("test")}>View usage tracker</button></div>
            {isAdmin && client ? <TestingActivity key={scope} db={client} scope={scope} compact
              onOpen={openTest} /> : <EntryTable rows={tests.slice(0, 5)}
              visibleTool={scope === "all"} onOpen={setFocused} items={itemById} empty="No test actions recorded yet." />}
          </section>
        </> : tab === "test" && isAdmin && client ? <section className="section">
          <div className="section-head"><h2>Usage tracker</h2></div>
          <TestingActivity key={scope} db={client} scope={scope} onOpen={openTest} />
        </section> : <section className="section">
          <div className="section-head"><div><h2>{currentTab?.name}</h2>
            {tab === "test" && <p className="muted">Test actions recorded by signed-in users.</p>}
            {tab === "catalog" && <p className="muted">Expand a tool to see its features, metrics, and metric sources.</p>}
            {tab === "feedback" && <p className="muted">Feedback from the migration spreadsheet and entries submitted here.</p>}
          </div><div className="actions">
            {tab === "feedback" && <>
              {showSources && <a className="secondary" href={feedbackSheetUrl} target="_blank" rel="noreferrer">Open feedback sheet ↗</a>}
              {canManage && <>
                <button className="secondary" disabled={syncing} onClick={() => void connectFeedbackSheet()}>
                  {syncing ? "Syncing…" : "Sync Google Sheet"}
                </button>
                <button className="secondary" disabled={syncing} onClick={() => void connectFeedbackSheet(true)}>
                  Connect Google Sheets editing
                </button>
              </>}
            </>}
            {tab === "catalog" ? canManage && <>
              <button className="secondary" onClick={() => setDraft({ kind: "feature" })}>Add feature</button>
              <button className="secondary" onClick={() => setDraft({ kind: "metric" })}>Add metric</button>
            </> : tab !== "test" && (tab !== "plan" || showSources) && <button className="primary" onClick={() => setDraft({ kind: tab })}>Add {labels[tab].toLowerCase()}</button>}
          </div></div>
          {tab === "feedback" && syncProblem && <p className="alert" role="alert">{syncProblem}</p>}
          <div className="filters">
            <input aria-label="Search entries" placeholder="Search entries" type="search" value={search} onChange={event => setSearch(event.target.value)} />
            {tab === "catalog" && <select aria-label="Entry type" value={kind} onChange={event => setKind(event.target.value)}><option value="">All types</option><option value="feature">Features</option><option value="metric">Metrics</option></select>}
            {tab !== "test" && <select aria-label="Status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statusOptions.map(value => <option key={value}>{value}</option>)}</select>}
            {tab === "test" && <>
              <select aria-label="Tester" value={tester} onChange={event => setTester(event.target.value)}><option value="">All testers</option>{people.map(person => <option key={person}>{person}</option>)}</select>
              <select aria-label="Environment" value={environment} onChange={event => setEnvironment(event.target.value)}><option value="">All environments</option><option>Preview</option><option>Production</option><option>Local</option></select>
            </>}
          </div>
          {tab === "catalog" || tab === "feedback" ? <ToolGroups key={`${tab}-${scope}`}
            scope={scope} tab={tab} rows={filtered} items={itemById} onOpen={setFocused} showSources={showSources}
            onEditFeedback={entry => { if (canEdit(entry)) openEditor(entry); }} canEditFeedback={canEdit}
            filterKind={kind} filtering={!!(query || kind || status)}
            catalogStatus={canManage ? { pending: pendingChecks, save: saveStatus } : undefined} />
            : <EntryTable rows={filtered} visibleTool={scope === "all"} onOpen={setFocused} items={itemById} usage={tab === "test"}
              empty={tabRows.length ? "No entries match these filters." : "No entries recorded yet."} />}
        </section>}
      </div>
    </main>
    {deletion && <Modal title="Delete checklist item" close={() => { if (!readinessBusy) setDeletion(null); }}>
      <div className="dialog-body">
        <p>Delete <strong>{deletion.entries[0].title}</strong> from {tools.filter(tool =>
          deletion.entries.some(entry => entry.tool_key === tool.key)).map(tool => tool.name).join(", ")}?</p>
        {deleteProblem && <p className="alert" role="alert">{deleteProblem}</p>}
      </div>
      <footer className="dialog-footer">
        <button className="secondary" disabled={readinessBusy} onClick={() => setDeletion(null)}>Cancel</button>
        <button className="primary danger" disabled={readinessBusy} onClick={() => void deleteReadiness()}>
          {readinessBusy ? "Deleting…" : "Delete checklist item"}
        </button>
      </footer>
    </Modal>}
    {focused && <EntryDetails showSources={showSources} entry={focused} parent={focused.parent_id ? itemById.get(focused.parent_id) : undefined}
      close={() => setFocused(null)} edit={canEdit(focused) ? () => openEditor(focused) : undefined}
      add={focused.kind !== "test" ? nextKind => { setDraft({ kind: nextKind, parent: focused }); setFocused(null); } : undefined}
    />}
    {draft?.entry?.feedback_sheet_tab ? <SheetFeedbackEditor entry={draft.entry}
      onClose={() => setDraft(null)} onSave={saveSheetFeedback} /> : draft && <Editor showSources={showSources} draft={draft} scope={scope} entries={entries} onClose={() => setDraft(null)} onSaved={onSaved}
      onFailure={tool => {
        if (draft.kind === "launch" && draft.entry) setRefresh(value => value + 1);
        logActivity(tool, activityPage, `Save ${labels[draft.kind].toLowerCase()}`, "Failed");
      }} />}
  </div>;
}

function Stat({ title, detail, value, onClick }: { title: string; detail: string; value: number; onClick: () => void }) {
  return <button className="stat" onClick={onClick}><span>{title}</span><strong>{value}</strong><small>{detail}</small></button>;
}

type CatalogStatus = { pending: string[]; save: (entry: Entry, status: string) => Promise<void> };

function ToolGroups({ scope, tab, rows, filterKind, filtering, items, onOpen, catalogStatus, showSources, onEditFeedback, canEditFeedback }: {
  scope: Scope; tab: "catalog" | "feedback"; rows: Entry[]; filterKind: string; filtering: boolean;
  items: Map<string, Entry>; onOpen: (entry: Entry) => void; catalogStatus?: CatalogStatus; showSources: boolean;
  onEditFeedback: (entry: Entry) => void; canEditFeedback: (entry: Entry) => boolean;
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
            ? <EntryTable rows={groupRows} visibleTool={false} variant="feedback" items={items} onOpen={onOpen} onEditFeedback={onEditFeedback} canEditFeedback={canEditFeedback}
                empty={filtering ? "No feedback matches these filters." : "No feedback recorded for this tool."} />
            : <>
              {filterKind !== "metric" && <section><h4>Features</h4>
                <EntryTable rows={features} visibleTool={false} catalogStatus={catalogStatus} items={items} onOpen={onOpen} empty="No matching features." />
              </section>}
              {filterKind !== "feature" && <section><h4>Metrics</h4>
                <EntryTable showSources={showSources} rows={metrics} visibleTool={false} variant="metric" catalogStatus={catalogStatus} items={items} onOpen={onOpen} empty="No matching metrics." />
              </section>}
            </>)}
        </div>
      </div>;
    })}
  </div>;
}

function EntryTable({ rows, visibleTool, usage, variant, items, onOpen, catalogStatus, showSources, onEditFeedback, canEditFeedback, empty = "No follow-up entries." }: {
  rows: Entry[]; visibleTool: boolean; usage?: boolean; variant?: "metric" | "feedback"; items: Map<string, Entry>; onOpen: (entry: Entry) => void; empty?: string; catalogStatus?: CatalogStatus; showSources?: boolean;
  onEditFeedback?: (entry: Entry) => void; canEditFeedback?: (entry: Entry) => boolean;
}) {
  const showTest = usage || rows[0]?.kind === "test";
  const showPlan = rows[0]?.kind === "plan";
  const showFeedbackActions = variant === "feedback" && rows.some(entry => canEditFeedback?.(entry));
  if (!rows.length) return <p className="empty">{empty}</p>;
  return <div className="table-wrap"><table>
    <thead><tr><th>{showTest ? "Action" : variant === "metric" ? "Metric" : variant === "feedback" ? "Feedback" : "Entry"}</th>{visibleTool && <th>Tool</th>}{!showTest && <th>Status</th>}
      {showTest ? <><th>Tester</th><th>Environment</th><th>Logged (ET)</th></> :
        showPlan ? <><th>Owner</th><th>Target date</th></> : variant === "feedback" ? <><th>Requested by</th><th>Notes</th><th>Response</th>{showFeedbackActions && <th>Actions</th>}</>
          : variant === "metric" ? <><th>Area</th><th>Metric source</th></> : <th>Area / type</th>}</tr></thead>
    <tbody>{rows.map(entry => <tr key={entry.id}>
      <td><button className="row-link" onClick={() => onOpen(entry)}>{entry.title}</button>
        {entry.parent_id && <small className="subline">{items.get(entry.parent_id)?.title}</small>}</td>
      {visibleTool && <td>{tools.find(tool => tool.key === entry.tool_key)?.name}</td>}
      {!showTest && <td>{catalogStatus && catalogKinds.has(entry.kind)
        ? <select className="catalog-status" aria-label={`Status for ${entry.title}`} value={entry.status} disabled={catalogStatus.pending.includes(entry.id)}
            onChange={event => void catalogStatus.save(entry,event.target.value)}>{statuses[entry.kind].map(value => <option key={value}>{value}</option>)}</select>
        : <Badge>{entry.status}</Badge>}</td>}
      {showTest ? <><td>{entry.actor_email ?? "—"}</td><td>{entry.environment}</td><td className="nowrap">{stamp.format(new Date(entry.created_at))}</td></>
        : showPlan ? <><td>{entry.owner ?? "—"}</td><td>{entry.due_date ? day.format(new Date(entry.due_date)) : "—"}</td></>
        : variant === "feedback" ? <><td>{entry.feedback_requester ?? entry.actor_email ?? "—"}</td><td className="feedback-notes">{entry.details || "—"}</td>
          <td className="feedback-notes">{entry.feedback_response || "—"}</td>{showFeedbackActions && <td>{canEditFeedback?.(entry) &&
          <button className="secondary" data-activity="Edit feedback" aria-label={`Edit ${entry.title}`} onClick={() => onEditFeedback?.(entry)}>Edit</button>}</td>}</> : variant === "metric" ? <><td>{entry.area ?? "—"}</td><td>
          <span>{entry.metric_source || "—"}</span>
          {showSources && validLink(entry.source_url) && <span className="subline"><a href={validLink(entry.source_url)!} target="_blank" rel="noreferrer">View source ↗</a></span>}
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

function EntryDetails({ entry, parent, close, edit, add, showSources }: {
  entry: Entry; parent?: Entry; showSources: boolean; close: () => void; edit?: () => void; add?: (kind: Kind) => void;
}) {
  const source = showSources && validLink(entry.source_url);
  const deployment = showSources && validLink(entry.deployment_url);
  return <Modal title={entry.title} close={close}>
    <div className="dialog-body">
      <div className="detail-meta">{tools.find(tool => tool.key === entry.tool_key)?.name} <Badge>{entry.status}</Badge></div>
      {entry.area && <p className="muted">{entry.area} · {labels[entry.kind]}</p>}
      <p className="details-copy">{entry.details || "No notes added."}</p>
      {entry.metric_source && <p><strong>Metric source</strong> {entry.metric_source}</p>}
      {entry.feedback_requester && <p><strong>Requested by</strong> {entry.feedback_requester}</p>}
      {entry.readiness_latest_status && <p className="details-copy"><strong>Latest status</strong> {entry.readiness_latest_status}</p>}
      {entry.feedback_response && <p className="details-copy"><strong>Response</strong> {entry.feedback_response}</p>}
      {entry.feedback_sheet_present === false && <p className="muted">This entry was removed from the source sheet.</p>}
      {parent && <p><strong>Related entry</strong> {parent.title}</p>}
      {entry.actor_email && <p><strong>{entry.kind === "test" ? "Tester" : "Submitted by"}</strong> {entry.actor_email}</p>}
      {entry.environment && <p><strong>Environment</strong> {entry.environment}</p>}
      {entry.owner && <p><strong>Owner</strong> {entry.owner}</p>}
      {entry.due_date && <p><strong>Target date</strong> {day.format(new Date(entry.due_date))}</p>}
      <p className="muted">{entry.kind === "test" ? "Logged" : "Last updated"} {stamp.format(new Date(entry.updated_at))} ET</p>
      <div className="actions">{deployment && <a href={deployment} target="_blank" rel="noreferrer">{entry.kind === "launch" ? "Open related link" : "Open deployment"} ↗</a>}
        {source && <a href={source} target="_blank" rel="noreferrer">{entry.feedback_sheet_tab ? "Open sheet row" : "Review source"} ↗</a>}</div>
    </div>
    {(edit || add) && <footer className="dialog-footer">
      {edit && <button className="secondary" onClick={edit}>Edit</button>}
      {add && <><button className="secondary" onClick={() => add("feedback")}>Add feedback</button>
        {showSources && <button className="secondary" onClick={() => add("plan")}>Add build plan</button>}
        <button className="primary" onClick={() => add("test")}>Log test</button></>}
    </footer>}
  </Modal>;
}

function Editor({ draft, scope, entries, onClose, onSaved, onFailure, showSources }: {
  draft: Draft; scope: Scope; entries: Entry[]; showSources: boolean; onClose: () => void; onSaved: (saved: Entry[]) => void; onFailure: (tool: Scope) => void;
}) {
  const { kind, entry, parent } = draft;
  const editChecklist = kind === "launch" && !!entry;
  const sharedEdit = editChecklist && scope === "all" && !draft.tool;
  const readinessCopies = editChecklist ? entries.filter(item => item.id === entry.id ||
    (entry.readiness_group && item.readiness_group === entry.readiness_group)) : [];
  const membership = useRef(readinessCopies);
  const bulkCreate = (catalogKinds.has(kind) || kind === "launch") && !entry && !parent && !draft.tool;
  const changedFields = useRef(new Set<string>());
  const initialTool = entry?.tool_key ?? parent?.tool_key ?? draft.tool ?? (scope === "all" ? null : scope);
  const [selectedTools, setSelectedTools] = useState<ToolKey[]>(membership.current.length
    ? membership.current.map(copy => copy.tool_key) : initialTool ? [initialTool] : []);
  const tool = selectedTools.length === 1 ? selectedTools[0] : "";
  const [related, setRelated] = useState(entry?.parent_id ?? parent?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const mixedStatus = sharedEdit && membership.current.some(copy => copy.status !== entry?.status);
  const mixedCategory = sharedEdit && membership.current.some(copy => copy.area !== entry?.area);
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
    if (!title || !selectedTools.length) { setProblem("Select at least one tool and enter a title."); return; }
    if ((deployment && !validLink(deployment)) || (source && !validLink(source))) {
      setProblem("Use a valid https:// link."); return;
    }
    const values = {
      title, details: read("details"), status: read("status"), parent_id: tool && related || null,
      area: read("area") || null, owner: read("owner") || null, due_date: read("due_date") || null,
      ...(showSources ? { deployment_url: deployment || null, source_url: source || null } : {}),
      ...(kind === "launch" ? { readiness_latest_status: read("readiness_latest_status") || null } : {}),
      ...(kind === "metric" ? { metric_source: read("metric_source") || null } : {})
    };
    setSaving(true);
    setProblem("");
    try {
      const changes = Object.fromEntries(Object.entries(values).filter(([field, value]) =>
        changedFields.current.has(field) && !((field === "area" || field === "status") && !value)
      ));
      const group = kind === "launch" && selectedTools.length > 1 ? crypto.randomUUID() : null;
      const edit = entry && !editChecklist ? client.from(table).update(values).eq("id", entry.id) : null;
      delete changes.source_url;
      const result = editChecklist
        ? await client.rpc("vercel_migration_tracker_save_checklist_item", {
          primary_id: entry.id,
          selected_tools: selectedTools,
          versions: Object.fromEntries(membership.current.map(copy => [copy.id, copy.updated_at])),
          changes,
          apply_to_group: sharedEdit || !selectedTools.includes(entry.tool_key)
        })
        : edit
          ? await edit.select()
          : await client.from(table).insert(selectedTools.map(tool_key => ({
            ...values, tool_key, kind, environment: read("environment") || null,
            ...(group ? { readiness_group: group } : {})
          }))).select();
      if (result.error || result.data.length === 0) throw result.error ?? new Error("No entries returned");
      onSaved(result.data as Entry[]);
    } catch {
      setProblem(editChecklist ? "The edit could not be saved. Close and reopen the item to edit the latest version."
        : "The save could not be confirmed. Check your access and try again.");
      onFailure(tool || "all");
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={entry ? `Edit ${labels[kind].toLowerCase()}` : kind === "test" ? "Log test action" : `Add ${labels[kind].toLowerCase()}`} close={() => { if (!saving) onClose(); }}>
    <form onSubmit={submit} onChange={event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        changedFields.current.add(event.target.name);
      }
    }}>
      <div className="dialog-body form">
        {problem && <p className="alert wide" role="alert">{problem}</p>}
        {(editChecklist || bulkCreate) ? <fieldset className="wide tool-picker">
          <legend>Tools</legend>
          {tools.map(item => <label key={item.key}>
            <input type="checkbox" checked={selectedTools.includes(item.key)} disabled={saving} onChange={event => {
              const checked = event.target.checked;
              setSelectedTools(current => checked ? [...current, item.key] : current.filter(value => value !== item.key));
              setRelated("");
            }} />
            {item.name}
          </label>)}
        </fieldset> : <label className="wide">Tool<select required value={tool} disabled={!!entry || !!parent || !!draft.tool || saving}
          onChange={event => {
            const selected = tools.find(item => item.key === event.target.value);
            setSelectedTools(selected ? [selected.key] : []);
            setRelated("");
          }}>
          <option value="">Select a tool</option>{tools.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>}
        {editChecklist && membership.current.some(copy => !selectedTools.includes(copy.tool_key)) &&
          <p className="muted wide">Saving removes this checklist item from the tools you deselected.</p>}
        <label className="wide">{kind === "test" ? "Action tested" : "Title"}<input name="title" required maxLength={160} defaultValue={entry?.title} /></label>
        <label>{kind === "test" ? "Outcome" : "Status"}<select name="status" defaultValue={mixedStatus ? "" : entry?.status ?? (catalogKinds.has(kind) ? "Needs verification" : statuses[kind][0])}>
          {mixedStatus && <option value="">Varies by tool</option>}{statuses[kind].map(value => <option key={value}>{value}</option>)}</select></label>
        {kind === "test" && <label>Environment<select name="environment"><option>Preview</option><option>Production</option><option>Local</option></select></label>}
        {catalogKinds.has(kind) && <label>Area<input name="area" maxLength={80} defaultValue={entry?.area ?? ""} /></label>}
        {kind === "launch" && <label>Category<select name="area" defaultValue={mixedCategory ? "" : entry?.area ?? draft.launchCategory ?? (scope === "all" && !draft.tool ? "Training" : "Punch list")}>
          {mixedCategory && <option value="">Varies by tool</option>}{launchCategories.map(category => <option key={category}>{category}</option>)}</select></label>}
        {(kind === "plan" || kind === "launch" || kind === "feature") && <>
          <label>Owner<input name="owner" maxLength={160} defaultValue={entry?.owner ?? ""} /></label>
          <label>Due date<input type="date" name="due_date" defaultValue={entry?.due_date ?? ""} /></label>
        </>}
        {(!editChecklist || tool === entry.tool_key) && <label className="wide">Related entry <select name="parent_id" value={related} disabled={!tool || saving} onChange={event => setRelated(event.target.value)}>
          <option value="">None</option>{relatedEntries.map(item => <option key={item.id} value={item.id}>{labels[item.kind]} · {item.title}</option>)}</select>
          {selectedTools.length > 1 && <small className="muted">Related entries are specific to one tool. You can link each copy after saving.</small>}
        </label>}
        {kind === "launch" && <label className="wide">Latest status
          <textarea name="readiness_latest_status" rows={2} maxLength={5000} defaultValue={entry?.readiness_latest_status ?? ""} />
        </label>}
        <label className="wide">{kind === "test" ? "Steps and observations" : kind === "plan" ? "Scope and acceptance criteria" : kind === "launch" || kind === "feedback" ? "Notes" : "Details"}
          <textarea name="details" rows={4} maxLength={5000} defaultValue={entry?.details} required={kind === "feedback" || kind === "plan"} /></label>
        {showSources && (kind === "test" || kind === "plan" || kind === "launch") && <label className="wide">{kind === "launch" ? "Related link" : "Deployment link"} <input name="deployment_url" type="url" maxLength={1000} placeholder="https://…" defaultValue={entry?.deployment_url ?? ""} /></label>}
        {kind === "metric" && <label className="wide">Metric source<input name="metric_source" maxLength={500} defaultValue={entry?.metric_source ?? ""} /></label>}
        {showSources && catalogKinds.has(kind) && <label className="wide">Source link <input name="source_url" type="url" maxLength={1000} placeholder="https://…" defaultValue={entry?.source_url ?? ""} /></label>}
      </div>
      <footer className="dialog-footer"><button className="secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving…" : selectedTools.length > 1 ? `Save to ${selectedTools.length} tools` : "Save"}</button></footer>
    </form>
  </Modal>;
}


function SheetFeedbackEditor({ entry, onClose, onSave }: {
  entry: Entry; onClose: () => void; onSave: (entry: Entry, status: string, notes: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const status = String(values.get("status"));
    const notes = String(values.get("notes") ?? "").trim();
    if (status === entry.status && notes === entry.details) { onClose(); return; }
    setSaving(true);
    setProblem("");
    try {
      await onSave(entry, status, notes);
    } catch (error) {
      setProblem(error instanceof SheetsAuthorizationError
        ? "Close this form and select Connect Google Sheets editing before saving feedback."
        : error instanceof Error ? error.message : "Feedback could not be saved.");
      setSaving(false);
    }
  }

  return <Modal title="Edit feedback" close={() => { if (!saving) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-body form">
        <p className="wide"><strong>{entry.title}</strong></p>
        {problem && <p className="alert wide" role="alert">{problem}</p>}
        <label className="wide">Status
          <select name="status" defaultValue={entry.status} disabled={saving}>
            {statuses.feedback.map(status => <option key={status}>{status}</option>)}
          </select>
        </label>
        <label className="wide">Notes
          <textarea name="notes" rows={5} maxLength={5000} defaultValue={entry.details} disabled={saving} />
        </label>
      </div>
      <footer className="dialog-footer">
        <button className="secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={saving}>{saving ? "Saving…" : "Save feedback"}</button>
      </footer>
    </form>
  </Modal>;
}
