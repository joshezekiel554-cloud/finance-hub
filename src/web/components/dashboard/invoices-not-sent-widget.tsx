// "Invoices not sent yet today" — today's warehouse shipment emails that
// still need an invoice created/sent. Reads the same /api/invoicing/today
// query the Today page uses (shared React Query cache, so opening either
// warms the other). Turns red after the 11am London cutoff, replacing the
// old banner.

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";
import { londonDateOf, unsentTodayRows } from "../../lib/dashboard-derive";

const CUTOFF_HOUR_LONDON = 11;

type TodayRow = {
  gmailId: string;
  receivedAt: string | null;
  emailSubject: string;
  unparsedRows: string[];
  autoHidden: string | null;
  parsed: { shopifyOrderNumber: string | null; endCustomerName: string | null; lineItems: Array<unknown> };
  qbInvoice: { docNumber: string; customerName: string | null; totalAmt: number; emailStatus: string | null } | null;
  shopifyOrder: { orderNumber: number; customerEmail: string | null; lineCount: number } | null;
};
type TodayResponse = { rows: TodayRow[]; dismissed: Record<string, unknown> };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function londonHourNow(): number {
  const v = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }).format(new Date());
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export function InvoicesNotSentWidget() {
  const { data, isPending, isError } = useQuery<TodayResponse>({
    queryKey: ["invoicing", "today"],
    queryFn: async () => {
      const res = await fetch("/api/invoicing/today");
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      return res.json();
    },
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => {
    if (!data) return [];
    return unsentTodayRows(data.rows, data.dismissed ?? {}, londonDateOf(new Date()));
  }, [data]);

  const late = rows.length > 0 && londonHourNow() >= CUTOFF_HOUR_LONDON;
  const shown = rows.slice(0, 6);

  return (
    <Card className={late ? "border-accent-danger/40" : undefined}>
      <CardHeader>
        <WidgetHeader
          title="Invoices not sent yet today"
          count={rows.length}
          link="/invoicing"
          linkLabel="Today"
        />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="h-6 rounded bg-subtle animate-pulse" />
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load today's shipments.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">Everything shipped today has been invoiced.</div>
        ) : (
          <>
            {late && (
              <div className="mb-2 text-xs text-accent-danger">
                Past the {CUTOFF_HOUR_LONDON}am cutoff — send these so customers don't get a same-day backlog.
              </div>
            )}
            <ul className="divide-y divide-default">
              {shown.map((r) => {
                const customer =
                  r.qbInvoice?.customerName ?? r.parsed.endCustomerName ?? r.shopifyOrder?.customerEmail ?? r.emailSubject;
                const ref = r.qbInvoice?.docNumber
                  ? `Inv ${r.qbInvoice.docNumber}`
                  : r.parsed.shopifyOrderNumber
                    ? `Order ${r.parsed.shopifyOrderNumber}`
                    : r.shopifyOrder
                      ? `Order ${r.shopifyOrder.orderNumber}`
                      : "—";
                const lines = r.qbInvoice ? null : r.parsed.lineItems.length;
                const gap = r.unparsedRows.length > 0;
                const time = r.receivedAt
                  ? new Date(r.receivedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })
                  : "";
                return (
                  <li key={r.gmailId} className="py-2 first:pt-0 last:pb-0">
                    <Link
                      to="/invoicing/$gmailId"
                      params={{ gmailId: r.gmailId }}
                      className="flex items-center justify-between gap-2 text-sm hover:text-accent-info"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-primary truncate">{customer}</div>
                        <div className="text-xs text-muted">
                          {ref} · shipped {time}
                          {lines != null && ` · ${lines} line${lines === 1 ? "" : "s"}`}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {gap && (
                          <span className="rounded bg-accent-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-accent-warning">
                            parse gap
                          </span>
                        )}
                        {r.qbInvoice && (
                          <span className="text-xs tabular-nums text-primary">{money.format(r.qbInvoice.totalAmt)}</span>
                        )}
                        <span className="rounded bg-accent-primary px-2 py-0.5 text-[11px] font-medium text-white">
                          {r.qbInvoice ? "Send" : "Invoice"}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {rows.length > shown.length && (
              <div className="mt-2 text-xs text-muted">+ {rows.length - shown.length} more on Today</div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
