// ReturnsKanban — read-only board view of RMAs grouped by status.
//
// Columns mirror the lifecycle order on the spec:
//   Draft → Approved → Awaiting warehouse # → Awaiting return →
//     Received → Completed
// Plus a single "Closed" column collapsing denied + cancelled (terminal,
// rarely needs eyes).
//
// No drag-and-drop. Status changes go through the action panel / state
// machine — the board just visualises the funnel and lets the operator
// click through to a row.

import { Link } from "@tanstack/react-router";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

type RmaStatus =
  | "draft"
  | "approved"
  | "awaiting_warehouse_number"
  | "sent_to_warehouse"
  | "received"
  | "completed"
  | "denied"
  | "cancelled";

type RmaReturnType = "damage" | "seasonal" | "non_seasonal";

export type ReturnsKanbanRow = {
  id: string;
  rmaNumber: string | null;
  customerId: string;
  customerDisplayName: string | null;
  returnType: RmaReturnType;
  status: RmaStatus;
  totalValue: string;
  createdAt: string;
  approvedAt: string | null;
  sentToWarehouseAt: string | null;
  trackingNumber: string | null;
};

const TYPE_LABELS: Record<RmaReturnType, string> = {
  damage: "Damage",
  seasonal: "Seasonal",
  non_seasonal: "Non-seasonal",
};

const TYPE_TONES: Record<RmaReturnType, "high" | "info" | "medium"> = {
  damage: "high",
  seasonal: "info",
  non_seasonal: "medium",
};

// Logical column → which DB statuses it contains. "closed" combines the two
// terminal-failure states so the board doesn't waste a column on each.
type ColumnKey =
  | "draft"
  | "approved"
  | "awaiting_warehouse_number"
  | "sent_to_warehouse"
  | "received"
  | "completed"
  | "closed";

const COLUMNS: Array<{
  key: ColumnKey;
  label: string;
  statuses: RmaStatus[];
  /** Subtle accent applied to the column header. */
  tone: "neutral" | "info" | "warning" | "success" | "danger";
}> = [
  { key: "draft", label: "Draft", statuses: ["draft"], tone: "neutral" },
  { key: "approved", label: "Approved", statuses: ["approved"], tone: "info" },
  {
    key: "awaiting_warehouse_number",
    label: "Awaiting WH #",
    statuses: ["awaiting_warehouse_number"],
    tone: "warning",
  },
  {
    key: "sent_to_warehouse",
    label: "Awaiting return",
    statuses: ["sent_to_warehouse"],
    tone: "warning",
  },
  { key: "received", label: "Received", statuses: ["received"], tone: "info" },
  {
    key: "completed",
    label: "Completed",
    statuses: ["completed"],
    tone: "success",
  },
  {
    key: "closed",
    label: "Closed",
    statuses: ["denied", "cancelled"],
    tone: "danger",
  },
];

const TONE_HEADER_CLASSES: Record<
  (typeof COLUMNS)[number]["tone"],
  string
> = {
  neutral: "border-default text-secondary",
  info: "border-accent-info/40 text-accent-info",
  warning: "border-accent-warning/40 text-accent-warning",
  success: "border-success/40 text-success",
  danger: "border-accent-danger/40 text-accent-danger",
};

// Days an RMA has sat at its current stage without forward progress. Anchor
// timestamp varies by status so the count reflects time-since-action, not
// time-since-creation. Returns 0 for non-stuckable statuses.
function stuckDays(r: {
  status: RmaStatus;
  sentToWarehouseAt: string | null;
  approvedAt: string | null;
  createdAt: string;
}): number {
  let anchor: string | null;
  switch (r.status) {
    case "sent_to_warehouse":
      anchor = r.sentToWarehouseAt ?? r.approvedAt;
      break;
    case "awaiting_warehouse_number":
    case "approved":
      anchor = r.approvedAt;
      break;
    case "draft":
      anchor = r.createdAt;
      break;
    default:
      return 0;
  }
  if (!anchor) return 0;
  const ms = Date.now() - new Date(anchor).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function ReturnsKanban({ rows }: { rows: ReturnsKanbanRow[] }) {
  // Group rows into columns. Statuses outside any column drop to "closed"
  // as a safety net, though the COLUMNS table covers all enum values.
  const byColumn: Record<ColumnKey, ReturnsKanbanRow[]> = {
    draft: [],
    approved: [],
    awaiting_warehouse_number: [],
    sent_to_warehouse: [],
    received: [],
    completed: [],
    closed: [],
  };
  for (const r of rows) {
    const col = COLUMNS.find((c) => c.statuses.includes(r.status))?.key;
    byColumn[col ?? "closed"].push(r);
  }
  // Sort each column by createdAt desc so newest sits at top.
  for (const k of Object.keys(byColumn) as ColumnKey[]) {
    byColumn[k].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
      {COLUMNS.map((col) => {
        const cards = byColumn[col.key];
        return (
          <div
            key={col.key}
            className="flex min-h-40 flex-col rounded-lg border border-default bg-subtle/40"
          >
            <div
              className={cn(
                "flex items-center justify-between gap-2 rounded-t-lg border-b px-2.5 py-1.5 text-xs",
                TONE_HEADER_CLASSES[col.tone],
              )}
            >
              <span className="font-semibold uppercase tracking-wide">
                {col.label}
              </span>
              <span className="rounded-full bg-base px-1.5 py-0.5 text-[10px] tabular-nums text-secondary">
                {cards.length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 p-1.5">
              {cards.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-muted">
                  None
                </p>
              ) : (
                cards.map((r) => <KanbanCard key={r.id} row={r} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({ row }: { row: ReturnsKanbanRow }) {
  const days = stuckDays(row);
  const stuckTone =
    days >= 14 ? "critical" : days >= 7 ? "high" : null;
  const total = Number(row.totalValue);

  return (
    <Link
      to="/returns/$rmaId"
      params={{ rmaId: row.id }}
      className="group flex flex-col gap-1 rounded-md border border-default bg-base px-2 py-1.5 text-xs transition-colors hover:border-accent-primary/40 hover:bg-elevated"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] font-medium text-primary group-hover:text-accent-primary">
          {row.rmaNumber ?? `Draft ${row.id.slice(0, 6)}…`}
        </span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            total > 0 ? "text-primary" : "text-muted",
          )}
        >
          ${total.toFixed(0)}
        </span>
      </div>
      <div className="truncate text-secondary">
        {row.customerDisplayName ?? (
          <span className="text-muted italic">unknown</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={TYPE_TONES[row.returnType]}>
          {TYPE_LABELS[row.returnType]}
        </Badge>
        {stuckTone && <Badge tone={stuckTone}>stuck {days}d</Badge>}
        {row.trackingNumber && row.status === "sent_to_warehouse" && (
          <Badge tone="info">tracked</Badge>
        )}
      </div>
    </Link>
  );
}
