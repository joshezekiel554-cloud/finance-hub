import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
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

type RmaRow = {
  id: string;
  rmaNumber: string | null;
  customerId: string;
  returnType: RmaReturnType;
  status: RmaStatus;
  totalValue: string;
  createdAt: string;
};

type ListResponse = { rmas: RmaRow[] };

const STATUS_LABELS: Record<RmaStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting warehouse #",
  sent_to_warehouse: "At warehouse",
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
            placeholder="Search RMA # or notes…"
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
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Created</th>
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
                </tr>
              ))}
              {!isPending && rows.length === 0 && (
                <tr>
                  <td
                    className="p-8 text-center text-sm text-muted"
                    colSpan={5}
                  >
                    No RMAs match the current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
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
