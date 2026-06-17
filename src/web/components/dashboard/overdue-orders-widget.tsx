import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Badge } from "../ui/badge";
import { WidgetHeader } from "./widget-header";

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

// Replaces the old "unactioned emails today" widget. Flags orders placed by
// customers with a large overdue balance who aren't communicating — the same
// orders that trigger the urgent review email from the orders-sync job.
export function OverdueOrdersWidget() {
  const query = useQuery<{ rows: OverdueOrderRow[] }>({
    queryKey: ["dashboard", "overdue-orders"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/overdue-orders");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = query.data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="Overdue-balance orders" count={rows.length} />
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
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">
            No overdue-balance orders flagged.
          </div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
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
                    <Badge tone="critical">{money(r.overdueBalance)} overdue</Badge>
                  </div>
                  <div className="mt-0.5 pl-5 text-xs text-secondary">
                    Order {r.orderNumber ?? "—"}
                    {r.orderDate ? ` · ${shortDate(r.orderDate)}` : ""}
                    {r.orderTotal ? ` · ${money(r.orderTotal)}` : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
