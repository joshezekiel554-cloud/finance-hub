// Home dashboard. Action-queue model: five widgets, each a list of items
// the operator can act on (not stat tiles). Each widget owns its own
// fetch + polling — see src/web/components/dashboard/*.
//
// Past-11am-London nag for unsent shipment emails stays as a banner above
// the widget grid; it reuses /api/invoicing/today so the cache is shared
// with the /invoicing page (opening one warms the other).

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { TasksWidget } from "../components/dashboard/tasks-widget";
import { OverdueOrdersWidget } from "../components/dashboard/overdue-orders-widget";
import { ChaseWidget } from "../components/dashboard/chase-widget";
import { RmasWidget } from "../components/dashboard/rmas-widget";
import { HoldsWidget } from "../components/dashboard/holds-widget";

const INVOICING_CUTOFF_HOUR_LONDON = 11;

type TodayRow = {
  gmailId: string;
  receivedAt: string | null;
  qbInvoice: { emailStatus: string | null } | null;
};
type TodayResponse = {
  rows: TodayRow[];
  dismissed: Record<string, unknown>;
};

const LONDON_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Europe/London",
});

const LONDON_HOUR_FMT = new Intl.DateTimeFormat("en-GB", {
  hour: "numeric",
  hour12: false,
  timeZone: "Europe/London",
});

function londonDateFor(d: Date): string {
  return LONDON_DATE_FMT.format(d);
}

function londonHourNow(): number {
  const v = LONDON_HOUR_FMT.format(new Date());
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export default function HomePage() {
  const { data: todayData } = useQuery<TodayResponse>({
    queryKey: ["invoicing", "today"],
    queryFn: async () => {
      const res = await fetch("/api/invoicing/today");
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      return res.json();
    },
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  });

  const unsentToday = useMemo(() => {
    if (!todayData) return 0;
    const todayLondon = londonDateFor(new Date());
    const dismissed = todayData.dismissed ?? {};
    let count = 0;
    for (const row of todayData.rows) {
      if (!row.receivedAt) continue;
      if (londonDateFor(new Date(row.receivedAt)) !== todayLondon) continue;
      if (dismissed[row.gmailId]) continue;
      if (row.qbInvoice?.emailStatus === "EmailSent") continue;
      count++;
    }
    return count;
  }, [todayData]);

  const showInvoicingAlert =
    unsentToday > 0 && londonHourNow() >= INVOICING_CUTOFF_HOUR_LONDON;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-secondary">
          What needs your attention right now.
        </p>
      </div>

      {showInvoicingAlert ? (
        <Card className="border-accent-danger/40 bg-accent-danger/5">
          <CardBody>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-accent-danger" />
              <div className="flex-1">
                <div className="text-sm font-medium text-primary">
                  {unsentToday === 1
                    ? "1 invoice today not sent yet"
                    : `${unsentToday} invoices today not sent yet`}
                </div>
                <div className="mt-0.5 text-xs text-secondary">
                  Past the {INVOICING_CUTOFF_HOUR_LONDON}am cutoff — review
                  and send so customers don't get same-day backlog.
                </div>
              </div>
              <Link to="/invoicing">
                <Button variant="primary" size="sm">
                  Open invoicing <ArrowRight className="size-3.5" />
                </Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Action-queue widgets — 3 on top, 2 on the bottom. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TasksWidget />
        <OverdueOrdersWidget />
        <ChaseWidget />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RmasWidget />
        <HoldsWidget />
      </div>

      {/* Quick links — most-used pages, one click away. */}
      <Card>
        <CardBody>
          <div className="text-sm font-medium mb-3">Jump to</div>
          <div className="flex flex-wrap gap-2">
            <Link to="/invoicing">
              <Button variant="secondary" size="sm">Today's invoicing</Button>
            </Link>
            <Link to="/chase">
              <Button variant="secondary" size="sm">Chase list</Button>
            </Link>
            <Link to="/customers">
              <Button variant="secondary" size="sm">Customers</Button>
            </Link>
            <Link to="/statements">
              <Button variant="secondary" size="sm">Statements log</Button>
            </Link>
            <Link to="/tasks">
              <Button variant="secondary" size="sm">Tasks</Button>
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
