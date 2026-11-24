export const tools = [
  { key: "px", name: "PX Dashboard", short: "PX", color: "plum", repo: "px-dashboard-f8tt" },
  { key: "customer-ops", name: "Customer Operations Workspace", short: "CO", color: "cyan", repo: "cs-hub" },
  { key: "launch", name: "Enterprise Launch Tracker", short: "LT", color: "blue", repo: "enterprise-launch-tracker" },
  { key: "efficiency", name: "Enterprise Efficiency Log", short: "EL", color: "amber", repo: "enterprise-efficiency-log" },
  { key: "capacity", name: "Enterprise Capacity Management", short: "CM", color: "green", repo: "enterprise-capacity-management" }
] as const;

export type ToolKey = (typeof tools)[number]["key"];
export type Kind = "tool" | "feature" | "metric" | "feedback" | "plan" | "test";
export type Tab = "overview" | "catalog" | "feedback" | "plan" | "test";

const catalogStatuses = ["Implemented", "Needs verification", "Data gap", "Removed", "Planned"];
export const statuses: Record<Kind, string[]> = {
  tool: catalogStatuses, feature: catalogStatuses, metric: catalogStatuses,
  feedback: ["New", "Triaged", "Resolved"],
  plan: ["Backlog", "Planned", "In progress", "Ready for testing", "Shipped"],
  test: ["Started", "Passed", "Failed", "Blocked"]
};

export const labels: Record<Kind, string> = {
  tool: "Tool", feature: "Feature", metric: "Metric", feedback: "Feedback",
  plan: "Build plan", test: "Test action"
};

export type Entry = {
  id: string;
  tool_key: ToolKey;
  kind: Kind;
  title: string;
  area: string | null;
  details: string;
  status: string;
  owner: string | null;
  due_date: string | null;
  environment: string | null;
  deployment_url: string | null;
  source_url: string | null;
  parent_id: string | null;
  created_by: string | null;
  actor_email: string | null;
  created_at: string;
  updated_at: string;
};

export const stamp = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
export const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
export const catalogKinds = new Set<Kind>(["feature", "metric"]);
export const table = "vercel_migration_tracker";

export function validLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
