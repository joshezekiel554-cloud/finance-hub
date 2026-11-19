// Finance's money signals for the hub's "Chief of Staff" panel (phase 1,
// plan agreed on the radio 2026-11-19). GET /api/ext/signals serves these.
//
// Plain database checks only — no AI. The hub collects every 30 minutes,
// de-dupes by `key` and decides what the AI words/ranks. Finance owns every
// nudge about money (it knows when a customer paid quietly without replying);
// the inbox owns other conversations and skips threads our chases started.
//
// Signals (one row per thing that needs Josh/Shaya):
//   finance.chase-no-response — the customer's latest chase email (L1-L3) is
//     7+ days old, no email from them since, no payment since, balance ≥ $50.
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

export const SIGNAL_RULES = {
  /** Days after a chase email with no reply and no payment before we nudge. */
  chaseQuietDays: 7,
  /** Balances below this are ignored (operator decision, $50 / £50). */
  minBalance: 50,
  /** Only the latest chase within this window is considered. */
  chaseLookbackDays: 60,
};

export type SignalEvidence = { label: string; link?: string };

export type Signal = {
  key: string;
  kind: "chase-no-response" | "promise-missed";
  severity: "high" | "medium" | "info";
  title: string;
  since: string; // YYYY-MM-DD
  customer: { name: string; id: string };
  amount: { value: number; currency: "USD" };
  evidence: SignalEvidence[];
  actions: Array<"open" | "draft-follow-up">;
  audience: string[];
};

const DAY_MS = 86_400_000;

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

const gmailThreadLink = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

// ---------------------------------------------------------------------------
// chase-no-response
// ---------------------------------------------------------------------------

export type ChaseFacts = {
  activityId: string;
  customerId: string;
  customerName: string;
  chasedAt: Date;
  level: number | null;
  threadId: string | null;
  subject: string | null;
  balance: number;
  lastInboundAt: Date | null;
  lastPaymentDate: Date | null; // payments.txn_date
};

export function buildChaseSignals(
  rows: ChaseFacts[],
  ctx: { now: Date; baseUrl: string; audience: string[] },
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
    const evidence: SignalEvidence[] = [
      {
        label: `Level ${level} chase sent ${ymd(r.chasedAt)}${r.subject ? `: "${r.subject}"` : ""}`,
        ...(r.threadId ? { link: gmailThreadLink(r.threadId) } : {}),
      },
      { label: `Customer in finance (${usd(r.balance)} open)`, link: `${ctx.baseUrl}/customers/${r.customerId}` },
    ];
    out.push({
      key: `finance.chase-no-response.${r.customerId}.${r.activityId}`,
      kind: "chase-no-response",
      severity: level >= 2 ? "high" : "medium",
      title: `${r.customerName}: level ${level} chase sent ${days} days ago, no reply and no payment (${usd(r.balance)} open)`,
      since: ymd(r.chasedAt),
      customer: { name: r.customerName, id: r.customerId },
      amount: { value: r.balance, currency: "USD" },
      evidence,
      actions: ["open", "draft-follow-up"],
      audience: ctx.audience,
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
  ctx: { now: Date; baseUrl: string; audience: string[] },
): Signal[] {
  // One signal per customer + promise date, even if several held orders
  // carry the same promise.
  const seen = new Set<string>();
  const out: Signal[] = [];
  for (const r of rows) {
    if (r.promisedBy.getTime() >= ctx.now.getTime()) continue;
    if (r.balance < SIGNAL_RULES.minBalance) continue;
    const key = `finance.promise-missed.${r.customerId}.${ymd(r.promisedBy)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      kind: "promise-missed",
      severity: "high",
      title: `${r.customerName} promised payment by ${ymd(r.promisedBy)}${r.note ? ` ("${r.note}")` : ""}; still unpaid (${usd(r.balance)} open)`,
      since: ymd(r.promisedBy),
      customer: { name: r.customerName, id: r.customerId },
      amount: { value: r.balance, currency: "USD" },
      evidence: [
        {
          label: `Order ${r.orderNumber ?? "?"} on hold, payment promised by ${ymd(r.promisedBy)}`,
          link: `${ctx.baseUrl}/customers/${r.customerId}`,
        },
      ],
      actions: ["open", "draft-follow-up"],
      audience: ctx.audience,
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

  const [custRows, inboundRows, paymentRows] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.displayName, balance: customers.balance })
      .from(customers)
      .where(inArray(customers.id, ids)),
    db
      .select({ customerId: activities.customerId, last: sql<Date | string>`MAX(${activities.occurredAt})` })
      .from(activities)
      .where(and(eq(activities.kind, "email_in"), inArray(activities.customerId, ids), gte(activities.occurredAt, since)))
      .groupBy(activities.customerId),
    db
      .select({ customerId: payments.customerId, last: sql<Date | string>`MAX(${payments.txnDate})` })
      .from(payments)
      // txn_date ≤ today: the sync uses 2030-01-01 placeholders on some rows.
      .where(and(inArray(payments.customerId, ids), gte(payments.txnDate, since), lt(payments.txnDate, new Date(now.getTime() + DAY_MS))))
      .groupBy(payments.customerId),
  ]);

  const cust = new Map(custRows.map((c) => [c.id, c]));
  const inbound = new Map(inboundRows.map((r) => [r.customerId, toDate(r.last)]));
  const paid = new Map(paymentRows.map((r) => [r.customerId, toDate(r.last)]));

  const out: ChaseFacts[] = [];
  for (const [customerId, c] of latest) {
    const cu = cust.get(customerId);
    if (!cu) continue;
    const meta = (c.meta ?? {}) as { level?: unknown; threadId?: unknown };
    out.push({
      activityId: c.id,
      customerId,
      customerName: cu.name,
      chasedAt: toDate(c.occurredAt)!,
      level: typeof meta.level === "number" ? meta.level : null,
      threadId: typeof meta.threadId === "string" ? meta.threadId : null,
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

export async function loadFinanceSignals(ctx: { now: Date; baseUrl: string; audience: string[] }): Promise<{
  signals: Signal[];
  errors: string[];
}> {
  const errors: string[] = [];
  const [chase, promise] = await Promise.all([
    loadChaseFacts(ctx.now).catch((err: unknown) => {
      errors.push(`chase-no-response: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
      return [] as ChaseFacts[];
    }),
    loadPromiseFacts().catch((err: unknown) => {
      errors.push(`promise-missed: ${err instanceof Error ? err.message.slice(0, 200) : "failed"}`);
      return [] as PromiseFacts[];
    }),
  ]);
  return {
    signals: sortSignals([...buildPromiseSignals(promise, ctx), ...buildChaseSignals(chase, ctx)]),
    errors,
  };
}
