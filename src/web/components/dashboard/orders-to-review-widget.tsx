import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, PauseCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Badge } from "../ui/badge";
import { WidgetHeader } from "./widget-header";

type HoldOrderRow = {
  orderId: string;
  orderNumber: string | null;
  orderDate: string | null;
  orderTotal: string | null;
  customerId: string;
  customerName: string | null;
  reason: "customer_on_hold" | "payment_upfront_unpaid";
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

const gbp = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
});

function money(v: string | null): string {
  const n = Number(v);
  return Number.isFinite(n) ? gbp.format(n) : "—";
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

// Replaces the old "unactioned emails today" widget. Two groups of still-
// holdable (unshipped) orders that need attention: HOLD orders (on-hold or
// payment-upfront-unpaid customers) up top, then overdue-balance review orders.
export function OrdersToReviewWidget() {
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
            {hold.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-danger">
                  <PauseCircle className="size-3" />
                  Hold orders ({hold.length})
                </div>
                <ul className="divide-y divide-default">
                  {hold.map((r) => (
                    <li key={r.orderId} className="py-2 first:pt-0">
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: r.customerId }}
                        className="block hover:text-accent-info"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <AlertTriangle className="size-3.5 shrink-0 text-accent-danger" />
                            <span className="truncate font-medium text-primary">
                              {r.customerName ?? "(unknown customer)"}
                            </span>
                          </span>
                          <Badge tone={r.reason === "customer_on_hold" ? "critical" : "high"}>
                            {r.reason === "customer_on_hold"
                              ? "On hold"
                              : "Prepay unpaid"}
                          </Badge>
                        </div>
                        <div className="mt-0.5 pl-5 text-xs text-secondary">
                          {orderMeta(r.orderNumber, r.orderDate, r.orderTotal)}
                        </div>
                      </Link>
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
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: r.customerId }}
                        className="block hover:text-accent-info"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-medium text-primary">
                            {r.customerName ?? "(unknown customer)"}
                          </span>
                          <Badge tone="critical">
                            {money(r.overdueBalance)} overdue
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-xs text-secondary">
                          {orderMeta(r.orderNumber, r.orderDate, r.orderTotal)}
                        </div>
                      </Link>
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
