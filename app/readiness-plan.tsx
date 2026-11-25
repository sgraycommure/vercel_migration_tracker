import { useRef, useState, type DragEvent, type MouseEvent } from "react";
import { day, punchListSummaryGroup, tools, type Entry, type Scope } from "./model";

type ReadinessItem = { key: string; entries: Entry[]; position: number; created: string };

export function readinessItems(entries: Entry[], scope: Scope): ReadinessItem[] {
  const groups = new Map<string, ReadinessItem>();
  for (const entry of entries) {
    if (entry.kind !== "launch" || (scope !== "all" && entry.tool_key !== scope)) continue;
    const key = scope === "all" ? entry.readiness_group ?? entry.id : entry.id;
    const position = (scope === "all" ? entry.readiness_overview_order : entry.readiness_tool_order) ?? Infinity;
    const group = groups.get(key);
    if (group) {
      group.entries.push(entry);
      group.position = Math.min(group.position, position);
      if (entry.created_at < group.created) group.created = entry.created_at;
    } else {
      groups.set(key, { key, entries: [entry], position, created: entry.created_at });
    }
  }
  return [...groups.values()].sort((a, b) => a.position - b.position || a.created.localeCompare(b.created) || a.key.localeCompare(b.key));
}

export default function ReadinessPlan({ entries, scope, managing, busy, pending, onAdd, onEdit, onDelete, onOpen, onCheck, onMove }: {
  entries: Entry[];
  scope: Scope;
  managing: boolean;
  busy: boolean;
  pending: string[];
  onAdd: () => void;
  onEdit: (entries: Entry[]) => void;
  onDelete: (entries: Entry[]) => void;
  onOpen: (entry: Entry) => void;
  onCheck: (entries: Entry[], checked: boolean) => void;
  onMove: (item: string, adjacent: string, placeAfter?: boolean) => Promise<boolean>;
}) {
  const items = readinessItems(entries, scope).filter(item => scope !== "all" ||
    item.key === punchListSummaryGroup || item.entries.some(entry => entry.area !== "Punch list"));
  const list = useRef<HTMLUListElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null);
  const canReorder = managing && !busy && pending.length === 0 && items.length > 1;

  function clearDrag() {
    setDraggedKey(null);
    setDropTarget(null);
  }

  function positionDrop(event: DragEvent<HTMLLIElement>, key: string) {
    if (!canReorder || !draggedKey) return null;
    event.preventDefault();
    const row = event.currentTarget.getBoundingClientRect();
    const after = event.clientY >= row.top + row.height / 2;
    const from = items.findIndex(item => item.key === draggedKey);
    const target = items.findIndex(item => item.key === key);
    return from === target || target + Number(after) - Number(from < target) === from
      ? null
      : { key, after };
  }

  async function move(event: MouseEvent<HTMLButtonElement>, key: string, adjacent: string, direction: number) {
    const restoreFocus = document.activeElement === event.currentTarget;
    if (!await onMove(key, adjacent, scope === "all" ? direction > 0 : undefined) || !restoreFocus) return;
    requestAnimationFrame(() => {
      const row = list.current?.querySelector(`[data-readiness-key="${key}"]`);
      const sameDirection = row?.querySelector<HTMLButtonElement>(`[data-move="${direction}"]:not(:disabled)`);
      const nextControl = sameDirection ?? row?.querySelector<HTMLButtonElement>("button[data-move]:not(:disabled)");
      nextControl?.focus();
    });
  }

  return <section className="section" aria-label={scope === "all" ? "Launch Readiness Plan" : "Readiness plan"}>
    <div className="section-head">
      <div>
        <h2>{scope === "all" ? "Launch Readiness Plan" : "Readiness plan"}</h2>
        {scope === "all" && <p className="muted">Edits apply to all tools listed on the item.</p>}
      </div>
      {managing && <button className="primary" disabled={busy} onClick={onAdd}>Add checklist item</button>}
    </div>
    {items.length > 0 && <div className="readiness-column-head" data-managing={managing}>
      <span>Checklist item</span><span>Latest status</span>
    </div>}
    {items.length ? <ul data-managing={managing} ref={list} className="launch-checklist readiness-list" aria-busy={busy}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
      }}>{items.map((item, index) => {
      const [entry] = item.entries;
      const saving = busy || item.entries.some(copy => pending.includes(copy.id));
      const count = item.entries.filter(copy => copy.status === "Complete").length;
      const complete = count === item.entries.length;
      const byTool = tools.filter(tool => item.entries.some(copy => copy.tool_key === tool.key));
      const common = (field: "title" | "area" | "owner" | "due_date") =>
        item.entries.every(copy => copy[field] === entry[field]) ? entry[field] : null;
      const title = common("title") ?? entry.title;
      const dueDate = common("due_date");
      const differentUpdates = item.entries.some(copy => copy.readiness_latest_status !== entry.readiness_latest_status);
      return <li key={item.key} data-readiness-key={item.key} data-dragging={draggedKey === item.key || undefined}
        data-drop={dropTarget?.key === item.key ? dropTarget.after ? "after" : "before" : undefined}
        onDragOver={event => {
          const target = positionDrop(event, item.key);
          if (draggedKey) event.dataTransfer.dropEffect = target ? "move" : "none";
          if (target?.key !== dropTarget?.key || target?.after !== dropTarget?.after) setDropTarget(target);
        }}
        onDrop={event => {
          const target = positionDrop(event, item.key);
          clearDrag();
          if (draggedKey && target) void onMove(draggedKey, target.key, target.after);
        }}>
        {managing && <span className="readiness-drag" aria-hidden="true" title="Drag to reorder" draggable={canReorder}
          data-activity="Drag readiness item"
          onDragStart={event => {
            if (!canReorder) { event.preventDefault(); return; }
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", "Readiness item");
            setDraggedKey(item.key);
          }} onDragEnd={clearDrag}>⠿</span>}
        <input type="checkbox" aria-label={`Mark ${title} ${complete ? "open" : "complete"}`}
          ref={input => { if (input) input.indeterminate = count > 0 && !complete; }}
          data-activity="Toggle readiness completion" checked={complete} disabled={!managing || saving}
          onChange={event => onCheck(item.entries, event.target.checked)} />
        <div className="launch-item">
          {item.entries.length === 1
            ? <button className="row-link" onClick={() => onOpen(entry)}>{title}</button>
            : <strong>{title}</strong>}
          <div className="launch-meta">
            <span>{common("area") ?? "Multiple categories"}</span>
            {common("owner") && <span>{common("owner")}</span>}
            {dueDate && <span>Due {day.format(new Date(dueDate))}</span>}
            {item.entries.length > 1 && <span>{count}/{item.entries.length} complete</span>}
          </div>
          {scope === "all" && <p className="muted readiness-tools">{byTool.map(tool => tool.name).join(" · ")}</p>}
          {entry.details && item.entries.every(copy => copy.details === entry.details) && <p>{entry.details}</p>}
          {item.entries.some(copy => copy.details !== entry.details) && <p className="muted">Notes vary by tool.</p>}
        </div>
        <div className="readiness-latest">
          {differentUpdates ? item.entries.filter(copy => copy.readiness_latest_status).map(copy =>
            <p key={copy.id}><strong>{tools.find(tool => tool.key === copy.tool_key)?.name}</strong> {copy.readiness_latest_status}</p>
          ) : entry.readiness_latest_status || "—"}
        </div>
        {managing && <div className="readiness-controls">
          {[-1, 1].map(direction => {
            const adjacent = items[index + direction];
            const label = direction === -1 ? "Move up" : "Move down";
            return <button key={direction} type="button" className="secondary readiness-move" data-move={direction}
              data-activity={label} aria-label={`${label}: ${title}`} title={label} disabled={!canReorder || !adjacent}
              onClick={event => { if (adjacent) void move(event, item.key, adjacent.key, direction); }}>
              {direction === -1 ? "↑" : "↓"}
            </button>;
          })}
          <button className="secondary" disabled={saving} data-activity="Edit readiness item"
            aria-label={`Edit ${title}`} onClick={() => onEdit(item.entries)}>Edit</button>
          <button className="secondary" disabled={saving} data-activity="Delete readiness item"
            aria-label={`Delete ${title}`} onClick={() => onDelete(item.entries)}>Delete</button>
        </div>}
      </li>;
    })}</ul> : <p className="empty">No readiness items yet.</p>}
  </section>;
}
