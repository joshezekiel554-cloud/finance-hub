import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type RmaRow = {
  id: string;
  rmaNumber: string | null;
  status: string;
  totalValue: string;
  updatedAt: string;
  customerId: string;
  customerName: string;
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting WH#",
  sent_to_warehouse: "At warehouse",
  received: "Received",
};

export function RmasWidget() {
  const { data, isPending, isError } = useQuery<{ rows: RmaRow[] }>({
    queryKey: ["dashboard", "rmas"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/rmas");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader
          title="RMAs in flight"
          count={rows.length}
          link="/returns"
        />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="h-6 rounded bg-subtle animate-pulse" />
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load RMAs.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">No RMAs in flight.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li key={r.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/returns"
                  className="flex items-center justify-between gap-2 text-sm hover:text-accent-info"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-primary truncate">
                      {r.rmaNumber ?? r.id.slice(0, 8)} · {r.customerName}
                    </div>
                  </div>
                  <span className="text-xs rounded bg-subtle px-1.5 py-0.5 text-muted shrink-0">
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
