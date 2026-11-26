import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, FileText, HandCoins, Loader2, Search, Truck } from "lucide-react";
import { api, type HoldRow } from "./api";
import {
  HOLD_TABS,
  HOLD_TAB_LABELS,
  LADDER_STAGE_LABELS,
  MISMATCH_LABELS,
  type HoldTab,
} from "../../modules/hold-orders/board-classify";
import { daysLabel, formatDate, formatMoney, holdStateLabel, promiseLine } from "./lib/view";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function HoldsList({
  tab,
  onTab,
  onOpen,
}: {
  tab: HoldTab;
  onTab: (t: HoldTab) => void;
  onOpen: (orderId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 250);
  const list = useInfiniteQuery({
    queryKey: ["holds-list", tab, q],
    queryFn: ({ pageParam }) => api.list({ status: tab, search: q, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const first = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <section aria-label="Orders">
      <div className="-mx-4 mb-3 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div role="tablist" className="flex min-w-max gap-1 border-b border-default">
          {HOLD_TABS.map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => onTab(t)}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                tab === t ? "border-accent-primary font-medium text-primary" : "border-transparent text-secondary hover:text-primary",
              )}
            >
              {HOLD_TAB_LABELS[t]}
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  t === "shipped_while_held" && (first?.counts[t] ?? 0) > 0 ? "bg-accent-danger/15 text-accent-danger" : "bg-elevated text-muted",
                )}
              >
                {first?.counts[t] ?? "·"}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by order # or customer"
            className="pl-8"
            aria-label="Filter this list"
          />
        </div>
        <FindOrder onOpen={onOpen} />
      </div>

      {list.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : list.error ? (
        <p className="py-10 text-sm text-accent-danger">Couldn't load the list: {(list.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-default py-10 text-center text-sm text-muted">
          {q ? "Nothing matches that filter." : emptyText(tab)}
        </p>
      ) : (
        <ul className="divide-y divide-default overflow-hidden rounded-xl border border-default bg-base">
          {rows.map((r) => (
            <HoldRowItem key={r.orderId} row={r} onOpen={() => onOpen(r.orderId)} />
          ))}
        </ul>
      )}

      {list.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
      {first ? (
        <p className="mt-3 text-xs text-muted">
          {first.total} order{first.total === 1 ? "" : "s"} · updated {new Date(first.generatedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </section>
  );
}

function emptyText(tab: HoldTab): string {
  switch (tab) {
    case "held":
      return "No orders on hold.";
    case "chasing":
      return "No held orders are being chased right now.";
    case "at_risk":
      return "No open orders would be held by a rule or the standard checks.";
    case "shipped_while_held":
      return "No mismatches — nothing shipped while still held here.";
    case "released":
      return "Nothing released in the last 30 days.";
  }
}

function HoldRowItem({ row, onOpen }: { row: HoldRow; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-1 gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-subtle focus-visible:bg-subtle focus-visible:outline-none md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.2fr)]"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-primary tabular-nums">{row.orderNumber}</span>
            <span className="truncate text-secondary">{row.customerName ?? "Unknown customer"}</span>
            <span className="text-xs text-muted tabular-nums">{formatMoney(row.amount)}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-secondary">{row.why}</p>
          {row.mismatch ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent-danger">
              <AlertTriangle className="size-3.5" aria-hidden /> {MISMATCH_LABELS[row.mismatch]}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs md:flex-col md:items-start md:gap-1">
          <Badge tone={row.holdState === "on_hold" ? "critical" : row.holdState === "released" ? "success" : row.atRisk ? "high" : "neutral"}>
            {row.atRisk ? "At risk" : holdStateLabel(row.holdState)}
          </Badge>
          {row.holdState === "on_hold" ? <span className="text-muted">{daysLabel(row.daysHeld)} held</span> : null}
          {row.holdState === "released" && row.releasedAt ? <span className="text-muted">released {formatDate(row.releasedAt)}</span> : null}
          {row.holdState === "on_hold" ? <span className="text-muted">{LADDER_STAGE_LABELS[row.ladderStage]}</span> : null}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-secondary md:flex-col">
          <span className="inline-flex items-center gap-1">
            <FileText className="size-3.5 text-muted" aria-hidden />
            {row.invoiced ? `Invoiced ${row.invoiced.docNumber}${Number(row.invoiced.balance) > 0 ? ` · ${formatMoney(row.invoiced.balance)} open` : " · paid"}` : "Not invoiced"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Truck className="size-3.5 text-muted" aria-hidden />
            {row.shipped
              ? `Shipped${row.shipped.shipDate ? ` ${formatDate(row.shipped.shipDate)}` : ""} (${row.shipped.source === "extensiv" ? "warehouse" : "Shopify"})`
              : "Not shipped"}
          </span>
          {row.overdueBalance && Number(row.overdueBalance) > 0 ? (
            <span className="text-muted">{formatMoney(row.overdueBalance)} overdue</span>
          ) : null}
        </div>
      </button>
      {row.promise && row.holdState === "on_hold" ? (
        // Outside the row button: a link can't live inside a <button>.
        <p className="-mt-1 flex flex-wrap items-center gap-x-2 px-4 pb-3 text-xs text-accent-info">
          <HandCoins className="size-3.5 shrink-0" aria-hidden />
          <span>{promiseLine(row.promise)}</span>
          {row.promise.emailUrl ? (
            <a href={row.promise.emailUrl} target="_top" className="inline-flex items-center gap-0.5 font-medium hover:underline">
              Open the email <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

function FindOrder({ onOpen }: { onOpen: (orderId: string) => void }) {
  const [value, setValue] = useState("");
  const q = useDebounced(value.trim(), 300);
  const found = useQuery({
    queryKey: ["holds-find", q],
    queryFn: () => api.find(q),
    enabled: q.replace(/^#/, "").length >= 2,
  });
  return (
    <div className="relative sm:w-72">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Find any order # to hold"
        aria-label="Find any order by number"
      />
      {q.length >= 2 && found.data ? (
        <ul className="absolute right-0 z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-default bg-base shadow-lg">
          {found.data.orders.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted">No order matches.</li>
          ) : (
            found.data.orders.map((o) => (
              <li key={o.orderId}>
                <button
                  type="button"
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-subtle"
                  onClick={() => {
                    setValue("");
                    onOpen(o.orderId);
                  }}
                >
                  <span className="font-medium tabular-nums">{o.orderNumber ?? `#${o.shopifyOrderId}`}</span>
                  <span className="truncate text-xs text-secondary">{o.customerName ?? ""}</span>
                  <span className="shrink-0 text-xs text-muted">{holdStateLabel(o.holdState ?? "none")}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
