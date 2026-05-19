import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Button } from "../ui/button";
import { WidgetHeader } from "./widget-header";

type ChaseRow = {
  customerId: string;
  customerName: string;
  tier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  daysOverdue: number;
  totalOverdue: number;
  oldestUnpaidDate: string | null;
  primaryEmail: string | null;
};

const TIER_STYLES: Record<ChaseRow["tier"], string> = {
  CRITICAL: "bg-accent-danger/15 text-accent-danger",
  HIGH: "bg-accent-warning/15 text-accent-warning",
  MEDIUM: "bg-accent-info/15 text-accent-info",
  LOW: "bg-subtle text-muted",
};

function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function ChaseWidget() {
  const queryClient = useQueryClient();

  const { data, isPending, isError } = useQuery<{ rows: ChaseRow[] }>({
    queryKey: ["dashboard", "chase"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/chase");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const dismissMutation = useMutation({
    mutationFn: async (customerId: string) => {
      const res = await fetch(
        `/api/dashboard/chase/${encodeURIComponent(customerId)}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onMutate: async (customerId: string) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard", "chase"] });
      const prev = queryClient.getQueryData<{ rows: ChaseRow[] }>([
        "dashboard",
        "chase",
      ]);
      if (prev) {
        queryClient.setQueryData(["dashboard", "chase"], {
          rows: prev.rows.filter((r) => r.customerId !== customerId),
        });
      }
      return { prev };
    },
    onError: (_err, _customerId, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(["dashboard", "chase"], ctx.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", "chase"] });
      // Also bust the customer detail caches so the Undismiss badge flips
      // to visible if the operator navigates to a dismissed customer.
      queryClient.invalidateQueries({ queryKey: ["customer"] });
    },
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader
          title="Chase queue"
          count={rows.length}
          link="/chase"
        />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load chase.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">Nothing to chase.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li
                key={r.customerId}
                className="flex items-center gap-2 py-2 first:pt-0 last:pb-0"
              >
                <span
                  className={`text-[10px] font-semibold rounded px-1.5 py-0.5 shrink-0 ${TIER_STYLES[r.tier]}`}
                >
                  {r.tier}
                </span>
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: r.customerId }}
                  className="flex-1 min-w-0 text-sm hover:text-accent-info"
                >
                  <div className="font-medium text-primary truncate">
                    {r.customerName}
                  </div>
                  <div className="text-xs text-muted">
                    {formatMoney(r.totalOverdue)} · {r.daysOverdue}d overdue
                  </div>
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dismissMutation.mutate(r.customerId)}
                  title="Dismiss — permanent until manually undismissed"
                  disabled={dismissMutation.isPending}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
