import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PauseCircle, Clock, Mail } from "lucide-react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WidgetHeader } from "./widget-header";

type HoldReason =
  | "customer_on_hold"
  | "payment_upfront_unpaid"
  | "overdue_non_communicating"
  | null;

type HoldOrderRow = {
  orderId: string;
  orderNumber: string | null;
  orderDate: string | null;
  orderTotal: string | null;
  customerId: string;
  customerName: string | null;
  reason: HoldReason;
  heldDays: number;
};

type OverdueOrderRow = {
  orderId: string;
  orderNumber: string | null;
  orderDate: string | null;
  orderTotal: string | null;
  customerId: string;
  customerName: string | null;
  overdueBalance: string;
  alerted: boolean;
};

type HoldHistoryEntry = {
  occurredAt: string;
  action: string;
  userId: string | null;
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function money(v: string | null): string {
  const n = Number(v);
  return Number.isFinite(n) ? usd.format(n) : "—";
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function orderMeta(
  orderNumber: string | null,
  orderDate: string | null,
  orderTotal: string | null,
): string {
  return [
    `Order ${orderNumber ?? "—"}`,
    shortDate(orderDate),
    orderTotal ? money(orderTotal) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const HOLD_ACTION_LABELS: Record<string, string> = {
  "order.hold_started": "Placed on hold",
  "order.hold_notice_sent": "Customer notified (Day 0)",
  "order.hold_warning_sent": "Final warning sent (Day 7)",
  "order.hold_cancel_notified": "Cancel notice sent (Day 10)",
  "order.hold_released": "Released — good to send",
  "order.hold_auto_released": "Auto-released (resolved)",
  "order.hold_cancelled": "Cancelled",
};

// Inline, on-demand hold audit trail under a row.
function HoldHistory({ orderId }: { orderId: string }) {
  const { data, isPending, isError } = useQuery<{ rows: HoldHistoryEntry[] }>({
    queryKey: ["order-hold-history", orderId],
    queryFn: async () => {
      const res = await fetch(
        `/api/orders/${encodeURIComponent(orderId)}/hold-history`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  if (isPending) return <p className="py-1 text-xs text-muted">Loading history…</p>;
  if (isError) return <p className="py-1 text-xs text-accent-danger">Failed to load history.</p>;
  const rows = data?.rows ?? [];
  if (rows.length === 0) return <p className="py-1 text-xs text-muted">No history yet.</p>;
  return (
    <ol className="mt-1 space-y-1 border-l border-default pl-3">
      {rows.map((r, i) => (
        <li key={i} className="text-xs text-secondary">
          <span className="text-muted">{shortDate(r.occurredAt)}</span>{" "}
          {HOLD_ACTION_LABELS[r.action] ?? r.action}
          {r.userId ? "" : " · auto"}
        </li>
      ))}
    </ol>
  );
}

// Replaces the old "unactioned emails today" widget. Two groups of still-
// holdable (unshipped) orders: HOLD orders (with Good-to-send / Chase / History)
// up top, then overdue-balance review orders (with Place-on-hold).
export function OrdersToReviewWidget() {
  const queryClient = useQueryClient();
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery<{ hold: HoldOrderRow[]; overdue: OverdueOrderRow[] }>({
    queryKey: ["dashboard", "orders-to-review"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/orders-to-review");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const action = useMutation({
    mutationFn: async (args: { orderId: string; path: string }) => {
      const res = await fetch(
        `/api/orders/${encodeURIComponent(args.orderId)}/${args.path}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    onMutate: (args) => {
      setBusyOrder(args.orderId);
      setError(null);
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "orders-to-review"],
      }),
    onError: (e) => setError((e as Error).message),
    onSettled: () => setBusyOrder(null),
  });

  const hold = query.data?.hold ?? [];
  const overdue = query.data?.overdue ?? [];
  const total = hold.length + overdue.length;

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="Orders to review" count={total} />
      </CardHeader>
      <CardBody>
        {query.isPending ? (
          <div className="space-y-2">
            <div className="h-6 animate-pulse rounded bg-subtle" />
            <div className="h-6 animate-pulse rounded bg-subtle" />
          </div>
        ) : query.isError ? (
          <div className="text-xs text-accent-danger">
            Failed to load flagged orders.
          </div>
        ) : total === 0 ? (
          <div className="text-xs text-muted">No orders to review.</div>
        ) : (
          <div className="space-y-3">
            {error && <p className="text-xs text-accent-danger">{error}</p>}
            {hold.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-danger">
                  <PauseCircle className="size-3" />
                  Hold orders ({hold.length})
                </div>
                <ul className="divide-y divide-default">
                  {hold.map((r) => (
                    <li key={r.orderId} className="py-2 first:pt-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <Link
                          to="/customers/$customerId"
                          params={{ customerId: r.customerId }}
                          className="flex min-w-0 items-center gap-1.5 hover:text-accent-info"
                        >
                          <AlertTriangle className="size-3.5 shrink-0 text-accent-danger" />
                          <span className="truncate font-medium text-primary">
                            {r.customerName ?? "(unknown customer)"}
                          </span>
                        </Link>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {r.heldDays >= 7 && (
                            <Badge tone="high" title="Held over 7 days — consider cancelling">
                              held {r.heldDays}d
                            </Badge>
                          )}
                          <Badge tone="critical">HOLD</Badge>
                        </span>
                      </div>
                      <div className="mt-0.5 pl-5 text-xs text-secondary">
                        {orderMeta(r.orderNumber, r.orderDate, r.orderTotal)}
                        {r.heldDays > 0 && r.heldDays < 7
                          ? ` · held ${r.heldDays}d`
                          : ""}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() =>
                            action.mutate({ orderId: r.orderId, path: "good-to-send" })
                          }
                          disabled={busyOrder === r.orderId}
                          loading={busyOrder === r.orderId}
                        >
                          Good to send
                        </Button>
                        <Link
                          to="/customers/$customerId"
                          params={{ customerId: r.customerId }}
                          className="inline-flex items-center gap-1 rounded-md border border-default bg-base px-2 py-1 text-xs hover:bg-elevated"
                        >
                          <Mail className="size-3" /> Chase
                        </Link>
                        <button
                          type="button"
                          onClick={() =>
                            setOpenHistory(
                              openHistory === r.orderId ? null : r.orderId,
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-default bg-base px-2 py-1 text-xs hover:bg-elevated"
                        >
                          <Clock className="size-3" /> History
                        </button>
                        {confirmCancel === r.orderId ? (
                          <span className="inline-flex items-center gap-1">
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() =>
                                action.mutate({ orderId: r.orderId, path: "cancel" })
                              }
                              disabled={busyOrder === r.orderId}
                              loading={busyOrder === r.orderId}
                            >
                              Confirm cancel
                            </Button>
                            <button
                              type="button"
                              onClick={() => setConfirmCancel(null)}
                              className="rounded-md px-1.5 py-1 text-xs text-muted hover:text-primary"
                            >
                              No
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmCancel(r.orderId)}
                            className="inline-flex items-center gap-1 rounded-md border border-accent-danger/40 px-2 py-1 text-xs text-accent-danger hover:bg-accent-danger/10"
                          >
                            Cancel order
                          </button>
                        )}
                      </div>
                      {openHistory === r.orderId && (
                        <div className="pl-5">
                          <HoldHistory orderId={r.orderId} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {overdue.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Overdue balance ({overdue.length})
                </div>
                <ul className="divide-y divide-default">
                  {overdue.map((r) => (
                    <li key={r.orderId} className="py-2 first:pt-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <Link
                          to="/customers/$customerId"
                          params={{ customerId: r.customerId }}
                          className="truncate font-medium text-primary hover:text-accent-info"
                        >
                          {r.customerName ?? "(unknown customer)"}
                        </Link>
                        <Badge tone="critical">
                          {money(r.overdueBalance)} overdue
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-secondary">
                        {orderMeta(r.orderNumber, r.orderDate, r.orderTotal)}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            action.mutate({ orderId: r.orderId, path: "place-on-hold" })
                          }
                          disabled={busyOrder === r.orderId}
                          loading={busyOrder === r.orderId}
                        >
                          <PauseCircle className="size-3.5" /> Place on hold
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
