// Home dashboard. At-a-glance state of the things the operator acts on:
// open balance, overdue, customers needing chase, today's email volume,
// my open tasks. Plus the past-11am-London nag if any of today's
// shipment emails haven't been sent yet.
//
// Stats come from /api/dashboard/stats — single round-trip aggregate.
// The unsent-invoices alert reuses the /api/invoicing/today query so
// the cache is shared with the /invoicing page (opening one warms the
// other).

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  AlertCircle,
  CheckSquare,
  DollarSign,
  Mail,
  Users,
} from "lucide-react";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";

const INVOICING_CUTOFF_HOUR_LONDON = 11;

type DashboardStats = {
  openBalance: number;
  overdueBalance: number;
  customersOverdue: number;
  myOpenTasks: number;
  emailsInToday: number;
  emailsOutToday: number;
};

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

function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export default function HomePage() {
  const { data: stats, isPending: statsPending } = useQuery<DashboardStats>({
    queryKey: ["dashboard", "stats"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

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

      {/* Money tiles — what's outstanding + how bad. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatTile
          label="Open balance"
          icon={DollarSign}
          tone="neutral"
          value={
            statsPending ? "…" : stats ? formatMoney(stats.openBalance) : "—"
          }
          sublabel="across all customers"
          to="/customers"
        />
        <StatTile
          label="Overdue"
          icon={AlertCircle}
          tone={stats && stats.overdueBalance > 0 ? "danger" : "neutral"}
          value={
            statsPending
              ? "…"
              : stats
                ? formatMoney(stats.overdueBalance)
                : "—"
          }
          sublabel={
            stats
              ? `${stats.customersOverdue} ${
                  stats.customersOverdue === 1 ? "customer" : "customers"
                }`
              : ""
          }
          to="/chase"
        />
        <StatTile
          label="My open tasks"
          icon={CheckSquare}
          tone={stats && stats.myOpenTasks > 0 ? "info" : "neutral"}
          value={statsPending ? "…" : String(stats?.myOpenTasks ?? "—")}
          sublabel={
            stats && stats.myOpenTasks > 0
              ? "needs attention"
              : "all clear"
          }
          to="/tasks"
        />
      </div>

      {/* Email volume tiles — how busy today is */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <StatTile
          label="Emails in today"
          icon={Mail}
          tone="neutral"
          value={statsPending ? "…" : String(stats?.emailsInToday ?? "—")}
          sublabel="customer correspondence"
          to="/customers"
        />
        <StatTile
          label="Emails sent today"
          icon={Mail}
          tone="neutral"
          value={statsPending ? "…" : String(stats?.emailsOutToday ?? "—")}
          sublabel="from any alias"
          to="/customers"
        />
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

function StatTile({
  label,
  icon: Icon,
  value,
  sublabel,
  to,
  tone,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  sublabel?: string;
  to: string;
  tone: "neutral" | "danger" | "info";
}) {
  const valueClass =
    tone === "danger"
      ? "text-accent-danger"
      : tone === "info"
        ? "text-accent-primary"
        : "text-primary";
  return (
    <Link to={to} className="block">
      <Card className="transition-colors hover:border-accent-primary/40">
        <CardBody>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted">
                {label}
              </div>
              <div
                className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}
              >
                {value}
              </div>
              {sublabel ? (
                <div className="mt-0.5 text-xs text-secondary">{sublabel}</div>
              ) : null}
            </div>
            <Icon className="size-4 text-muted" />
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}
