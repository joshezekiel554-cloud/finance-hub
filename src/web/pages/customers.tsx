import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Search, AlertCircle, Pause } from "lucide-react";
import { useEffect } from "react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/cn";

type CustomerType = "b2b" | "b2c" | null;

type CustomerRow = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  balance: string;
  overdueBalance: string;
  holdStatus: "active" | "hold";
  customerType: CustomerType;
  paymentTerms: string | null;
  lastSyncedAt: string | null;
  daysOverdue: number | null;
  lastPaymentAt: string | null;
  lastStatementSentAt: string | null;
};

type ListResponse = {
  rows: CustomerRow[];
  hasMore: boolean;
  totals: { b2b: number; b2c: number; uncategorized: number; all: number };
};

type FilterTab = "b2b" | "b2c" | "uncategorized" | "all";
type SortKey = "displayName" | "balance" | "overdueBalance" | "lastSyncedAt";

const TAB_LABELS: Record<FilterTab, string> = {
  b2b: "B2B",
  b2c: "B2C",
  uncategorized: "Uncategorized",
  all: "All",
};

export default function CustomersPage() {
  const [tab, setTab] = useState<FilterTab>("b2b");
  const [search, setSearch] = useState("");
  // Default sort surfaces customers with money on the line first — most
  // operator visits to this page are about action, not the alphabet.
  // Click the Customer column header once to flip back to A→Z.
  const [sort, setSort] = useState<SortKey>("balance");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [sweepMode, setSweepMode] = useState(false);
  // Filter chips. hideZero defaults ON for B2B (most chase-relevant view)
  // and OFF for everything else (Uncategorized has many $0 rows that ARE
  // the workflow). The effect below flips it on tab switches.
  const [hideZero, setHideZero] = useState(true);
  const [hasOverdueFilter, setHasOverdueFilter] = useState(false);
  const [onHoldFilter, setOnHoldFilter] = useState(false);
  const [missingTermsFilter, setMissingTermsFilter] = useState(false);
  useEffect(() => {
    setHideZero(tab === "b2b");
  }, [tab]);
  // Selected gmailIds in sweep mode. When the user toggles "Select all
  // (balance > 0)" we pre-fill with the matching ids; individual checkbox
  // clicks add/remove from this set.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const queryClient = useQueryClient();

  const queryKey = [
    "customers",
    {
      tab,
      search,
      sort,
      dir,
      hideZero,
      hasOverdueFilter,
      onHoldFilter,
      missingTermsFilter,
    },
  ] as const;
  const { data, isPending, isError, error } = useQuery<ListResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        customerType: tab,
        sort,
        dir,
        // 5000 covers the full customer table (~2,400 today) so the
        // sweep + filter chips operate on the complete dataset rather
        // than the first page. Backend caps at 5000 in the route schema.
        limit: "5000",
      });
      if (search.trim()) params.set("q", search.trim());
      if (hideZero) params.set("hideZeroBalance", "true");
      if (hasOverdueFilter) params.set("hasOverdue", "true");
      if (onHoldFilter) params.set("holdStatus", "hold");
      if (missingTermsFilter) params.set("missingTerms", "true");
      const res = await fetch(`/api/customers?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const bulkTagMutation = useMutation({
    mutationFn: async (input: {
      ids: string[];
      customerType: "b2b" | "b2c";
    }) => {
      const res = await fetch("/api/customers/bulk-tag", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ updated: number; total: number }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setSelectedIds(new Set());
      setSweepMode(false);
    },
  });

  // Shopify-tag import. Two-step: preview fetches Shopify customers
  // matching the tag, returns matched-by-email ids; user confirms; then
  // we fan out via bulkTagMutation. The preview state holds the result
  // between those two clicks.
  const [shopifyTag, setShopifyTag] = useState("b2b");
  const [shopifyPreview, setShopifyPreview] = useState<{
    tag: string;
    fetched: number;
    matchedIds: string[];
    sampleNames: string[];
  } | null>(null);
  const previewMutation = useMutation({
    mutationFn: async (tag: string) => {
      const res = await fetch("/api/customers/import-shopify-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        tag: string;
        fetched: number;
        matchedIds: string[];
        sampleNames: string[];
      }>;
    },
    onSuccess: (data) => setShopifyPreview(data),
  });

  const visibleRows = data?.rows ?? [];

  // Twin heuristics for the bulk-tag sweep:
  //   balance > 0 → likely B2B (have an outstanding statement balance)
  //   balance = 0 → likely B2C (paid-at-checkout via Shopify, no AR)
  // Either selector can be flipped to "Clear selection" when fully selected.
  const balancePositiveIds = useMemo(
    () => visibleRows.filter((r) => Number(r.balance) > 0).map((r) => r.id),
    [visibleRows],
  );
  const balanceZeroIds = useMemo(
    () => visibleRows.filter((r) => Number(r.balance) === 0).map((r) => r.id),
    [visibleRows],
  );

  function toggleSelectAllBalancePositive() {
    if (
      balancePositiveIds.length > 0 &&
      balancePositiveIds.every((id) => selectedIds.has(id))
    ) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(balancePositiveIds));
    }
  }

  function toggleSelectAllBalanceZero() {
    if (
      balanceZeroIds.length > 0 &&
      balanceZeroIds.every((id) => selectedIds.has(id))
    ) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(balanceZeroIds));
    }
  }

  function toggleId(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-secondary">
            All customers from QuickBooks. Filter by type or search by name.
          </p>
        </div>
      </div>

      {data && data.totals.uncategorized > 0 && tab !== "uncategorized" && (
        <Card>
          <CardBody className="flex items-center justify-between gap-4 py-3">
            <div className="flex items-start gap-2 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-accent-warning" />
              <div>
                <span className="font-medium">
                  {data.totals.uncategorized} customer
                  {data.totals.uncategorized === 1 ? "" : "s"} need classification.
                </span>{" "}
                <span className="text-secondary">
                  Switch to the Uncategorized tab and run the bulk-tag sweep —
                  the "Select all" checkbox auto-includes only customers with a
                  balance.
                </span>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setTab("uncategorized");
                setSweepMode(true);
              }}
            >
              Review now
            </Button>
          </CardBody>
        </Card>
      )}

      {tab === "uncategorized" && (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <span className="text-secondary">
              Or import B2B from a Shopify customer tag:
            </span>
            <Input
              value={shopifyTag}
              onChange={(e) => setShopifyTag(e.target.value)}
              placeholder="b2b"
              className="!w-32"
              aria-label="Shopify tag to import"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => previewMutation.mutate(shopifyTag.trim() || "b2b")}
              disabled={previewMutation.isPending}
            >
              {previewMutation.isPending ? "Searching…" : "Find matches"}
            </Button>
            {previewMutation.isError && (
              <span className="text-accent-danger">
                {(previewMutation.error as Error)?.message ?? "Lookup failed"}
              </span>
            )}
          </CardBody>
        </Card>
      )}

      {shopifyPreview && (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <div className="flex-1">
              <div className="font-medium">
                Found {shopifyPreview.fetched} Shopify customer
                {shopifyPreview.fetched === 1 ? "" : "s"} tagged "
                {shopifyPreview.tag}". {shopifyPreview.matchedIds.length} matched
                to your customers by email.
              </div>
              {shopifyPreview.sampleNames.length > 0 && (
                <div className="mt-1 text-xs text-muted">
                  Sample: {shopifyPreview.sampleNames.slice(0, 5).join(", ")}
                  {shopifyPreview.matchedIds.length >
                    shopifyPreview.sampleNames.length && " …"}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShopifyPreview(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={
                shopifyPreview.matchedIds.length === 0 ||
                bulkTagMutation.isPending
              }
              onClick={() => {
                bulkTagMutation.mutate({
                  ids: shopifyPreview.matchedIds,
                  customerType: "b2b",
                });
                setShopifyPreview(null);
              }}
            >
              Mark {shopifyPreview.matchedIds.length} as B2B
            </Button>
          </CardBody>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-default bg-subtle p-0.5 text-sm">
          {(["b2b", "uncategorized", "b2c", "all"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(t);
                  setSelectedIds(new Set());
                }}
                className={cn(
                  "rounded px-3 py-1 transition-colors",
                  tab === t
                    ? "bg-base font-medium text-primary shadow-sm"
                    : "text-secondary hover:text-primary",
                )}
              >
                {TAB_LABELS[t]} ({data?.totals[t] ?? 0})
              </button>
            ))}
        </div>

        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            className="!pl-8"
            aria-label="Search customers"
          />
        </div>

        {tab === "uncategorized" && (
          <Button
            variant={sweepMode ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setSweepMode((v) => !v);
              setSelectedIds(new Set());
            }}
          >
            {sweepMode ? "Exit sweep" : "Bulk-tag sweep"}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Filters:</span>
        <FilterChip
          label="Hide $0"
          active={hideZero}
          onClick={() => setHideZero((v) => !v)}
        />
        <FilterChip
          label="Has overdue"
          active={hasOverdueFilter}
          onClick={() => setHasOverdueFilter((v) => !v)}
        />
        <FilterChip
          label="On hold"
          active={onHoldFilter}
          onClick={() => setOnHoldFilter((v) => !v)}
        />
        <FilterChip
          label="No terms set"
          active={missingTermsFilter}
          onClick={() => setMissingTermsFilter((v) => !v)}
        />
        {(hideZero || hasOverdueFilter || onHoldFilter || missingTermsFilter) ? (
          <button
            type="button"
            onClick={() => {
              setHideZero(false);
              setHasOverdueFilter(false);
              setOnHoldFilter(false);
              setMissingTermsFilter(false);
            }}
            className="ml-1 text-muted hover:text-primary"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {sweepMode && (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <span className="text-secondary">
              {selectedIds.size} of {visibleRows.length} selected
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={toggleSelectAllBalancePositive}
            >
              {balancePositiveIds.every((id) => selectedIds.has(id)) &&
              balancePositiveIds.length > 0
                ? "Clear selection"
                : `Select all balance > 0 (${balancePositiveIds.length})`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={toggleSelectAllBalanceZero}
            >
              {balanceZeroIds.every((id) => selectedIds.has(id)) &&
              balanceZeroIds.length > 0
                ? "Clear selection"
                : `Select all balance = 0 (${balanceZeroIds.length})`}
            </Button>
            <div className="ml-auto flex gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={selectedIds.size === 0 || bulkTagMutation.isPending}
                onClick={() =>
                  bulkTagMutation.mutate({
                    ids: Array.from(selectedIds),
                    customerType: "b2b",
                  })
                }
              >
                Mark as B2B
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={selectedIds.size === 0 || bulkTagMutation.isPending}
                onClick={() =>
                  bulkTagMutation.mutate({
                    ids: Array.from(selectedIds),
                    customerType: "b2c",
                  })
                }
              >
                Mark as B2C
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-secondary">
              {isPending
                ? "Loading…"
                : `${visibleRows.length}${data?.hasMore ? "+" : ""} customers`}
            </h2>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {isError && (
            <div className="p-4 text-sm text-accent-danger">
              {(error as Error)?.message ?? "Failed to load customers"}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                {sweepMode && <th className="w-10 px-3 py-2"></th>}
                <SortableTh
                  label="Customer"
                  active={sort === "displayName"}
                  dir={dir}
                  onClick={() => toggleSort("displayName", sort, setSort, dir, setDir)}
                />
                <th className="px-3 py-2">Email</th>
                <SortableTh
                  label="Balance"
                  active={sort === "balance"}
                  dir={dir}
                  onClick={() => toggleSort("balance", sort, setSort, dir, setDir)}
                  align="right"
                />
                <SortableTh
                  label="Overdue"
                  active={sort === "overdueBalance"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("overdueBalance", sort, setSort, dir, setDir)
                  }
                  align="right"
                />
                <th className="px-3 py-2 text-right">Days</th>
                <th className="px-3 py-2">Last payment</th>
                <th className="px-3 py-2">Last statement</th>
                <th className="px-3 py-2">Terms</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const balance = Number(row.balance);
                const overdue = Number(row.overdueBalance);
                const checked = selectedIds.has(row.id);
                const onHold = row.holdStatus === "hold";
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      "border-b border-default last:border-b-0",
                      onHold
                        ? "bg-accent-danger/10 hover:bg-accent-danger/15"
                        : "hover:bg-elevated",
                    )}
                  >
                    {sweepMode && (
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleId(row.id)}
                          className="size-4 rounded border-default"
                          aria-label={`Select ${row.displayName}`}
                        />
                      </td>
                    )}
                    <td className="px-3 py-2 font-medium">
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: row.id }}
                        className="hover:text-accent-primary hover:underline underline-offset-2"
                      >
                        {row.displayName}
                      </Link>
                    </td>
                    <td
                      className="px-3 py-2 text-secondary"
                      title={row.primaryEmail ?? undefined}
                    >
                      {emailLocalPart(row.primaryEmail)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {balance > 0 ? (
                        <span className="font-medium">${balance.toFixed(2)}</span>
                      ) : (
                        <span className="text-muted">$0.00</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {overdue > 0 ? (
                        <span className="font-medium text-accent-warning">
                          ${overdue.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.daysOverdue !== null && row.daysOverdue > 0 ? (
                        <span className="text-accent-warning">
                          {row.daysOverdue}d
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {relativeShortDate(row.lastPaymentAt)}
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {relativeShortDate(row.lastStatementSentAt)}
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {row.paymentTerms ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {onHold ? (
                        <Badge tone="critical">
                          <Pause className="mr-1 size-3" />
                          Hold
                        </Badge>
                      ) : (
                        <Badge tone="success">Active</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!isPending && visibleRows.length === 0 && (
                <tr>
                  <td
                    className="p-8 text-center text-sm text-muted"
                    colSpan={sweepMode ? 10 : 9}
                  >
                    No customers match.
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

function CustomerTypeBadge({ type }: { type: CustomerType }) {
  if (type === "b2b") return <Badge tone="info">B2B</Badge>;
  if (type === "b2c") return <Badge tone="neutral">B2C</Badge>;
  return <Badge tone="medium">Untagged</Badge>;
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

// First chunk before "@" (or full address if there's no @). Used so the
// table stays scannable; full email available on hover via title.
function emailLocalPart(email: string | null): string {
  if (!email) return "—";
  const at = email.indexOf("@");
  return at < 0 ? email : email.slice(0, at);
}

// "3d ago" / "2w ago" / "1 May" — short by design. Anything within 24h
// shows hours; up to 14 days shows days; up to ~6 weeks shows weeks;
// beyond that, "DD Mon" with year added when older than this year.
function relativeShortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes < 1 ? "now" : `${minutes}m`}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks <= 6) return `${weeks}w ago`;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "cursor-pointer select-none px-3 py-2 hover:text-primary",
        align === "right" && "text-right",
      )}
    >
      {label}
      {active && <span className="ml-1">{dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}

function toggleSort(
  col: SortKey,
  current: SortKey,
  setSort: (s: SortKey) => void,
  currentDir: "asc" | "desc",
  setDir: (d: "asc" | "desc") => void,
): void {
  if (current === col) {
    setDir(currentDir === "asc" ? "desc" : "asc");
  } else {
    setSort(col);
    setDir(col === "balance" || col === "overdueBalance" ? "desc" : "asc");
  }
}
