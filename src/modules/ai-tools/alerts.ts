// GET /api/ext/alerts — finance's checks for the hub scheduler (roadmap #1,
// contract from alice-ops 2026-11-04):
//   {alerts:[{id, severity:"high"|"medium"|"info", title, count,
//             items:[{label, detail?, link?}], link?}], checkedAt}
// `id` is stable per condition so the hub can dedupe and push only when an
// alert is new or worse. Only conditions that need a person are returned;
// a quiet book returns an empty list. Each check is isolated — one failing
// query degrades to a "check failed" info alert instead of a 500.

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { syncRuns } from "../../db/schema/audit.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { extensivReceipts } from "../../db/schema/returns.js";
import { getOverdueCustomers } from "../chase/lookups.js";
import { loadEmailReview } from "../invoice-email-review/load.js";
import { money } from "../reports/table.js";
import { AWAITING_PARCEL_STATUSES, loadRmas } from "./ops-tools.js";

export type AlertItem = { label: string; detail?: string; link?: string };
export type Alert = {
  id: string;
  severity: "high" | "medium" | "info";
  title: string;
  count: number;
  items: AlertItem[];
  link?: string;
};

const DAY_MS = 86_400_000;
const MAX_ITEMS = 10;
const usd = (n: number) => `$${money(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysSince = (d: Date | string | null, now: Date) =>
  d ? Math.floor((now.getTime() - new Date(d).getTime()) / DAY_MS) : null;

// Thresholds — kept here so the hub/Josh can ask "why did this fire".
export const ALERT_RULES = {
  rmaNoTrackingDays: 7,
  rmaReceivedOpenDays: 5,
  receiptWaitingDays: 3,
  qbSyncStaleHours: 2,
  heldOrderNewHours: 24,
};

type Ctx = { now: Date; baseUrl: string };

async function criticalChase({ baseUrl }: Ctx): Promise<Alert | null> {
  const crit = (await getOverdueCustomers())
    .filter((o) => o.severity.tier === "CRITICAL")
    .sort((a, b) => b.severity.score - a.severity.score);
  if (crit.length === 0) return null;
  return {
    id: "finance.chase-critical",
    severity: "high",
    title: `${crit.length} customer${crit.length === 1 ? "" : "s"} in the CRITICAL chase tier`,
    count: crit.length,
    items: crit.slice(0, MAX_ITEMS).map((o) => ({
      label: o.customer.displayName,
      detail: `${usd(o.severity.totalOverdue)} overdue, ${o.severity.daysOverdue} days`,
      link: `${baseUrl}/customers/${o.customerId}`,
    })),
    link: `${baseUrl}/chase`,
  };
}

async function invoiceDelivery({ now, baseUrl }: Ctx): Promise<Alert[]> {
  const r = await loadEmailReview(now);
  const out: Alert[] = [];
  const item = (x: (typeof r.deliveryFailed)[number]) => ({
    label: `Invoice ${x.docNumber ?? "?"} — ${x.customerName}`,
    detail: x.deliveryError ? `bounced: ${x.deliveryError}` : `QuickBooks status: ${x.emailStatus ?? "not emailed"}`,
    link: `${baseUrl}/customers/${x.customerId}`,
  });
  if (r.deliveryFailed.length) {
    out.push({
      id: "finance.invoice-email-bounced",
      severity: "high",
      title: `${r.deliveryFailed.length} invoice email${r.deliveryFailed.length === 1 ? "" : "s"} bounced`,
      count: r.deliveryFailed.length,
      items: r.deliveryFailed.slice(0, MAX_ITEMS).map(item),
      link: `${baseUrl}/invoicing`,
    });
  }
  if (r.neverEmailed.length) {
    out.push({
      id: "finance.invoice-never-emailed",
      severity: "medium",
      title: `${r.neverEmailed.length} invoice${r.neverEmailed.length === 1 ? "" : "s"} never emailed to the customer`,
      count: r.neverEmailed.length,
      items: r.neverEmailed.slice(0, MAX_ITEMS).map(item),
      link: `${baseUrl}/invoicing`,
    });
  }
  return out;
}

async function rmaAlerts({ now, baseUrl }: Ctx): Promise<Alert[]> {
  const out: Alert[] = [];
  const awaiting = (await loadRmas(AWAITING_PARCEL_STATUSES, {})).filter(
    (r) => !r.trackingNumber && (daysSince(r.approvedAt ?? r.createdAt, now) ?? 0) >= ALERT_RULES.rmaNoTrackingDays,
  );
  if (awaiting.length) {
    out.push({
      id: "finance.rma-no-tracking",
      severity: "medium",
      title: `${awaiting.length} RMA${awaiting.length === 1 ? "" : "s"} without return tracking for ${ALERT_RULES.rmaNoTrackingDays}+ days`,
      count: awaiting.length,
      items: awaiting.slice(0, MAX_ITEMS).map((r) => ({
        label: `RMA ${r.rmaNumber ?? "(unnumbered)"} — ${r.customer}`,
        detail: `${daysSince(r.approvedAt ?? r.createdAt, now)} days, ${usd(Number(r.totalValue))}`,
        link: `${baseUrl}/returns/${r.id}`,
      })),
      link: `${baseUrl}/returns`,
    });
  }
  const received = (await loadRmas(["received"], {})).filter(
    (r) => (daysSince(r.receivedAtWarehouseAt, now) ?? 0) >= ALERT_RULES.rmaReceivedOpenDays,
  );
  if (received.length) {
    out.push({
      id: "finance.rma-received-not-credited",
      severity: "medium",
      title: `${received.length} return${received.length === 1 ? "" : "s"} back at the warehouse ${ALERT_RULES.rmaReceivedOpenDays}+ days without a credit`,
      count: received.length,
      items: received.slice(0, MAX_ITEMS).map((r) => ({
        label: `RMA ${r.rmaNumber ?? "(unnumbered)"} — ${r.customer}`,
        detail: `received ${daysSince(r.receivedAtWarehouseAt, now)} days ago, ${usd(Number(r.totalValue))}`,
        link: `${baseUrl}/returns/${r.id}`,
      })),
      link: `${baseUrl}/returns`,
    });
  }
  return out;
}

async function unmatchedReceipts({ now, baseUrl }: Ctx): Promise<Alert | null> {
  const cutoff = new Date(now.getTime() - ALERT_RULES.receiptWaitingDays * DAY_MS);
  const rows = await db
    .select({ tx: extensivReceipts.txNumber, ref: extensivReceipts.refString, who: extensivReceipts.inferredCustomerName, at: extensivReceipts.classifiedAt })
    .from(extensivReceipts)
    .where(and(isNull(extensivReceipts.dismissedAt), isNull(extensivReceipts.confirmedAt), sql`${extensivReceipts.classifiedAt} <= ${cutoff}`))
    .orderBy(asc(extensivReceipts.classifiedAt));
  if (rows.length === 0) return null;
  return {
    id: "finance.receipts-unmatched",
    severity: "medium",
    title: `${rows.length} warehouse return receipt${rows.length === 1 ? "" : "s"} waiting to be matched or confirmed`,
    count: rows.length,
    items: rows.slice(0, MAX_ITEMS).map((r) => ({
      label: `Warehouse tx ${r.tx ?? "?"}${r.who ? ` — ${r.who}` : ""}`,
      detail: `${daysSince(r.at, now)} days waiting${r.ref ? `, ref ${r.ref}` : ""}`,
    })),
    link: `${baseUrl}/returns`,
  };
}

async function newHeldOrders({ now, baseUrl }: Ctx): Promise<Alert | null> {
  const since = new Date(now.getTime() - ALERT_RULES.heldOrderNewHours * 3_600_000);
  const rows = await db
    .select({ order: orders.orderNumber, total: orders.total, reason: orders.holdReason, customer: customers.displayName, customerId: orders.customerId })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.holdState, "on_hold"), gte(orders.holdStartedAt, since)));
  if (rows.length === 0) return null;
  return {
    id: "finance.orders-newly-held",
    severity: "info",
    title: `${rows.length} order${rows.length === 1 ? "" : "s"} put on hold in the last ${ALERT_RULES.heldOrderNewHours}h`,
    count: rows.length,
    items: rows.slice(0, MAX_ITEMS).map((r) => ({
      label: `Order ${r.order ?? "?"} — ${r.customer ?? "unknown customer"}`,
      detail: `${usd(Number(r.total ?? 0))}, ${(r.reason ?? "held").replace(/_/g, " ")}`,
      link: r.customerId ? `${baseUrl}/customers/${r.customerId}` : undefined,
    })),
    link: `${baseUrl}/`,
  };
}

type SyncRunRow = { status: string; startedAt: Date | string; completedAt: Date | string | null; errorMessage: string | null };

/**
 * QuickBooks sync health from sync_runs (NOT invoice timestamps — a quiet
 * run touches no invoice, which isn't a problem). HIGH when the latest run
 * failed or there's been no successful run for qbSyncStaleHours; MEDIUM when
 * a run has been "running" for over an hour. Pure, so it's easy to pin.
 */
export function syncHealthAlert(latest: SyncRunRow | null, lastOk: SyncRunRow | null, now: Date, baseUrl: string): Alert | null {
  const link = `${baseUrl}/settings`;
  if (!latest) {
    return { id: "finance.qb-sync-stale", severity: "high", title: "QuickBooks sync has never run", count: 1, items: [{ label: "No sync recorded" }], link };
  }
  if (latest.status === "failed") {
    return {
      id: "finance.qb-sync-failed",
      severity: "high",
      title: "The last QuickBooks sync failed — finance figures may be stale",
      count: 1,
      items: [{ label: `Started ${new Date(latest.startedAt).toISOString()}`, detail: (latest.errorMessage ?? "no error message").slice(0, 200) }],
      link,
    };
  }
  const okAt = lastOk ? new Date(lastOk.completedAt ?? lastOk.startedAt) : null;
  const hours = okAt ? (now.getTime() - okAt.getTime()) / 3_600_000 : Infinity;
  if (hours >= ALERT_RULES.qbSyncStaleHours) {
    return {
      id: "finance.qb-sync-stale",
      severity: "high",
      title: okAt ? `No successful QuickBooks sync for ${Math.floor(hours)}h — finance figures may be stale` : "No successful QuickBooks sync on record",
      count: 1,
      items: [{ label: okAt ? `Last good sync ${okAt.toISOString()}` : "No successful run", detail: `Latest run: ${latest.status}` }],
      link,
    };
  }
  if (latest.status === "running" && now.getTime() - new Date(latest.startedAt).getTime() > 3_600_000) {
    return {
      id: "finance.qb-sync-stuck",
      severity: "medium",
      title: "A QuickBooks sync has been running for over an hour",
      count: 1,
      items: [{ label: `Started ${new Date(latest.startedAt).toISOString()}` }],
      link,
    };
  }
  return null;
}

const QB_KINDS = ["qb_full", "qb_incremental"] as const;

async function qbSyncHealth({ now, baseUrl }: Ctx): Promise<Alert | null> {
  const cols = { status: syncRuns.status, startedAt: syncRuns.startedAt, completedAt: syncRuns.completedAt, errorMessage: syncRuns.errorMessage };
  const [[latest], [lastOk]] = await Promise.all([
    db.select(cols).from(syncRuns).where(inArray(syncRuns.kind, [...QB_KINDS])).orderBy(desc(syncRuns.startedAt)).limit(1),
    db
      .select(cols)
      .from(syncRuns)
      .where(and(inArray(syncRuns.kind, [...QB_KINDS]), inArray(syncRuns.status, ["ok", "partial"])))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1),
  ]);
  return syncHealthAlert(latest ?? null, lastOk ?? null, now, baseUrl);
}

const CHECKS: Array<{ name: string; run: (c: Ctx) => Promise<Alert | Alert[] | null> }> = [
  { name: "qb-sync", run: qbSyncHealth },
  { name: "chase", run: criticalChase },
  { name: "invoice-delivery", run: invoiceDelivery },
  { name: "rmas", run: rmaAlerts },
  { name: "receipts", run: unmatchedReceipts },
  { name: "held-orders", run: newHeldOrders },
];

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const;

export async function loadFinanceAlerts(ctx: Ctx): Promise<{ alerts: Alert[]; checkedAt: string }> {
  const results = await Promise.all(
    CHECKS.map(async (c): Promise<Alert[]> => {
      try {
        const r = await c.run(ctx);
        return r === null ? [] : Array.isArray(r) ? r : [r];
      } catch (err) {
        return [
          {
            id: `finance.check-failed.${c.name}`,
            severity: "info",
            title: `Finance couldn't run its "${c.name}" check`,
            count: 1,
            items: [{ label: err instanceof Error ? err.message.slice(0, 200) : "unknown error" }],
          },
        ];
      }
    }),
  );
  const alerts = results.flat().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);
  return { alerts, checkedAt: ctx.now.toISOString() };
}
