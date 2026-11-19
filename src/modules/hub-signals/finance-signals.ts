// Finance's money signals for the hub's "Chief of Staff" panel (phase 1 plan
// agreed on the radio 2026-11-19; phase 2 contract pinned by alice2 the same
// day). GET /api/ext/signals serves these.
//
// Plain database reads only — the request never calls a model. The hub
// collects every 30 minutes, de-dupes by `key` and decides what the AI
// words/ranks. Finance owns every nudge about money (it knows when a customer
// paid quietly without replying); the inbox owns other conversations and
// skips threads our chases started.
//
// Signals (one row per thing that needs Josh/Shaya):
//   finance.chase-no-reply — the customer's latest chase email (L1-L3) is
//     5+ calendar days old (the hub applies the 7-working-day rule), no email
//     from them since, no payment since, balance ≥ $50, no active promise.
//   finance.promise-missed — a promise-to-pay date has passed: either the
//     customer-level promise (customers.promised_pay_by) with no payment
//     since it was made, or a held order's hold-ladder pause date with the
//     order still on hold. One signal per customer + date.
//   finance.promise-suggested — the promise extractor (promises/
//     promise-extractor.ts, run after each Gmail poll) read a payment date in
//     a recent customer email and nobody has saved a promise since.
//
// Pure builders are exported for tests; loadFinanceSignals does the queries.

import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { activities } from "../../db/schema/crm.js";
import { customers } from "../../db/schema/customers.js";
import { payments } from "../../db/schema/payments.js";
import { promiseScans } from "../../db/schema/promise-scans.js";
import { createLogger } from "../../lib/logger.js";
import { SIGNAL_MIN_BALANCE } from "../promises/constants.js";
import { isPromiseActive, newYorkYmd, todayYmd, toYmd, ymdDiffDays } from "../promises/promise-state.js";

const log = createLogger({ component: "hub-signals" });

export const SIGNAL_RULES = {
  /**
   * Calendar-day floor before a quiet chase is sent as a candidate. The hub
   * owns working days and applies the operator's 7-working-day rule.
   */
  chaseQuietDays: 5,
  /** Balances below this are ignored (operator decision, $50 / £50). */
  minBalance: SIGNAL_MIN_BALANCE,
  /**
   * How far back to look for a customer's LATEST chase. Long on purpose: a
   * customer chased months ago and silent ever since is the worst case, not
   * one to age out (alice review). Replies/payments are bounded by the chase.
   */
  chaseLookbackDays: 365,
  /** promise-suggested: only emails this recent count. */
  suggestionLookbackDays: 14,
};

// The hub's pinned signal contract (alice2, 2026-11-19; phase 2 adds
// `promise` on promise-suggested and optional `tags` on every signal).
export type SignalLink = { label: string; url: string };
export type SignalKind = "chase-no-reply" | "promise-missed" | "promise-suggested";
export type SignalTags = Record<string, string | number | boolean>;

export type Signal = {
  key: string; // ≤200 chars, [A-Za-z0-9._:-], "finance." prefix
  kind: SignalKind;
  severity: "high" | "medium" | "info";
  title: string; // ≤160
  detail?: string; // ≤400
  since: string; // ISO time the clock started
  customer: { id: string; name: string };
  amount: { value: number; currency: "USD" };
  links: SignalLink[]; // 1-5, absolute https on finance's origin
  dedupe: string; // "customer:<id>"
  /** promise-suggested only (required there). */
  promise?: { date: string; quote?: string };
  /** ≤8 entries, key ≤24 chars, string|number|boolean values. */
  tags?: SignalTags;
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

/** Coarse balance bucket for the hub's ranking (tags.balanceBand). */
export function balanceBand(n: number): string {
  if (n >= 10_000) return "10k+";
  if (n >= 2_000) return "2k-10k";
  if (n >= 500) return "500-2k";
  return "50-500";
}

// ---------------------------------------------------------------------------
// Contract check
// ---------------------------------------------------------------------------

/** Problems with a signal against the pinned contract ([] = fine). */
export function signalContractProblems(s: Signal, baseUrl: string): string[] {
  const p: string[] = [];
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(s.key) || !s.key.startsWith("finance.")) p.push("key");
  if (!s.title || s.title.length > 160) p.push("title");
  if (s.detail !== undefined && s.detail.length > 400) p.push("detail");
  if (!Number.isFinite(Date.parse(s.since))) p.push("since");
  if (s.links.length < 1 || s.links.length > 5) p.push("links");
  const origin = baseUrl.replace(/\/$/, "");
  for (const l of s.links) {
    if (!l.url.startsWith("https://") || !(l.url === origin || l.url.startsWith(`${origin}/`))) p.push("link-url");
  }
  if (s.dedupe !== `customer:${s.customer.id}`) p.push("dedupe");
  if (s.kind === "promise-suggested") {
    if (!s.promise || !/^\d{4}-\d{2}-\d{2}$/.test(s.promise.date)) p.push("promise");
    else if (s.promise.quote !== undefined && s.promise.quote.length > 200) p.push("promise-quote");
  } else if (s.promise !== undefined) {
    p.push("promise");
  }
  if (s.tags) {
    const entries = Object.entries(s.tags);
    if (entries.length > 8) p.push("tags");
    for (const [k, v] of entries) {
      if (k.length === 0 || k.length > 24) p.push("tag-key");
      if (!["string", "number", "boolean"].includes(typeof v)) p.push("tag-value");
    }
  }
  return p;
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
  /** customers.promised_pay_by — an active promise silences the nudge. */
  promisedPayBy?: string | null;
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
    // They've promised a date that hasn't passed yet — chasing is paused, so
    // "no reply" isn't news. promise-missed takes over once it passes.
    if (isPromiseActive(r.promisedPayBy, ctx.now)) continue;

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
      tags: { chaseLevel: level, balanceBand: balanceBand(r.balance), daysQuiet: days },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// promise-missed (held-order variant)
// ---------------------------------------------------------------------------

export type PromiseFacts = {
  orderId: string;
  orderNumber: string | null;
  customerId: string;
  customerName: string;
  /** orders.hold_ladder_paused_until — end of the promised day in New York. */
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
    // The pause runs to the end of the promised day in New York (the order
    // picker's convention), so the promised calendar day is the NY date —
    // a UTC reading of 03:59Z would land on the next day.
    const day = newYorkYmd(r.promisedBy);
    // The promise covers the whole promised day: "pay by Friday" first
    // counts as missed on Saturday, not Friday morning (alice review).
    if (day >= todayYmd(ctx.now)) continue;
    if (r.balance < SIGNAL_RULES.minBalance) continue;
    const key = safeKey(`finance.promise-missed.${r.customerId}.${day}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      kind: "promise-missed",
      severity: "high",
      // Worded as what finance knows for sure: the date passed and the order
      // is still held. A late payment nobody released the hold for still
      // reads true (alice review).
      title: clip(`${r.customerName}: promised payment by ${day}, date passed and order still on hold (${usd(r.balance)} open)`, 160),
      detail: clip(`Order ${r.orderNumber ?? "?"} is still on hold${r.note ? `; promise note: "${r.note}"` : ""}. Check whether payment arrived and release the hold, or chase.`, 400),
      since: r.promisedBy.toISOString(),
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.balance, currency: "USD" },
      links: [{ label: `${r.customerName} in finance (order ${r.orderNumber ?? "?"} on hold)`, url: `${ctx.baseUrl}/customers/${r.customerId}` }],
      dedupe: `customer:${r.customerId}`,
      tags: { variant: "held-order", balanceBand: balanceBand(r.balance), daysPast: ymdDiffDays(day, todayYmd(ctx.now)) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// promise-missed (customer-level promise)
// ---------------------------------------------------------------------------

export type CustomerPromiseFacts = {
  customerId: string;
  customerName: string;
  promisedBy: string; // YYYY-MM-DD
  note: string | null;
  setBy: string | null;
  setAt: Date | null;
  balance: number;
  /** Latest payments.txn_date on/after the day the promise was made. */
  lastPaymentDate: Date | null;
};

export function buildCustomerPromiseSignals(
  rows: CustomerPromiseFacts[],
  ctx: { now: Date; baseUrl: string },
): Signal[] {
  const out: Signal[] = [];
  const today = todayYmd(ctx.now);
  for (const r of rows) {
    if (r.promisedBy >= today) continue; // still active (covers the whole day)
    if (r.balance < SIGNAL_RULES.minBalance) continue;
    // A payment made after the promise was saved means they acted on it —
    // finance can't tell a part-payment from the whole, so it stays quiet
    // and lets the normal chase cadence take over.
    const madeOn = r.setAt ? ymd(r.setAt) : r.promisedBy;
    if (r.lastPaymentDate && ymd(r.lastPaymentDate) >= madeOn) continue;
    const by = r.setBy ? ` by ${r.setBy}` : "";
    out.push({
      key: safeKey(`finance.promise-missed.${r.customerId}.${r.promisedBy}`),
      kind: "promise-missed",
      severity: "high",
      title: clip(`${r.customerName}: promised payment by ${r.promisedBy}, no payment recorded since (${usd(r.balance)} open)`, 160),
      detail: clip(
        `Promise saved ${madeOn}${by}${r.note ? `; note: "${r.note}"` : ""}. No payment from this customer has reached QuickBooks since then. Automatic chasing has resumed.`,
        400,
      ),
      since: `${r.promisedBy}T23:59:59.000Z`,
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.balance, currency: "USD" },
      links: [{ label: `${r.customerName} in finance (${usd(r.balance)} open)`, url: `${ctx.baseUrl}/customers/${r.customerId}` }],
      dedupe: `customer:${r.customerId}`,
      tags: { variant: "customer", balanceBand: balanceBand(r.balance), daysPast: ymdDiffDays(r.promisedBy, today) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// promise-suggested
// ---------------------------------------------------------------------------

export type SuggestionFacts = {
  activityId: string;
  messageId: string | null;
  customerId: string;
  customerName: string;
  emailAt: Date;
  date: string; // YYYY-MM-DD the email promises
  quote: string | null;
  balance: number;
  promisedPayBy: string | null;
  promiseSetAt: Date | null;
  /** Latest payments.txn_date on/after the email's day. */
  lastPaymentDate: Date | null;
};

export function buildSuggestedSignals(
  rows: SuggestionFacts[],
  ctx: { now: Date; baseUrl: string },
): Signal[] {
  const today = todayYmd(ctx.now);
  const oldest = ctx.now.getTime() - SIGNAL_RULES.suggestionLookbackDays * DAY_MS;
  // Latest qualifying email per customer wins.
  const best = new Map<string, SuggestionFacts>();
  for (const r of rows) {
    if (r.emailAt.getTime() < oldest) continue;
    if (r.date < today) continue;
    if (r.balance < SIGNAL_RULES.minBalance) continue;
    if (isPromiseActive(r.promisedPayBy, ctx.now)) continue;
    // Someone already saved a promise after reading this email.
    if (r.promiseSetAt && r.promiseSetAt.getTime() >= r.emailAt.getTime()) continue;
    // They've paid since writing — nothing to promise any more.
    if (r.lastPaymentDate && ymd(r.lastPaymentDate) >= ymd(r.emailAt)) continue;
    const prev = best.get(r.customerId);
    if (!prev || r.emailAt.getTime() > prev.emailAt.getTime()) best.set(r.customerId, r);
  }
  const out: Signal[] = [];
  for (const r of best.values()) {
    const quote = r.quote ? clip(r.quote, 200) : undefined;
    out.push({
      key: safeKey(`finance.promise-suggested.${r.customerId}.${r.messageId ?? r.activityId}`),
      kind: "promise-suggested",
      severity: "medium",
      title: clip(`${r.customerName}: email of ${ymd(r.emailAt)} says payment by ${r.date} (${usd(r.balance)} open)`, 160),
      detail: clip(
        `${quote ? `They wrote: "${quote}". ` : ""}Picked up automatically from the customer's email; nothing is saved in finance until someone confirms the promise.`,
        400,
      ),
      since: r.emailAt.toISOString(),
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.balance, currency: "USD" },
      links: [{ label: `${r.customerName} in finance (${usd(r.balance)} open)`, url: `${ctx.baseUrl}/customers/${r.customerId}` }],
      dedupe: `customer:${r.customerId}`,
      promise: quote ? { date: r.date, quote } : { date: r.date },
      tags: { balanceBand: balanceBand(r.balance), daysUntil: ymdDiffDays(today, r.date) },
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

/** Latest payment txn_date per customer, from `fromDay` up to today. */
async function lastPayments(ids: string[], fromDay: Date, now: Date): Promise<Map<string, Date | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ customerId: payments.customerId, last: sql<Date | string>`MAX(${payments.txnDate})` })
    .from(payments)
    // txn_date ≤ today: the sync uses 2030-01-01 placeholders on some rows.
    .where(and(inArray(payments.customerId, ids), gte(payments.txnDate, fromDay), lt(payments.txnDate, new Date(now.getTime() + DAY_MS))))
    .groupBy(payments.customerId);
  return new Map(rows.map((r) => [r.customerId, toDate(r.last)]));
}

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

  const [custRows, inboundRows, paid] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.displayName, balance: customers.balance, promisedPayBy: customers.promisedPayBy })
      .from(customers)
      .where(inArray(customers.id, ids)),
    db
      .select({ customerId: activities.customerId, last: sql<Date | string>`MAX(${activities.occurredAt})` })
      .from(activities)
      .where(and(eq(activities.kind, "email_in"), inArray(activities.customerId, ids), gte(activities.occurredAt, fromDay)))
      .groupBy(activities.customerId),
    lastPayments(ids, fromDay, now),
  ]);

  const cust = new Map(custRows.map((c) => [c.id, c]));
  const inbound = new Map(inboundRows.map((r) => [r.customerId, toDate(r.last)]));

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
      promisedPayBy: toYmd(cu.promisedPayBy),
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

async function loadCustomerPromiseFacts(now: Date): Promise<CustomerPromiseFacts[]> {
  const rows = await db
    .select({
      id: customers.id,
      name: customers.displayName,
      balance: customers.balance,
      promisedPayBy: customers.promisedPayBy,
      note: customers.promiseNote,
      setBy: customers.promiseSetBy,
      setAt: customers.promiseSetAt,
    })
    .from(customers)
    .where(and(isNotNull(customers.promisedPayBy), lt(customers.promisedPayBy, todayYmd(now))));
  const facts = rows
    .map((r) => ({ ...r, promisedBy: toYmd(r.promisedPayBy), setAt: toDate(r.setAt) }))
    .filter((r): r is typeof r & { promisedBy: string } => r.promisedBy !== null);
  if (facts.length === 0) return [];
  const fromMs = Math.min(...facts.map((f) => (f.setAt ?? new Date(`${f.promisedBy}T00:00:00.000Z`)).getTime()));
  const paid = await lastPayments(facts.map((f) => f.id), new Date(`${ymd(new Date(fromMs))}T00:00:00.000Z`), now);
  return facts.map((f) => ({
    customerId: f.id,
    customerName: f.name,
    promisedBy: f.promisedBy,
    note: f.note,
    setBy: f.setBy,
    setAt: f.setAt,
    balance: toNum(f.balance),
    lastPaymentDate: paid.get(f.id) ?? null,
  }));
}

async function loadSuggestionFacts(now: Date): Promise<SuggestionFacts[]> {
  const since = new Date(now.getTime() - SIGNAL_RULES.suggestionLookbackDays * DAY_MS);
  const rows = await db
    .select({
      activityId: promiseScans.activityId,
      messageId: promiseScans.messageId,
      customerId: promiseScans.customerId,
      emailAt: promiseScans.emailAt,
      date: promiseScans.promisedDate,
      quote: promiseScans.quote,
      customerName: customers.displayName,
      balance: customers.balance,
      promisedPayBy: customers.promisedPayBy,
      promiseSetAt: customers.promiseSetAt,
    })
    .from(promiseScans)
    .innerJoin(customers, eq(customers.id, promiseScans.customerId))
    .where(
      and(
        eq(promiseScans.result, "promise"),
        gte(promiseScans.emailAt, since),
        isNotNull(promiseScans.promisedDate),
        gte(promiseScans.promisedDate, todayYmd(now)),
      ),
    );
  const facts = rows
    .map((r) => ({ ...r, date: toYmd(r.date), emailAt: toDate(r.emailAt)! }))
    .filter((r): r is typeof r & { date: string } => r.date !== null);
  if (facts.length === 0) return [];
  const fromMs = Math.min(...facts.map((f) => f.emailAt.getTime()));
  const paid = await lastPayments(
    Array.from(new Set(facts.map((f) => f.customerId))),
    new Date(`${ymd(new Date(fromMs))}T00:00:00.000Z`),
    now,
  );
  return facts.map((f) => ({
    activityId: f.activityId,
    messageId: f.messageId,
    customerId: f.customerId,
    customerName: f.customerName,
    emailAt: f.emailAt,
    date: f.date,
    quote: f.quote,
    balance: toNum(f.balance),
    promisedPayBy: toYmd(f.promisedPayBy),
    promiseSetAt: toDate(f.promiseSetAt),
    lastPaymentDate: paid.get(f.customerId) ?? null,
  }));
}

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const;
// Within a severity: promises first (operator: "most important").
const KIND_ORDER: Record<SignalKind, number> = { "promise-missed": 0, "chase-no-reply": 1, "promise-suggested": 2 };

export function sortSignals(signals: Signal[]): Signal[] {
  return [...signals].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.amount.value - a.amount.value,
  );
}

/** Keep the first signal per key (callers order by preference). */
export function dedupeByKey(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  return signals.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

export async function loadFinanceSignals(ctx: { now: Date; baseUrl: string }): Promise<{
  signals: Signal[];
  errors: string[];
}> {
  const errors: string[] = [];
  const fail = (name: string) => (err: unknown) => {
    if (!errors.includes(name)) errors.push(name);
    log.warn({ err }, `signals: ${name} check failed`);
    return [];
  };
  const [chase, promise, customerPromise, suggested] = await Promise.all([
    loadChaseFacts(ctx.now).catch(fail("chase-no-reply")) as Promise<ChaseFacts[]>,
    loadPromiseFacts().catch(fail("promise-missed")) as Promise<PromiseFacts[]>,
    loadCustomerPromiseFacts(ctx.now).catch(fail("promise-missed")) as Promise<CustomerPromiseFacts[]>,
    loadSuggestionFacts(ctx.now).catch(fail("promise-suggested")) as Promise<SuggestionFacts[]>,
  ]);
  const all = dedupeByKey([
    // The customer-level promise is the richer record; the held-order
    // variant with the same customer + date is dropped.
    ...buildCustomerPromiseSignals(customerPromise, ctx),
    ...buildPromiseSignals(promise, ctx),
    ...buildChaseSignals(chase, ctx),
    ...buildSuggestedSignals(suggested, ctx),
  ]);
  const valid = all.filter((s) => {
    const problems = signalContractProblems(s, ctx.baseUrl);
    if (problems.length > 0) log.warn({ key: s.key, problems }, "signals: dropped a signal that breaks the contract");
    return problems.length === 0;
  });
  return { signals: sortSignals(valid), errors };
}
