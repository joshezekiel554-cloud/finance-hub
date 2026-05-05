import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, List as ListIcon, Search } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { cn } from "../lib/cn";
import RmaRowMenu from "../components/rma-row-menu";
import { ReturnsKanban } from "../components/returns-kanban";

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

type RmaRow = {
  id: string;
  rmaNumber: string | null;
  customerId: string;
  customerDisplayName: string | null;
  returnType: RmaReturnType;
  status: RmaStatus;
  totalValue: string;
  createdAt: string;
  // Used by Kanban cards for the stuck-days badge.
  approvedAt: string | null;
  sentToWarehouseAt: string | null;
  trackingNumber: string | null;
};

type View = "list" | "kanban";
const VIEW_STORAGE_KEY = "returns-view";

type ListResponse = { rmas: RmaRow[] };

const STATUS_LABELS: Record<RmaStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting warehouse #",
  sent_to_warehouse: "Awaiting return",
  received: "Received",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
};

// Maps RMA status to Badge tone tokens used elsewhere in the app.
// "critical" = danger red, "high" = warning amber, "success" = green,
// "info" = blue, "neutral" = grey — matching the design token vocabulary.
type BadgeTone = "critical" | "high" | "medium" | "low" | "neutral" | "info" | "success";

const STATUS_TONES: Record<RmaStatus, BadgeTone> = {
  draft: "neutral",
  approved: "success",
  awaiting_warehouse_number: "high",
  sent_to_warehouse: "info",
  received: "info",
  completed: "success",
  denied: "critical",
  cancelled: "neutral",
};

const TYPE_LABELS: Record<RmaReturnType, string> = {
  damage: "Damage",
  seasonal: "Seasonal",
  non_seasonal: "Non-seasonal",
};

export default function ReturnsListPage() {
  const [statusFilter, setStatusFilter] = useState<RmaStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<RmaReturnType | "all">("all");
  const [search, setSearch] = useState("");
  // View preference is sticky across reloads — operators tend to favour
  // either list or board; switching every visit is friction.
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "list";
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return stored === "kanban" ? "kanban" : "list";
  });
  useEffect(() => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  const queryKey = ["rmas", { statusFilter, typeFilter, search }] as const;
  const { data, isPending, isError, error } = useQuery<ListResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (search.trim()) params.set("q", search.trim());
      const res = await fetch(`/api/rmas?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = useMemo(() => data?.rmas ?? [], [data]);

  const anyFilterActive = statusFilter !== "all" || typeFilter !== "all";

  function clearFilters() {
    setStatusFilter("all");
    setTypeFilter("all");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Returns</h1>
          <p className="mt-1 text-sm text-secondary">
            All return / RMA requests. Filter by status or type, or search by
            RMA number.
          </p>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </div>

      {/* Filter row — status chips + type chips + search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Status:</span>
          <FilterChip
            label="All"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          {(Object.keys(STATUS_LABELS) as RmaStatus[]).map((s) => (
            <FilterChip
              key={s}
              label={STATUS_LABELS[s]}
              active={statusFilter === s}
              onClick={() =>
                setStatusFilter((prev) => (prev === s ? "all" : s))
              }
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Type:</span>
          <FilterChip
            label="All"
            active={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
          />
          {(Object.keys(TYPE_LABELS) as RmaReturnType[]).map((t) => (
            <FilterChip
              key={t}
              label={TYPE_LABELS[t]}
              active={typeFilter === t}
              onClick={() =>
                setTypeFilter((prev) => (prev === t ? "all" : t))
              }
            />
          ))}
        </div>

        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search RMA #, customer, or notes…"
            className="!pl-8"
            aria-label="Search returns"
          />
        </div>

        {anyFilterActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs text-muted hover:text-primary"
          >
            Clear filters
          </button>
        )}
      </div>

      {view === "kanban" && (
        <>
          <div className="text-xs text-muted">
            {isPending
              ? "Loading…"
              : `${rows.length} RMA${rows.length === 1 ? "" : "s"}`}
          </div>
          {isError && (
            <div className="rounded-md border border-accent-danger/30 bg-accent-danger/10 p-3 text-sm text-accent-danger">
              {(error as Error)?.message ?? "Failed to load returns"}
            </div>
          )}
          {!isPending && !isError && <ReturnsKanban rows={rows} />}
        </>
      )}

      {view === "list" && (
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-secondary">
            {isPending ? "Loading…" : `${rows.length} RMA${rows.length === 1 ? "" : "s"}`}
          </h2>
        </CardHeader>
        <CardBody className="p-0">
          {isError && (
            <div className="p-4 text-sm text-accent-danger">
              {(error as Error)?.message ?? "Failed to load returns"}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">RMA #</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-default last:border-b-0 hover:bg-elevated"
                >
                  <td className="px-3 py-2 font-medium">
                    <Link
                      to="/returns/$rmaId"
                      params={{ rmaId: r.id }}
                      className="font-mono text-xs hover:text-accent-primary hover:underline underline-offset-2"
                    >
                      {r.rmaNumber ?? `Draft ${r.id.slice(0, 6)}…`}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to="/customers/$customerId"
                      params={{ customerId: r.customerId }}
                      className="hover:text-accent-primary hover:underline underline-offset-2"
                    >
                      {r.customerDisplayName ?? (
                        <span className="text-muted italic">unknown</span>
                      )}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-secondary">
                    {TYPE_LABELS[r.returnType]}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONES[r.status]}>
                      {STATUS_LABELS[r.status]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span
                      className={cn(
                        "font-medium",
                        Number(r.totalValue) > 0
                          ? "text-primary"
                          : "text-muted",
                      )}
                    >
                      ${Number(r.totalValue).toFixed(2)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-secondary">
                    {new Date(r.createdAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <RmaRowMenu
                      rmaId={r.id}
                      status={r.status}
                      invalidateKeys={[["returns-list"], ["rmas"]]}
                    />
                  </td>
                </tr>
              ))}
              {!isPending && rows.length === 0 && (
                <tr>
                  <td
                    className="p-8 text-center text-sm text-muted"
                    colSpan={7}
                  >
                    No RMAs match the current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
      )}
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-default bg-subtle p-0.5 text-sm">
      <button
        type="button"
        onClick={() => onChange("kanban")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          view === "kanban"
            ? "bg-base font-medium text-primary shadow-sm"
            : "text-secondary hover:text-primary",
        )}
      >
        <LayoutGrid className="size-3.5" />
        Kanban
      </button>
      <button
        type="button"
        onClick={() => onChange("list")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          view === "list"
            ? "bg-base font-medium text-primary shadow-sm"
            : "text-secondary hover:text-primary",
        )}
      >
        <ListIcon className="size-3.5" />
        List
      </button>
    </div>
  );
}


function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 transition-colors",
        active
          ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
          : "border-default text-secondary hover:bg-elevated hover:text-primary",
      )}
    >
      {label}
    </button>
  );
}
