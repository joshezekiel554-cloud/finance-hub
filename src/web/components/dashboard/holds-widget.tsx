import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";
import { groupHolds } from "../../lib/dashboard-derive";

type HoldRow = {
  id: string;
  displayName: string;
  holdStatus: "hold" | "payment_upfront";
  overdueBalance: string;
  heldSinceAt: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  hold: "On hold",
  payment_upfront: "Prepay",
};

function formatMoney(s: string | number): string {
  const n = typeof s === "string" ? Number(s) : s;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}

function daysSince(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return `${days}d`;
}

export function HoldsWidget() {
  const { data, isPending, isError } = useQuery<{ rows: HoldRow[] }>({
    queryKey: ["dashboard", "holds"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/holds");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];
  const groups = groupHolds(rows);

  const renderGroup = (title: string, list: HoldRow[]) =>
    list.length === 0 ? null : (
      <div key={title}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          {title} <span className="font-normal">{list.length}</span>
        </div>
        <ul className="divide-y divide-default">
          {list.slice(0, 6).map((c) => (
            <li key={c.id} className="py-2 first:pt-0 last:pb-0">
              <Link
                to="/customers/$customerId"
                params={{ customerId: c.id }}
                className="flex items-center justify-between gap-2 text-sm hover:text-accent-info"
              >
                <div className="min-w-0">
                  <div className="font-medium text-primary truncate">{c.displayName}</div>
                  <div className="text-xs text-muted">
                    {STATUS_LABEL[c.holdStatus] ?? c.holdStatus} since {daysSince(c.heldSinceAt)}
                  </div>
                </div>
                <span className={`shrink-0 text-xs tabular-nums ${Number(c.overdueBalance) > 0 ? "text-accent-danger" : "text-muted"}`}>
                  {formatMoney(c.overdueBalance)} overdue
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {list.length > 6 && <div className="mt-1 text-xs text-muted">+ {list.length - 6} more</div>}
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <WidgetHeader
          title="Customers on hold"
          count={rows.length}
          link="/customers"
          linkLabel="Customers"
        />
      </CardHeader>
      <CardBody className="space-y-4">
        {isPending ? (
          <div className="h-6 rounded bg-subtle animate-pulse" />
        ) : isError ? (
          <div className="text-xs text-accent-danger">
            Failed to load holds.
          </div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">No customers on hold.</div>
        ) : (
          <>
            {renderGroup("On hold", groups.onHold)}
            {renderGroup("Payment upfront", groups.paymentUpfront)}
          </>
        )}
      </CardBody>
    </Card>
  );
}
