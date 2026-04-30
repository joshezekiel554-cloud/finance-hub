import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  FileText,
  Users,
  CheckSquare,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";

// Cutoff for the "today's invoices unsent" warning. Matches the operating
// rhythm: shipment emails arrive overnight + through the morning, the
// operator processes them during the morning, and by 11am London anything
// still in Open is overdue. Before 11am we don't nag.
const INVOICING_CUTOFF_HOUR_LONDON = 11;

// Subset of /api/invoicing/today response — we only need fields that drive
// the alert. The full response shape lives on the /invoicing page.
type TodayRow = {
  gmailId: string;
  receivedAt: string | null;
  qbInvoice: { emailStatus: string | null } | null;
};
type TodayResponse = {
  rows: TodayRow[];
  dismissed: Record<string, unknown>;
};

// Date in Europe/London formatted as YYYY-MM-DD. en-CA gives ISO-style
// numeric output without locale surprises.
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
  // The formatter emits "0".."23" for hour12:false. parseInt handles the
  // single-digit case ("0", "9") and rejects empty.
  const v = LONDON_HOUR_FMT.format(new Date());
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export default function HomePage() {
  // Reuse the /invoicing page's cache key so opening Home pre-warms /invoicing
  // and vice versa. 2-minute stale tolerance is fine — the alert is a nudge,
  // not a real-time signal.
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
          Finance hub scaffold — UI primitives wired, schema and modules land in subsequent phases.
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-secondary">Open invoices</span>
              <FileText className="size-4 text-muted" />
            </div>
          </CardHeader>
          <CardBody>
            <div className="text-2xl font-semibold">--</div>
            <Badge tone="info" className="mt-2">
              awaiting sync
            </Badge>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-secondary">Active customers</span>
              <Users className="size-4 text-muted" />
            </div>
          </CardHeader>
          <CardBody>
            <div className="text-2xl font-semibold">--</div>
            <Badge tone="neutral" className="mt-2">
              awaiting sync
            </Badge>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-secondary">Tasks due today</span>
              <CheckSquare className="size-4 text-muted" />
            </div>
          </CardHeader>
          <CardBody>
            <div className="text-2xl font-semibold">--</div>
            <Badge tone="neutral" className="mt-2">
              not configured
            </Badge>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Next steps</h2>
        </CardHeader>
        <CardBody>
          <ul className="space-y-2 text-sm text-secondary">
            <li>1. Drizzle schema + migrations land via the schema task</li>
            <li>2. Auth (sessions + Arctic OAuth) lands via the auth task</li>
            <li>3. Pino logging + readiness probe via the observability task</li>
            <li>4. Module routes mount under /api as feature agents complete their work</li>
          </ul>
          <div className="mt-4">
            <Button variant="primary" size="sm">
              Read the docs <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
