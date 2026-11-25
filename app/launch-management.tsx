import { useState } from "react";
import { day, launchCategories, tools, type Entry, type ToolKey } from "./model";

import { ReadinessCategoryFilter, readinessItems } from "./readiness-plan";

const wave: Record<ToolKey, number> = { launch: 1, px: 2, "customer-ops": 2, capacity: 3, efficiency: 3 };

export function completionStatus(entry: Entry, checked: boolean) {
  if (entry.kind === "launch") return checked ? "Complete" : "Open";
  if (entry.kind === "plan") return checked ? "Shipped" : "Planned";
  return checked ? "Implemented" : "Planned";
}

function completed(entry: Entry) {
  return entry.status === completionStatus(entry, true);
}

export function launchProgressRows(entries: Entry[]) {
  return {
    features: entries.filter(entry => (entry.kind === "feature" && entry.status !== "Removed") || entry.kind === "plan"),
    readiness: entries.filter(entry => entry.kind === "launch")
  };
}

export function LaunchProgress({ label, rows }: { label: string; rows: Entry[] }) {
  const done = rows.filter(completed).length;
  const percentage = rows.length ? Math.round(done * 100 / rows.length) : 0;
  return <div className="launch-progress">
    <div><strong>{label}</strong><span>{done} of {rows.length} complete</span></div>
    <progress aria-label={label} max={100} value={percentage} />
  </div>;
}

export default function LaunchManagement({ entries, managing, showBuildPlans, pending, onAdd, onEdit, onDelete, onCheck, onOpen }: {
  entries: Entry[];
  managing: boolean;
  showBuildPlans: boolean;
  pending: string[];
  onAdd: (tool: ToolKey, category?: string) => void;
  onEdit: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  onCheck: (entry: Entry, checked: boolean) => void;
  onOpen: (entry: Entry) => void;
}) {
  const [categoryFilter, setCategoryFilter] = useState("");
  const featureLabel = showBuildPlans ? "Planned features and builds" : "Planned features";

  function checklist(rows: Entry[]) {
    return <ul className="launch-checklist">{rows.map(entry => (
      <li key={entry.id}>
        <input type="checkbox" aria-label={`Mark ${entry.title} ${completed(entry) ? "open" : "complete"}`}
          data-activity="Toggle checklist item" checked={completed(entry)} disabled={!managing || pending.includes(entry.id)}
          onChange={event => onCheck(entry, event.target.checked)} />
        <div className="launch-item">
          <button className="row-link" data-activity="Open checklist details" onClick={() => onOpen(entry)}>{entry.title}</button>
          {entry.details && <p>{entry.details}</p>}
          {entry.readiness_latest_status && <p><strong>Latest status</strong> {entry.readiness_latest_status}</p>}
          <div className="launch-meta">
            <span>{entry.owner || "Unassigned"}</span>
            <span>{entry.due_date ? `Due ${day.format(new Date(entry.due_date))}` : "No due date"}</span>
            {entry.kind !== "launch" && <span>{entry.status}</span>}
          </div>
        </div>
        {managing && <div className="readiness-controls">
          <button className="secondary" data-activity="Edit checklist item" aria-label={`Edit ${entry.title}`}
            onClick={() => onEdit(entry)}>Edit</button>
          {entry.kind === "launch" && <button className="secondary" disabled={pending.includes(entry.id)}
            data-activity="Delete readiness item" aria-label={`Delete ${entry.title}`} onClick={() => onDelete(entry)}>Delete</button>}
        </div>}
      </li>
    ))}</ul>;
  }

  return <section className="section" aria-label="Launch management">
    <div className="section-head">
      <div><h2>Readiness by tool</h2><p className="muted">Completion uses the catalog and readiness checklist below.</p></div>
      <ReadinessCategoryFilter value={categoryFilter} onChange={setCategoryFilter} extraCategory={featureLabel} />
    </div>
    <div className="launch-tools">{[...tools].sort((a,b) => wave[a.key] - wave[b.key]).map(tool => {
      const scoped = entries.filter(entry => entry.tool_key === tool.key);
      const { features } = launchProgressRows(scoped);
      const readiness = readinessItems(scoped, tool.key).map(item => item.entries[0]);
      const openFeedback = scoped.filter(entry => entry.kind === "feedback" && entry.feedback_sheet_present !== false && entry.status === "Pending");
      const done = [...features, ...readiness].filter(completed).length;
      const total = features.length + readiness.length;
      const complete = total > 0 && done === total && openFeedback.length === 0;
      return <details className="launch-tool" key={tool.key}>
        <summary data-activity="Expand or collapse launch checklist"><strong>{tool.name}</strong><span>Wave {wave[tool.key]} · {done}/{total} complete</span>
          <span className="badge" data-status={complete ? "Passed" : "Planned"}>{complete ? "Checklist complete" : "In preparation"}</span>
        </summary>
        <div className="launch-tool-body">
          <div className="launch-progress-grid"><LaunchProgress label={featureLabel} rows={features} /><LaunchProgress label="Readiness preparation" rows={readiness} /></div>
          {managing && <div className="actions"><button className="primary" onClick={() => onAdd(tool.key, launchCategories.find(category => category === categoryFilter))}>Add checklist item</button></div>}
          {(!categoryFilter || categoryFilter === featureLabel) && <details className="launch-category" key={categoryFilter}
            open={categoryFilter === featureLabel || undefined}><summary data-activity={`Expand ${featureLabel.toLowerCase()}`}>{featureLabel} <small>{features.filter(completed).length}/{features.length}</small></summary>
            {features.length ? checklist(features) : <p className="empty">No {featureLabel.toLowerCase()}.</p>}
          </details>}
          {launchCategories.filter(category => !categoryFilter || category === categoryFilter).map(category => {
            const rows = readiness.filter(entry => entry.area === category);
            return <details className="launch-category" key={`${category}-${categoryFilter}`} open={categoryFilter === category || undefined}>
              <summary data-activity={`Expand ${category} checklist`}>{category} <small>{rows.filter(completed).length}/{rows.length}</small></summary>
              {rows.length ? checklist(rows) : <p className="empty">No checklist items in this category.</p>}
              {category === "Punch list" && openFeedback.length > 0 && <div className="launch-feedback">
                <strong>Open feedback</strong>
                <ul>{openFeedback.map(entry => <li key={entry.id}><button className="row-link" data-activity="Review open feedback" onClick={() => onOpen(entry)}>{entry.title}</button></li>)}</ul>
              </div>}
            </details>;
          })}
        </div>
      </details>;
    })}</div>
  </section>;
}
