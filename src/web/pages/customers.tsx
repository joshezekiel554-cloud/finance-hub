import { useMemo, useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Search, AlertCircle, Pause, Plus } from "lucide-react";
import { useFilterNavigate } from "../lib/use-filter-navigate";
import { useFilterPersistence } from "../lib/use-filter-persistence";
import {
  type CustomersSearch,
} from "../lib/search-schemas/customers";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/cn";
import { SyncQbBadge } from "../components/sync-qb-badge";
import { CustomerRowMobile } from "../components/customer-row-mobile";
import {
  StickyActionBar,
  StickyActionBarSpacer,
} from "../components/sticky-action-bar";
import {
  TaskDetailDrawer,
  type DrawerMode as TaskDrawerMode,
} from "../components/task-detail-drawer";
import { effectiveOverdue } from "../../modules/customer-balance/effective-overdue";

const customersRouteApi = getRouteApi("/customers");

type CustomerType = "b2b" | "b2c" | null;

type HoldStatus = "active" | "hold" | "payment_upfront";

type CustomerRow = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  phone: string | null;
  balance: string;
  overdueBalance: string;
  unappliedCreditBalance: string;
  holdStatus: HoldStatus;
  agentModeExcluded: boolean;
  customerType: CustomerType;
  paymentTerms: string | null;
  lastSyncedAt: string | null;
  daysOverdue: number | null;
  lastPaymentAt: string | null;
  lastStatementSentAt: string | null;
  lastContactedAt: string | null;
  unactionedEmailCount: number;
  hasPendingRma: boolean;
  tags: string[] | null;
  openTaskCount: number;
  mostUrgentTaskDueAt: string | null;
};

type ListResponse = {
  rows: CustomerRow[];
  hasMore: boolean;
  totals: { b2b: number; b2c: number; uncategorized: number; all: number };
};

type FilterTab = "b2b" | "b2c" | "uncategorized" | "all";
type HoldFilter = "all" | "active" | "hold" | "payment_upfront";
type SortKey =
  | "displayName"
  | "balance"
  | "overdueBalance"
  | "lastSyncedAt"
  | "lastPaymentAt"
  | "lastStatementSentAt"
  | "lastContactedAt"
  | "openTaskCount";

const SORT_LABELS: Record<SortKey, string> = {
  displayName: "Name",
  balance: "Balance",
  overdueBalance: "Overdue",
  lastSyncedAt: "Last synced",
  lastPaymentAt: "Last payment",
  lastStatementSentAt: "Last statement",
  lastContactedAt: "Last contacted",
  openTaskCount: "Tasks",
};

const HOLD_LABELS: Record<HoldFilter, string> = {
  all: "All",
  active: "Active",
  hold: "On hold",
  payment_upfront: "Payment upfront",
};

const TAB_LABELS: Record<FilterTab, string> = {
  b2b: "B2B",
  b2c: "B2C",
  uncategorized: "Uncategorized",
  all: "All",
};

export default function CustomersPage() {
  const search = customersRouteApi.useSearch();
  const { setFilter, setFilters } = useFilterNavigate<CustomersSearch>("/customers");
  useFilterPersistence("/customers");

  // Local aliases — minimize downstream changes:
  const tab = search.tab;
  const sort = search.sort;
  const dir = search.dir;
  const hideZero = search.hideZero;
  const hasOverdueFilter = search.hasOverdue;
  const onHoldFilter = search.onHold;
  const missingTermsFilter = search.missingTerms;
  const hasUnactionedEmailFilter = search.hasUnactionedEmail;

  // Setters wrap useFilterNavigate. Toggles + tab + sort use push history;
  // text input + boolean filter chips use replace (default).
  const setTab = (next: CustomersSearch["tab"]) =>
    setFilters({ tab: next, hideZero: next === "b2b" }, { history: "push" });
  const setSort = (next: CustomersSearch["sort"]) =>
    setFilter("sort", next, { history: "push" });
  const setDir = (next: CustomersSearch["dir"]) =>
    setFilter("dir", next, { history: "push" });
  const setHideZero = (next: boolean) => setFilter("hideZero", next);
  const setHasOverdueFilter = (next: boolean) => setFilter("hasOverdue", next);
  const setOnHoldFilter = (next: boolean) => setFilter("onHold", next);
  const setMissingTermsFilter = (next: boolean) =>
    setFilter("missingTerms", next);
  const setHasUnactionedEmailFilter = (next: boolean) =>
    setFilter("hasUnactionedEmail", next);
  const setSearchValue = (next: string) => setFilter("search", next);

  const [sweepMode, setSweepMode] = useState(false);
  // Selected gmailIds in sweep mode. When the user toggles "Select all
  // (balance > 0)" we pre-fill with the matching ids; individual checkbox
  // clicks add/remove from this set.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Single TaskDetailDrawer mounted once on this page (Item 1).
  // null = closed; setting a DrawerMode opens it.
  const [taskDrawer, setTaskDrawer] = useState<TaskDrawerMode | null>(null);

  // Current operator — required by TaskDetailDrawer for mention resolution
  // and watcher self-attribution. Same query/staleTime as customer-detail.
  const meQuery = useQuery<{
    user: { id: string; name: string | null; email: string; image: string | null };
  }>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const currentUser = meQuery.data?.user ?? null;

  const queryClient = useQueryClient();

  const queryKey = [
    "customers",
    {
      tab,
      search: search.search,
      sort,
      dir,
      hideZero,
      hasOverdueFilter,
      onHoldFilter,
      missingTermsFilter,
      hasUnactionedEmailFilter,
    },
  ] as const;
  // When the search box has 2+ chars, ignore tab + filter chips so the
  // operator gets matches across ALL customers regardless of which tab
  // or chips are active (Item 3).
  const searchIsActive = search.search.trim().length >= 2;
  const hasActiveFilters =
    tab !== "all" ||
    hideZero ||
    hasOverdueFilter ||
    onHoldFilter ||
    missingTermsFilter ||
    hasUnactionedEmailFilter;

  const { data, isPending, isError, error } = useQuery<ListResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        // When search is active, send "all" so the backend ignores customerType.
        customerType: searchIsActive ? "all" : tab,
        sort,
        dir,
        // 5000 covers the full customer table (~2,400 today) so the
        // sweep + filter chips operate on the complete dataset rather
        // than the first page. Backend caps at 5000 in the route schema.
        limit: "5000",
      });
      if (searchIsActive) params.set("q", search.search.trim());
      // Filter chips are suppressed when search is active.
      if (!searchIsActive) {
        if (hideZero) params.set("hideZeroBalance", "true");
        if (hasOverdueFilter) params.set("hasOverdue", "true");
        if (onHoldFilter) params.set("holdStatus", "hold");
        if (missingTermsFilter) params.set("missingTerms", "true");
        if (hasUnactionedEmailFilter) params.set("hasUnactionedEmail", "true");
      }
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

  const bulkAgentModeMutation = useMutation({
    mutationFn: async (input: { ids: string[]; excluded: boolean }) => {
      const res = await fetch("/api/customers/bulk-agent-mode", {
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
        <SyncQbBadge />
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

        <div className="relative ml-auto flex flex-col items-end gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={search.search}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="Search name or email…"
              className="!pl-8"
              aria-label="Search customers"
            />
          </div>
          {searchIsActive && hasActiveFilters && (
            <p className="text-[11px] text-muted">
              Filters ignored — searching all customers
            </p>
          )}
        </div>

        <Button
          variant={sweepMode ? "primary" : "secondary"}
          size="sm"
          onClick={() => {
            setSweepMode((v) => !v);
            setSelectedIds(new Set());
          }}
        >
          {sweepMode ? "Exit bulk edit" : "Bulk edit"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Filters:</span>
        <FilterChip
          label="Hide $0"
          active={hideZero}
          onClick={() => setHideZero(!hideZero)}
        />
        <FilterChip
          label="Has overdue"
          active={hasOverdueFilter}
          onClick={() => setHasOverdueFilter(!hasOverdueFilter)}
        />
        <FilterChip
          label="On hold"
          active={onHoldFilter}
          onClick={() => setOnHoldFilter(!onHoldFilter)}
        />
        <FilterChip
          label="No terms set"
          active={missingTermsFilter}
          onClick={() => setMissingTermsFilter(!missingTermsFilter)}
        />
        <FilterChip
          label="Has unactioned email"
          active={hasUnactionedEmailFilter}
          onClick={() => setHasUnactionedEmailFilter(!hasUnactionedEmailFilter)}
        />
        {hideZero ||
        hasOverdueFilter ||
        onHoldFilter ||
        missingTermsFilter ||
        hasUnactionedEmailFilter ? (
          <button
            type="button"
            onClick={() => {
              setFilters({
                hideZero: false,
                hasOverdue: false,
                onHold: false,
                missingTerms: false,
                hasUnactionedEmail: false,
              });
            }}
            className="ml-1 text-muted hover:text-primary"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {sweepMode && (
        <Card className="hidden md:block">
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
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  selectedIds.size === 0 || bulkAgentModeMutation.isPending
                }
                onClick={() =>
                  bulkAgentModeMutation.mutate({
                    ids: Array.from(selectedIds),
                    excluded: false,
                  })
                }
              >
                Autopilot on
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  selectedIds.size === 0 || bulkAgentModeMutation.isPending
                }
                onClick={() =>
                  bulkAgentModeMutation.mutate({
                    ids: Array.from(selectedIds),
                    excluded: true,
                  })
                }
              >
                Autopilot off
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Mobile list — replaces the table below md. Cards instead of rows.
          Sweep mode flips each row into a checkbox-tap-to-select pattern. */}
      <div className="space-y-2 md:hidden">
        <div className="px-1 text-xs text-secondary">
          {isPending
            ? "Loading…"
            : `${visibleRows.length}${data?.hasMore ? "+" : ""} customers`}
        </div>
        {isError && (
          <div className="rounded-md border border-accent-danger/30 bg-accent-danger/10 p-3 text-sm text-accent-danger">
            {(error as Error)?.message ?? "Failed to load customers"}
          </div>
        )}
        {visibleRows.map((row) => (
          <CustomerRowMobile
            key={row.id}
            id={row.id}
            displayName={row.displayName}
            primaryEmail={row.primaryEmail}
            balance={Number(row.balance)}
            overdueBalance={effectiveOverdue(
              row.overdueBalance,
              row.unappliedCreditBalance,
            )}
            daysOverdue={row.daysOverdue}
            holdStatus={row.holdStatus}
            agentModeExcluded={row.agentModeExcluded}
            customerType={row.customerType}
            unactionedEmailCount={row.unactionedEmailCount}
            selectable={sweepMode}
            selected={selectedIds.has(row.id)}
            onToggleSelect={toggleId}
          />
        ))}
        {!isPending && visibleRows.length === 0 && (
          <div className="rounded-md border border-default bg-subtle p-8 text-center text-sm text-muted">
            No customers match.
          </div>
        )}
        {sweepMode && <StickyActionBarSpacer />}
      </div>

      {/* Desktop table — unchanged structure. */}
      <Card className="hidden md:block">
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
                <th className="px-3 py-2">Phone</th>
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
                <SortableTh
                  label="Last payment"
                  active={sort === "lastPaymentAt"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("lastPaymentAt", sort, setSort, dir, setDir)
                  }
                />
                <SortableTh
                  label="Last statement"
                  active={sort === "lastStatementSentAt"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("lastStatementSentAt", sort, setSort, dir, setDir)
                  }
                />
                <SortableTh
                  label="Last contacted"
                  active={sort === "lastContactedAt"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("lastContactedAt", sort, setSort, dir, setDir)
                  }
                />
                <SortableTh
                  label="Tasks"
                  active={sort === "openTaskCount"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("openTaskCount", sort, setSort, dir, setDir)
                  }
                />
                <th className="px-3 py-2">Terms</th>
                <th className="px-3 py-2">Status</th>
                <th className="w-10 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const balance = Number(row.balance);
                const rawOverdue = Number(row.overdueBalance);
                const credits = Number(row.unappliedCreditBalance);
                // Display nets unapplied credit memos; sort still uses
                // raw overdueBalance (DB-side) so direction still puts
                // the largest raw-overdue customers first, which is the
                // operationally useful ordering.
                const overdue = effectiveOverdue(
                  row.overdueBalance,
                  row.unappliedCreditBalance,
                );
                const overdueTooltip =
                  credits > 0
                    ? `Overdue net of $${credits.toFixed(2)} in unapplied credits (raw overdue: $${rawOverdue.toFixed(2)})`
                    : undefined;
                const checked = selectedIds.has(row.id);
                const onHold = row.holdStatus === "hold";
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      "group border-b border-default last:border-b-0",
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
                        className="inline-flex items-center gap-2 hover:text-accent-primary hover:underline underline-offset-2"
                      >
                        {row.displayName}
                        {row.tags?.some(
                          (t) => t.toLowerCase() === "yiddy",
                        ) ? (
                          <span
                            className="text-[8px] font-medium uppercase tracking-wide text-accent-info"
                            title="Yiddy's roster"
                          >
                            yiddy
                          </span>
                        ) : null}
                        {row.unactionedEmailCount > 0 ? (
                          <span
                            className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent-danger px-1 text-[10px] font-semibold leading-4 text-white"
                            title={`${row.unactionedEmailCount} unactioned email${row.unactionedEmailCount === 1 ? "" : "s"}`}
                          >
                            {row.unactionedEmailCount > 99
                              ? "99+"
                              : row.unactionedEmailCount}
                          </span>
                        ) : null}
                        {row.hasPendingRma ? (
                          <span
                            className="inline-flex items-center rounded border border-accent-warning/40 bg-accent-warning/10 px-1 text-[9px] font-medium uppercase tracking-wide text-accent-warning"
                            title="Has an active RMA in progress"
                          >
                            RMA
                          </span>
                        ) : null}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {row.phone ?? <span className="text-muted">—</span>}
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
                        <span
                          className="font-medium text-accent-warning"
                          title={overdueTooltip}
                        >
                          ${overdue.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted" title={overdueTooltip}>
                          —
                        </span>
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
                      {relativeShortDate(row.lastContactedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <TaskCountBadge
                        count={row.openTaskCount}
                        mostUrgentDueAt={row.mostUrgentTaskDueAt}
                      />
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {row.paymentTerms ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={row.holdStatus} />
                        <AutopilotBadge excluded={row.agentModeExcluded} />
                      </div>
                    </td>
                    <td className="px-1 py-2">
                      <button
                        type="button"
                        title="Add task for this customer"
                        aria-label={`Add task for ${row.displayName}`}
                        onClick={() =>
                          setTaskDrawer({
                            mode: "create",
                            defaults: { customerId: row.id },
                          })
                        }
                        className="flex items-center gap-0.5 rounded px-1.5 py-1 text-xs text-muted opacity-0 transition-opacity hover:bg-elevated hover:text-primary group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-primary"
                      >
                        <Plus className="size-3" />
                        Task
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!isPending && visibleRows.length === 0 && (
                <tr>
                  <td
                    className="p-8 text-center text-sm text-muted"
                    colSpan={sweepMode ? 13 : 12}
                  >
                    No customers match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {/* Single TaskDetailDrawer — opened by the per-row "+ Task" buttons (Item 1) */}
      <TaskDetailDrawer
        open={taskDrawer !== null}
        onClose={() => setTaskDrawer(null)}
        drawer={taskDrawer ?? { mode: "create" }}
        currentUser={currentUser}
        listQueryKey={queryKey}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ["customers"] });
        }}
      />

      {/* Mobile bulk-edit footer. Mirrors the desktop sweep bar but
          surfaces only the three most-used actions; B2B/B2C tagging
          sits behind the "Tag…" overflow which uses native confirm
          for now (a bottom sheet here is overkill for v1). */}
      {sweepMode && (
        <StickyActionBar>
          <span className="mr-1 shrink-0 text-xs text-secondary">
            {selectedIds.size}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={
              selectedIds.size === 0 || bulkAgentModeMutation.isPending
            }
            onClick={() =>
              bulkAgentModeMutation.mutate({
                ids: Array.from(selectedIds),
                excluded: true,
              })
            }
          >
            🤖 Off
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={
              selectedIds.size === 0 || bulkAgentModeMutation.isPending
            }
            onClick={() =>
              bulkAgentModeMutation.mutate({
                ids: Array.from(selectedIds),
                excluded: false,
              })
            }
          >
            🤖 On
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            disabled={selectedIds.size === 0 || bulkTagMutation.isPending}
            onClick={() => {
              if (typeof window === "undefined") return;
              const tag = window.prompt(
                "Tag selected customers as B2B or B2C?",
                "b2b",
              );
              if (!tag) return;
              const normalized = tag.toLowerCase();
              if (normalized !== "b2b" && normalized !== "b2c") return;
              bulkTagMutation.mutate({
                ids: Array.from(selectedIds),
                customerType: normalized,
              });
            }}
          >
            Tag…
          </Button>
        </StickyActionBar>
      )}
    </div>
  );
}

function CustomerTypeBadge({ type }: { type: CustomerType }) {
  if (type === "b2b") return <Badge tone="info">B2B</Badge>;
  if (type === "b2c") return <Badge tone="neutral">B2C</Badge>;
  return <Badge tone="medium">Untagged</Badge>;
}

// Three-state status pill. Mirrors the row.holdStatus enum so any new
// status value forces a TS error here — the only place every customer
// row reads its account state from.
function StatusBadge({ status }: { status: HoldStatus }) {
  if (status === "hold") {
    return (
      <Badge tone="critical">
        <Pause className="mr-1 size-3" />
        Hold
      </Badge>
    );
  }
  if (status === "payment_upfront") {
    return <Badge tone="high">Payment upfront</Badge>;
  }
  return <Badge tone="success">Active</Badge>;
}

// Small per-row autopilot indicator. "off" = excluded from AI proposals
// (agent_mode_excluded). Shown in the status cell beside the hold pill.
function AutopilotBadge({ excluded }: { excluded: boolean }) {
  return excluded ? (
    <Badge tone="medium">Autopilot off</Badge>
  ) : (
    <Badge tone="neutral">Autopilot on</Badge>
  );
}

// Tasks column cell — shows count with urgency colour coding (Item 2).
// overdue (mostUrgentDueAt < now) → critical (red)
// due soon (≤7 days) → high (amber)
// has tasks, no due pressure → neutral
// no tasks → muted dash
function TaskCountBadge({
  count,
  mostUrgentDueAt,
}: {
  count: number;
  mostUrgentDueAt: string | null;
}) {
  if (count === 0) return <span className="text-muted">—</span>;

  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  if (mostUrgentDueAt) {
    const due = new Date(mostUrgentDueAt).getTime();
    if (due < now) {
      return <Badge tone="critical">{count}</Badge>;
    }
    if (due - now <= sevenDays) {
      return <Badge tone="high">{count}</Badge>;
    }
  }

  return <Badge tone="neutral">{count}</Badge>;
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
    // Money + recency columns start desc (largest / newest first); name
    // starts asc (A→Z). lastSyncedAt left to default desc too — operator
    // wants "what synced most recently" surfaced, not stalest.
    const descByDefault: SortKey[] = [
      "balance",
      "overdueBalance",
      "lastPaymentAt",
      "lastStatementSentAt",
      "lastContactedAt",
      "lastSyncedAt",
      "openTaskCount",
    ];
    setDir(descByDefault.includes(col) ? "desc" : "asc");
  }
}
