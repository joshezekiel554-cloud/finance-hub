// Torah Judaica wind-down aggregation — backs GET /api/chase/tj-winddown and
// the /chase TJ panel (origin-split-2 spec §1).
//
// One read returns the whole wind-down picture:
//   - exposure: Σ per-customer net TJ owed (each customer's open TJ invoices
//     INCLUDING disputeState='verifying' — money is owed regardless of the
//     dispute — netted by that customer's unapplied TJ credit via
//     computeOriginBalances, floored at 0).
//   - buckets: exposure aged by days overdue from dueDate (<90 / 90–180 /
//     >180, boundaries 90 and 180 fall in the middle bucket). Per-invoice net
//     balances, gross of customer credit (credit can't be attributed to a
//     single invoice, so bucket sums can slightly exceed netted exposure when
//     a customer holds credit). Due-today is NOT overdue (startOfDayUtc
//     convention, matching chase scoring); not-yet-due balances count toward
//     exposure but sit in no bucket.
//   - verifyingCount: open TJ invoices parked in disputeState='verifying'.
//   - deltaVs28d / baselineDate: exposure now vs the latest
//     tj_exposure_snapshots row dated ≤ today−28d (and that row's date, for a
//     precise "vs <date>" label); both null when no such row exists yet.
//     Snapshots are self-populating — reads upsert today's row (no cron),
//     throttled to one successful write per 15 minutes in-process.
//   - customers: panel rows with embedded per-invoice dispute data so the UI
//     expands client-side without a second fetch. Tier/daysOverdue reuse the
//     origin-scoped chase severity path (getOverdueCustomers("tj"), which
//     excludes verifying invoices — they're not actionable chase); customers
//     outside that set (verifying-only, or nothing past due yet) still get a
//     row at LOW so the dispute loop stays operable from the panel.

import { and, desc, eq, gt, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { invoices, type Invoice } from "../../db/schema/invoices.js";
import { tjExposureSnapshots } from "../../db/schema/tj-exposure-snapshots.js";
import { computeOriginBalances } from "./balances.js";
import { getOverdueCustomers, loadOriginCreditByCustomer } from "./lookups.js";
import { daysBetween, startOfDayUtc } from "./scoring.js";
import type { ChaseTier, OverdueCustomer } from "./types.js";

const DAY_MS = 1000 * 60 * 60 * 24;
const DELTA_LOOKBACK_DAYS = 28;

// Tier → dunning level, mirroring the chase_l*/tj_l* template ladder used by
// the AI draft path (CHASE_TIER_SLUG in ai-agent/voice.ts: MEDIUM→l1, HIGH→l2,
// CRITICAL→l3). LOW has no template of its own — a chase from the panel
// starts at the gentlest rung.
const TIER_LEVEL: Record<ChaseTier, 1 | 2 | 3> = {
  LOW: 1,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export type WinddownInvoice = {
  id: string;
  docNumber: string | null;
  balance: number;
  dueDate: string | null; // 'YYYY-MM-DD'
  daysOverdue: number;
  disputeState: Invoice["disputeState"];
  disputeClaimedAt: string | null; // ISO timestamp
  disputeNote: string | null;
};

export type WinddownDisputeChip = {
  invoiceId: string;
  docNumber: string | null;
  state: NonNullable<Invoice["disputeState"]>;
};

export type WinddownCustomer = {
  customerId: string;
  customerName: string;
  primaryEmail: string | null;
  netOwed: number;
  openCount: number;
  tier: ChaseTier;
  suggestedLevel: 1 | 2 | 3;
  daysOverdue: number;
  disputeChips: WinddownDisputeChip[];
  invoices: WinddownInvoice[];
};

export type TjWinddown = {
  exposure: number;
  deltaVs28d: number | null;
  // snap_date of the snapshot deltaVs28d was computed against, so the UI can
  // label "vs <date>" precisely. null whenever deltaVs28d is null.
  baselineDate: string | null;
  buckets: { b90: number; b180: number; bOver: number };
  verifyingCount: number;
  customers: WinddownCustomer[];
};

export type WinddownBaseline = { snapDate: string; exposure: number };

// Open TJ invoice + the customer identity the panel row needs, in one query.
export type TjInvoiceRow = {
  invoice: Invoice;
  customerName: string;
  primaryEmail: string | null;
};

// Test/injection seams — same pattern as digest.ts: every DB touchpoint is a
// replaceable loader so the aggregation logic is unit-testable without a DB.
export type WinddownDeps = {
  // TJ-scoped chase severity rows (excludes verifying; nets TJ credit).
  loadOverdue?: () => Promise<OverdueCustomer[]>;
  // ALL open TJ invoices (verifying included) joined to customer identity.
  loadTjInvoices?: () => Promise<TjInvoiceRow[]>;
  // Unapplied TJ credit per customer.
  loadTjCredit?: (customerIds: string[]) => Promise<Map<string, number>>;
  // Upsert today's exposure snapshot (idempotent same-day).
  upsertSnapshot?: (snapDate: string, exposure: number) => Promise<void>;
  // Latest snapshot dated ≤ cutoffDate (date + exposure), or null.
  loadDeltaSnapshot?: (cutoffDate: string) => Promise<WinddownBaseline | null>;
  now?: Date;
};

// In-process snapshot-write throttle. The endpoint is read-hot (the /chase TJ
// panel AND the customers-list TJ strip hit it), but the snapshot only needs
// day granularity — skip the upsert when one already succeeded for today's
// date within the last 15 minutes. Single pm2 process, so a module-level memo
// suffices. Recorded only after a successful write (a throw leaves it unset,
// so the next call retries).
const SNAPSHOT_UPSERT_TTL_MS = 15 * 60 * 1000;
let lastUpsert: { date: string; at: number } | null = null;

// Test seam — clears the throttle memo between unit tests.
export function resetSnapshotUpsertThrottle(): void {
  lastUpsert = null;
}

export async function getTjWinddown(
  deps: WinddownDeps = {},
): Promise<TjWinddown> {
  const now = deps.now ?? new Date();
  const today = startOfDayUtc(now);
  const loadOverdue = deps.loadOverdue ?? (() => getOverdueCustomers("tj"));
  const loadTjInvoices = deps.loadTjInvoices ?? loadTjInvoicesFromDb;
  const loadTjCredit =
    deps.loadTjCredit ?? ((ids: string[]) => loadOriginCreditByCustomer("tj", ids));
  const upsertSnapshot = deps.upsertSnapshot ?? upsertSnapshotInDb;
  const loadDeltaSnapshot = deps.loadDeltaSnapshot ?? loadDeltaSnapshotFromDb;

  const [overdueRows, invoiceRows] = await Promise.all([
    loadOverdue(),
    loadTjInvoices(),
  ]);

  const rowsByCustomer = new Map<string, TjInvoiceRow[]>();
  for (const row of invoiceRows) {
    if (parseMoney(row.invoice.balance) <= 0) continue; // query contract; defensive
    const list = rowsByCustomer.get(row.invoice.customerId);
    if (list) list.push(row);
    else rowsByCustomer.set(row.invoice.customerId, [row]);
  }

  const creditByCustomer = await loadTjCredit([...rowsByCustomer.keys()]);
  const overdueByCustomer = new Map(overdueRows.map((r) => [r.customerId, r]));

  const buckets = { b90: 0, b180: 0, bOver: 0 };
  let verifyingCount = 0;
  let exposure = 0;
  const customerRows: WinddownCustomer[] = [];

  for (const [customerId, rows] of rowsByCustomer) {
    const balances = computeOriginBalances(
      rows.map((r) => ({
        origin: "tj" as const,
        balance: r.invoice.balance,
        dueDate: r.invoice.dueDate,
      })),
      { feldart: 0, tj: creditByCustomer.get(customerId) ?? 0 },
      now,
      today,
    );
    const netOwed = balances.tj.balance;
    exposure += netOwed;

    const invoiceViews: WinddownInvoice[] = rows.map((r) => {
      const inv = r.invoice;
      const bal = parseMoney(inv.balance);
      const daysOverdue = invoiceDaysOverdue(inv.dueDate, today);

      if (inv.disputeState === "verifying") verifyingCount += 1;
      if (daysOverdue > 0) {
        if (daysOverdue < 90) buckets.b90 += bal;
        else if (daysOverdue <= 180) buckets.b180 += bal;
        else buckets.bOver += bal;
      }

      return {
        id: inv.id,
        docNumber: inv.docNumber,
        balance: round2(bal),
        dueDate: toIsoDate(inv.dueDate),
        daysOverdue,
        disputeState: inv.disputeState,
        disputeClaimedAt: inv.disputeClaimedAt
          ? new Date(inv.disputeClaimedAt).toISOString()
          : null,
        disputeNote: inv.disputeNote,
      };
    });
    // Oldest first — the natural reading order for a wind-down list.
    invoiceViews.sort((a, b) =>
      (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99"),
    );

    const severity = overdueByCustomer.get(customerId)?.severity;
    const tier: ChaseTier = severity?.tier ?? "LOW";
    const first = rows[0];
    if (!first) continue; // unreachable: rowsByCustomer values are non-empty

    customerRows.push({
      customerId,
      customerName: first.customerName,
      primaryEmail: first.primaryEmail,
      netOwed,
      openCount: rows.length,
      tier,
      suggestedLevel: TIER_LEVEL[tier],
      daysOverdue: severity?.daysOverdue ?? 0,
      disputeChips: invoiceViews
        .filter(
          (i): i is WinddownInvoice & { disputeState: WinddownDisputeChip["state"] } =>
            i.disputeState != null,
        )
        .map((i) => ({ invoiceId: i.id, docNumber: i.docNumber, state: i.disputeState })),
      invoices: invoiceViews,
    });
  }

  // Actionable accounts first (severity score desc, the chase-queue order);
  // unscored rows (verifying-only / nothing past due) after, biggest first.
  const scoreOf = (c: WinddownCustomer): number =>
    overdueByCustomer.get(c.customerId)?.severity.score ?? -1;
  customerRows.sort(
    (a, b) =>
      scoreOf(b) - scoreOf(a) ||
      b.netOwed - a.netOwed ||
      a.customerName.localeCompare(b.customerName),
  );

  exposure = round2(exposure);

  // Self-populating history: write today's figure (throttled — see memo
  // above), then read the comparison point. Order matters only in principle —
  // the cutoff is strictly in the past, so today's upsert can never be its
  // own baseline.
  const snapDate = isoDate(today);
  const nowMs = now.getTime();
  if (
    lastUpsert == null ||
    lastUpsert.date !== snapDate ||
    nowMs - lastUpsert.at >= SNAPSHOT_UPSERT_TTL_MS
  ) {
    await upsertSnapshot(snapDate, exposure);
    lastUpsert = { date: snapDate, at: nowMs };
  }
  const cutoff = isoDate(new Date(today.getTime() - DELTA_LOOKBACK_DAYS * DAY_MS));
  const baseline = await loadDeltaSnapshot(cutoff);
  const deltaVs28d = baseline == null ? null : round2(exposure - baseline.exposure);

  return {
    exposure,
    deltaVs28d,
    baselineDate: baseline == null ? null : baseline.snapDate,
    buckets: {
      b90: round2(buckets.b90),
      b180: round2(buckets.b180),
      bOver: round2(buckets.bOver),
    },
    verifyingCount,
    customers: customerRows,
  };
}

// ---------- default DB loaders ----------

async function loadTjInvoicesFromDb(): Promise<TjInvoiceRow[]> {
  return db
    .select({
      invoice: invoices,
      customerName: customers.displayName,
      primaryEmail: customers.primaryEmail,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(eq(invoices.origin, "tj"), gt(invoices.balance, "0")));
}

async function upsertSnapshotInDb(
  snapDate: string,
  exposure: number,
): Promise<void> {
  const value = exposure.toFixed(2);
  await db
    .insert(tjExposureSnapshots)
    .values({ snapDate, exposure: value })
    .onDuplicateKeyUpdate({ set: { exposure: value } });
}

async function loadDeltaSnapshotFromDb(
  cutoffDate: string,
): Promise<WinddownBaseline | null> {
  const rows = await db
    .select()
    .from(tjExposureSnapshots)
    .where(lte(tjExposureSnapshots.snapDate, cutoffDate))
    .orderBy(desc(tjExposureSnapshots.snapDate))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const n = Number(row.exposure);
  return Number.isFinite(n) ? { snapDate: row.snapDate, exposure: n } : null;
}

// ---------- date/money helpers (chase-module conventions) ----------

function invoiceDaysOverdue(
  dueDate: Date | string | null,
  today: Date,
): number {
  if (!dueDate) return 0;
  const due = startOfDayUtc(toDate(dueDate));
  // due === today ⇒ NOT overdue (consistent with scoring.ts).
  if (due.getTime() >= today.getTime()) return 0;
  return daysBetween(due, today);
}

function toDate(v: string | Date): Date {
  if (v instanceof Date) return v;
  // Drizzle date columns serialize as 'YYYY-MM-DD'; construct UTC to keep
  // date-only semantics (mirrors scoring.ts).
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return new Date(v);
}

function toIsoDate(v: Date | string | null): string | null {
  if (v == null) return null;
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseMoney(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
