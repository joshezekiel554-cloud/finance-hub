// Finance's money signals for the hub's "Chief of Staff" panel (phase 1,
// plan agreed on the radio 2026-11-19). GET /api/ext/signals serves these.
//
// Plain database checks only — no AI. The hub collects every 30 minutes,
// de-dupes by `key` and decides what the AI words/ranks. Finance owns every
// nudge about money (it knows when a customer paid quietly without replying);
// the inbox owns other conversations and skips threads our chases started.
//
// Signals (one row per thing that needs Josh/Shaya):
//   finance.chase-no-reply — the customer's latest chase email (L1-L3) is
//     5+ calendar days old (the hub applies the 7-working-day rule), no email
//     from them since, no payment since, balance ≥ $50.
//   finance.promise-missed — a held order's "promised to pay by" date
//     (hold-ladder pause) has passed and the order is still on hold.
//
// Pure builders are exported for tests; loadFinanceSignals does the queries.

import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { activities } from "../../db/schema/crm.js";
import { customers } from "../../db/schema/customers.js";
import { payments } from "../../db/schema/payments.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "hub-signals" });

export const SIGNAL_RULES = {
  /**
   * Calendar-day floor before a quiet chase is sent as a candidate. The hub
   * owns working days and applies the operator's 7-working-day rule.
   */
  chaseQuietDays: 5,
  /** Balances below this are ignored (operator decision, $50 / £50). */
  minBalance: 50,
  /**
   * How far back to look for a customer's LATEST chase. Long on purpose: a
   * customer chased months ago and silent ever since is the worst case, not
   * one to age out (alice review). Replies/payments are bounded by the chase.
   */
  chaseLookbackDays: 365,
};

// The hub's pinned signal contract (alice2, 2026-11-19).
export type SignalLink = { label: string; url: string };

export type Signal = {
  key: string; // ≤200 chars, [A-Za-z0-9._:-], "finance." prefix
  kind: "chase-no-reply" | "promise-missed";
  severity: "high" | "medium" | "info";
  title: string; // ≤160
  detail?: string; // ≤400
  since: string; // ISO time the clock started
  customer: { id: string; name: string };
  amount: { value: number; currency: "USD" };
  links: SignalLink[]; // 1-5, absolute https on finance's origin
  dedupe: string; // "customer:<id>"
};

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const safeKey = (s: string) => s.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 200);

const DAY_MS = 86_400_000;

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

// ---------------------------------------------------------------------------
// chase-no-reply
// ---------------------------------------------------------------------------

export type ChaseFacts = {
  activityId: string;
  customerId: string;
  customerName: string;
  chasedAt: Date;
  level: number | null;
  /** Gmail message id of the chase email, when recorded. */
  messageId: string | null;
  subject: string | null;
  balance: number;
  lastInboundAt: Date | null;
  lastPaymentDate: Date | null; // payments.txn_date
};

export function buildChaseSignals(
  rows: ChaseFacts[],
  ctx: { now: Date; baseUrl: string },
): Signal[] {
  const out: Signal[] = [];
  for (const r of rows) {
    const days = daysBetween(r.chasedAt, ctx.now);
    if (days < SIGNAL_RULES.chaseQuietDays) continue;
    if (r.balance < SIGNAL_RULES.minBalance) continue;
    if (r.lastInboundAt && r.lastInboundAt.getTime() >= r.chasedAt.getTime()) continue;
    // Payment dates are calendar dates: a payment dated the same day as the
    // chase counts as "since" (it may have crossed with the email).
    if (r.lastPaymentDate && ymd(r.lastPaymentDate) >= ymd(r.chasedAt)) continue;

    const level = r.level ?? 1;
    out.push({
      key: safeKey(`finance.chase-no-reply.${r.customerId}.${r.messageId ?? r.activityId}`),
      kind: "chase-no-reply",
      severity: level >= 2 ? "high" : "medium",
      title: clip(`${r.customerName}: level ${level} chase sent ${ymd(r.chasedAt)}, no reply and no payment (${usd(r.balance)} open)`, 160),
      detail: clip(
        `${r.subject ? `Chase email: "${r.subject}". ` : ""}No reply from the customer's linked email addresses and no payment recorded since.`,
        400,
      ),
      since: r.chasedAt.toISOString(),
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.balance, currency: "USD" },
      links: [
        { label: `${r.customerName} in finance (${usd(r.balance)} open)`, url: `${ctx.baseUrl}/customers/${r.customerId}` },
        { label: "Chase queue", url: `${ctx.baseUrl}/chase` },
      ],
      dedupe: `customer:${r.customerId}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// promise-missed
// ---------------------------------------------------------------------------

export type PromiseFacts = {
  orderId: string;
  orderNumber: string | null;
  customerId: string;
  customerName: string;
  promisedBy: Date;
  note: string | null;
  balance: number;
};

export function buildPromiseSignals(
  rows: PromiseFacts[],
  ctx: { now: Date; baseUrl: string },
): Signal[] {
  // One signal per customer + promise date, even if several held orders
  // carry the same promise.
  const seen = new Set<string>();
  const out: Signal[] = [];
  for (const r of rows) {
    // The promise covers the whole promised day: "pay by Friday" first
    // counts as missed on Saturday, not Friday morning (alice review).
    if (ymd(r.promisedBy) >= ymd(ctx.now)) continue;
    if (r.balance < SIGNAL_RULES.minBalance) continue;
    const key = safeKey(`finance.promise-missed.${r.customerId}.${ymd(r.promisedBy)}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      kind: "promise-missed",
      severity: "high",
      // Worded as what finance knows for sure: the date passed and the order
      // is still held. A late payment nobody released the hold for still
      // reads true (alice review).
      title: clip(`${r.customerName}: promised payment by ${ymd(r.promisedBy)}, date passed and order still on hold (${usd(r.balance)} open)`, 160),
      detail: clip(`Order ${r.orderNumber ?? "?"} is still on hold${r.note ? `; promise note: "${r.note}"` : ""}. Check whether payment arrived and release the hold, or chase.`, 400),
      since: r.promisedBy.toISOString(),
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.balance, currency: "USD" },
      links: [{ label: `${r.customerName} in finance (order ${r.orderNumber ?? "?"} on hold)`, url: `${ctx.baseUrl}/customers/${r.customerId}` }],
      dedupe: `customer:${r.customerId}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const toNum = (v: string | number | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const toDate = (v: Date | string | null | undefined): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(v);

async function loadChaseFacts(now: Date): Promise<ChaseFacts[]> {
  const since = new Date(now.getTime() - SIGNAL_RULES.chaseLookbackDays * DAY_MS);
  const chases = await db
    .select({
      id: activities.id,
      customerId: activities.customerId,
      occurredAt: activities.occurredAt,
      subject: activities.subject,
      meta: activities.meta,
    })
    .from(activities)
    .where(
      and(
        eq(activities.kind, "email_out"),
        eq(activities.refType, "chase_email"),
        isNotNull(activities.customerId),
        gte(activities.occurredAt, since),
      ),
    );

  // Latest chase per customer.
  const latest = new Map<string, (typeof chases)[number]>();
  for (const c of chases) {
    if (!c.customerId) continue;
    const prev = latest.get(c.customerId);
    if (!prev || toDate(c.occurredAt)!.getTime() > toDate(prev.occurredAt)!.getTime()) latest.set(c.customerId, c);
  }
  const ids = Array.from(latest.keys());
  if (ids.length === 0) return [];
  // Replies/payments only matter from the earliest of these latest chases on;
  // the builder then compares each customer against their own chase date.
  const fromMs = Math.min(...Array.from(latest.values(), (c) => toDate(c.occurredAt)!.getTime()));
  const fromDay = new Date(`${ymd(new Date(fromMs))}T00:00:00.000Z`);

  const [custRows, inboundRows, paymentRows] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.displayName, balance: customers.balance })
      .from(customers)
      .where(inArray(customers.id, ids)),
    db
      .select({ customerId: activities.customerId, last: sql<Date | string>`MAX(${activities.occurredAt})` })
      .from(activities)
      .where(and(eq(activities.kind, "email_in"), inArray(activities.customerId, ids), gte(activities.occurredAt, fromDay)))
      .groupBy(activities.customerId),
    db
      .select({ customerId: payments.customerId, last: sql<Date | string>`MAX(${payments.txnDate})` })
      .from(payments)
      // txn_date ≤ today: the sync uses 2030-01-01 placeholders on some rows.
      .where(and(inArray(payments.customerId, ids), gte(payments.txnDate, fromDay), lt(payments.txnDate, new Date(now.getTime() + DAY_MS))))
      .groupBy(payments.customerId),
  ]);

  const cust = new Map(custRows.map((c) => [c.id, c]));
  const inbound = new Map(inboundRows.map((r) => [r.customerId, toDate(r.last)]));
  const paid = new Map(paymentRows.map((r) => [r.customerId, toDate(r.last)]));

  const out: ChaseFacts[] = [];
  for (const [customerId, c] of latest) {
    const cu = cust.get(customerId);
    if (!cu) continue;
    const meta = (c.meta ?? {}) as { level?: unknown; messageId?: unknown };
    out.push({
      activityId: c.id,
      customerId,
      customerName: cu.name,
      chasedAt: toDate(c.occurredAt)!,
      level: typeof meta.level === "number" ? meta.level : null,
      messageId: typeof meta.messageId === "string" ? meta.messageId : null,
      subject: c.subject,
      balance: toNum(cu.balance),
      lastInboundAt: inbound.get(customerId) ?? null,
      lastPaymentDate: paid.get(customerId) ?? null,
    });
  }
  return out;
}

async function loadPromiseFacts(): Promise<PromiseFacts[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      promisedBy: orders.holdLadderPausedUntil,
      note: orders.holdLadderPauseNote,
      customerName: customers.displayName,
      balance: customers.balance,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.holdState, "on_hold"), isNotNull(orders.holdLadderPausedUntil)));
  return rows
    .filter((r) => r.customerId && r.promisedBy)
    .map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber === null || r.orderNumber === undefined ? null : String(r.orderNumber),
      customerId: r.customerId as string,
      customerName: r.customerName,
      promisedBy: toDate(r.promisedBy)!,
      note: r.note,
      balance: toNum(r.balance),
    }));
}

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const;

export function sortSignals(signals: Signal[]): Signal[] {
  return [...signals].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      // promises first within a severity (operator: "most important")
      (a.kind === b.kind ? 0 : a.kind === "promise-missed" ? -1 : 1) ||
      b.amount.value - a.amount.value,
  );
}

export async function loadFinanceSignals(ctx: { now: Date; baseUrl: string }): Promise<{
  signals: Signal[];
  errors: string[];
}> {
  const errors: string[] = [];
  const [chase, promise] = await Promise.all([
    loadChaseFacts(ctx.now).catch((err: unknown) => {
      errors.push("chase-no-reply"); log.warn({ err }, "signals: chase-no-reply check failed");
      return [] as ChaseFacts[];
    }),
    loadPromiseFacts().catch((err: unknown) => {
      errors.push("promise-missed"); log.warn({ err }, "signals: promise-missed check failed");
      return [] as PromiseFacts[];
    }),
  ]);
  return {
    signals: sortSignals([...buildPromiseSignals(promise, ctx), ...buildChaseSignals(chase, ctx)]),
    errors,
  };
}
