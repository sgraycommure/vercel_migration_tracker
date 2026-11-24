import { useState } from "react";
import { statuses, tools, type Entry } from "./model";

export default function ReleaseTesting({ entries, managing, pending, onStatus, onOpen }: {
  entries: Entry[];
  managing: boolean;
  pending: string[];
  onStatus: (entry: Entry, status: string) => void;
  onOpen: (entry: Entry) => void;
}) {
  const [onlyOutstanding, setOnlyOutstanding] = useState(false);
  const catalog = new Map(entries.filter(entry => entry.kind === "feature" || entry.kind === "metric").map(entry => [entry.id, entry]));
  const tests = entries.filter(entry => entry.kind === "qa" && (!entry.parent_id || catalog.get(entry.parent_id)?.status !== "Removed"));

  return <section className="section" aria-label="Pre-release testing checklist">
    <div className="section-head">
      <div><h2>Pre-release testing checklist</h2><p className="muted">Verify workflows on the release candidate and reconcile metrics against their source.</p></div>
      <label className="inline-check"><input type="checkbox" checked={onlyOutstanding} onChange={event => setOnlyOutstanding(event.target.checked)} /> Outstanding only</label>
    </div>
    <div className="launch-tools">{tools.map(tool => {
      const cases = tests.filter(entry => entry.tool_key === tool.key);
      const passed = cases.filter(entry => entry.status === "Passed").length;
      const failed = cases.filter(entry => entry.status === "Failed").length;
      const blocked = cases.filter(entry => entry.status === "Blocked").length;
      const sections = ["Features", "Metrics", "Release checks"].map(name => ({
        name,
        items: cases.filter(entry => {
          const parent = entry.parent_id ? catalog.get(entry.parent_id) : undefined;
          return name === (parent?.kind === "feature" ? "Features" : parent?.kind === "metric" ? "Metrics" : "Release checks")
            && (!onlyOutstanding || entry.status !== "Passed");
        }).sort((a,b) => (a.area ?? "").localeCompare(b.area ?? "") || a.title.localeCompare(b.title))
      }));
      return <details className="launch-tool" key={tool.key}>
        <summary data-activity="Toggle release testing tool">
          <strong>{tool.name}</strong><span>{passed} of {cases.length} passed</span>
          {(failed > 0 || blocked > 0) && <span>{failed} failed · {blocked} blocked</span>}
        </summary>
        <div className="launch-tool-body">
          <div className="launch-progress"><progress aria-label={`${tool.name} testing progress`} max={Math.max(cases.length, 1)} value={passed} /></div>
          {sections.map(({ name, items }) => <details className="launch-category" key={name}>
            <summary data-activity={`Toggle release testing ${name}`}>{name} <small>{items.length}</small></summary>
            {items.length ? <ul className="launch-checklist">{items.map(entry => {
              const subject = entry.parent_id ? catalog.get(entry.parent_id) : undefined;
              const title = subject?.title ?? entry.title;
              const saving = pending.includes(entry.id);
              return <li key={entry.id}>
                <input type="checkbox" aria-label={`Pass ${title}`} data-activity="Toggle release test passed" checked={entry.status === "Passed"}
                  disabled={!managing || saving} onChange={event => onStatus(entry,event.target.checked ? "Passed" : "Open")} />
                <div className="launch-item">
                  {subject ? <button className="row-link" onClick={() => onOpen(subject)}>{title}</button> : <strong>{title}</strong>}
                  {entry.area && <small className="subline">{entry.area}</small>}
                  <p>{subject?.details ?? entry.details}</p>
                </div>
                {managing ? <select aria-label={`Result for ${title}`} disabled={saving} value={entry.status}
                  onChange={event => onStatus(entry,event.target.value)}>{statuses.qa.map(status => <option key={status}>{status}</option>)}</select>
                  : <span className="badge" data-status={entry.status}>{entry.status}</span>}
              </li>;
            })}</ul> : <p className="empty">No matching test cases.</p>}
          </details>)}
        </div>
      </details>;
    })}</div>
  </section>;
}
