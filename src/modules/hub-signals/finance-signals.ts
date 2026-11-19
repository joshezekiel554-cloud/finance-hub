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
// Phase 3 ("it knows the story", 2026-11-19; story maths in hub-stories/):
//   finance.pay-slipping — ≥ 4 invoices paid in 2 years, the oldest overdue
//     invoice is now > 1.5× their usual days-to-pay AND ≥ usual + 20 days.
//     Re-arms monthly (key ends YYYY-MM). Skipped while a promise is active.
//   finance.big-order-overdue — a Shopify order ≥ $1,000 in the last 7 days
//     from a customer ≥ $500 overdue whose oldest overdue invoice is ≥ 30
//     days past due.
//   finance.reorder-due (sales) — a US B2B customer with ≥ 4 Feldart invoice
//     days in 2 years has gone > 1.5× their usual gap (and ≥ 14 days).
//   finance.season-missed (sales) — bought a season's SKUs in each of the
//     last 3 seasons but nothing yet this cycle (needs SKU_MAP_URL).
// Every signal carries customer.email (lower-cased) so the hub can join it
// to the customer's story; money signals also get tags payUsualDays and
// promiseRecord ("kept/resolved") when known.
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
import { SEASON_RULES, type SeasonMiss } from "../hub-stories/seasons.js";
import {
  addDaysYmd,
  buildBuying,
  isSlipping,
  type InvoiceDay,
  type Money,
  type PayBehaviour,
} from "../hub-stories/story.js";
import { loadStorySignalFacts } from "./story-signal-loads.js";

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
export type SignalKind =
  | "chase-no-reply"
  | "promise-missed"
  | "promise-suggested"
  | "pay-slipping"
  | "big-order-overdue"
  | "reorder-due"
  | "season-missed";

/** Money nudges (get payUsualDays / promiseRecord tags); the rest are sales. */
export const MONEY_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "chase-no-reply",
  "promise-missed",
  "promise-suggested",
  "pay-slipping",
  "big-order-overdue",
]);
export type SignalTags = Record<string, string | number | boolean>;

export type Signal = {
  key: string; // ≤200 chars, [A-Za-z0-9._:-], "finance." prefix
  kind: SignalKind;
  severity: "high" | "medium" | "info";
  title: string; // ≤160
  detail?: string; // ≤400
  since: string; // ISO time the clock started
  /** email: lower-cased primary (else first linked) address, when known. */
  customer: { id: string; name: string; email?: string };
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
  if (s.customer.email !== undefined) {
    const e = s.customer.email;
    if (e.length > 254 || e !== e.toLowerCase() || !/^[^\s@]+@[^\s@]+$/.test(e)) p.push("customer-email");
  }
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
      else if (typeof v === "string" && v.length > 60) p.push("tag-value");
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
  /**
   * Our latest money follow-up to this customer after the chase (a reply on
   * the chase thread or a payment/statement-type email — e.g. a draft sent
   * from the hub card). It restarts the clock: the card clears on send and
   * comes back only if they stay silent after it too (operator 2026-11-19).
   */
  followUp?: { at: Date; messageId: string | null; activityId: string; subject: string | null } | null;
};

export function buildChaseSignals(
  rows: ChaseFacts[],
  ctx: { now: Date; baseUrl: string },
): Signal[] {
  const out: Signal[] = [];
  for (const r of rows) {
    const fu = r.followUp && r.followUp.at.getTime() > r.chasedAt.getTime() ? r.followUp : null;
    const anchor = fu ? fu.at : r.chasedAt;
    const days = daysBetween(anchor, ctx.now);
    if (days < SIGNAL_RULES.chaseQuietDays) continue;
    if (r.balance < SIGNAL_RULES.minBalance) continue;
    if (r.lastInboundAt && r.lastInboundAt.getTime() >= anchor.getTime()) continue;
    // Payment dates are calendar dates: a payment dated the same day as the
    // chase counts as "since" (it may have crossed with the email).
    if (r.lastPaymentDate && ymd(r.lastPaymentDate) >= ymd(anchor)) continue;
    // They've promised a date that hasn't passed yet — chasing is paused, so
    // "no reply" isn't news. promise-missed takes over once it passes.
    if (isPromiseActive(r.promisedPayBy, ctx.now)) continue;

    const level = r.level ?? 1;
    const ref = fu ? (fu.messageId ?? fu.activityId) : (r.messageId ?? r.activityId);
    out.push({
      key: safeKey(`finance.chase-no-reply.${r.customerId}.${ref}`),
      kind: "chase-no-reply",
      severity: level >= 2 ? "high" : "medium",
      title: clip(
        fu
          ? `${r.customerName}: level ${level} chase ${ymd(r.chasedAt)}, followed up ${ymd(fu.at)}, still no reply or payment (${usd(r.balance)} open)`
          : `${r.customerName}: level ${level} chase sent ${ymd(r.chasedAt)}, no reply and no payment (${usd(r.balance)} open)`,
        160,
      ),
      detail: clip(
        `${r.subject ? `Chase email: "${r.subject}". ` : ""}${fu ? `Followed up ${ymd(fu.at)}${fu.subject ? ` ("${fu.subject}")` : ""}. ` : ""}No reply from the customer's linked email addresses and no payment recorded since.`,
        400,
      ),
      since: anchor.toISOString(),
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.balance, currency: "USD" },
      links: [
        { label: `${r.customerName} in finance (${usd(r.balance)} open)`, url: `${ctx.baseUrl}/customers/${r.customerId}` },
        { label: "Chase queue", url: `${ctx.baseUrl}/chase` },
      ],
      dedupe: `customer:${r.customerId}`,
      tags: { chaseLevel: level, balanceBand: balanceBand(r.balance), daysQuiet: days, followedUp: fu !== null },
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
    // Kept = the balance is under the $50 floor (checked above). A payment
    // since the promise that still leaves ≥ $50 open is a part-payment: say
    // so rather than going quiet (alice review — $20 of $3,600 isn't kept).
    const madeOn = r.setAt ? ymd(r.setAt) : r.promisedBy;
    const partPaid = r.lastPaymentDate !== null && ymd(r.lastPaymentDate) >= madeOn;
    const by = r.setBy ? ` by ${r.setBy}` : "";
    out.push({
      key: safeKey(`finance.promise-missed.${r.customerId}.${r.promisedBy}`),
      kind: "promise-missed",
      severity: "high",
      title: clip(
        partPaid
          ? `${r.customerName}: promised payment by ${r.promisedBy}, only part-paid since (${usd(r.balance)} still open)`
          : `${r.customerName}: promised payment by ${r.promisedBy}, no payment recorded since (${usd(r.balance)} open)`,
        160,
      ),
      detail: clip(
        `Promise saved ${madeOn}${by}${r.note ? `; note: "${r.note}"` : ""}. ${
          partPaid
            ? `A payment has reached QuickBooks since (latest ${ymd(r.lastPaymentDate!)}), but ${usd(r.balance)} is still open.`
            : "No payment from this customer has reached QuickBooks since then."
        } Automatic chasing has resumed.`,
        400,
      ),
      since: `${r.promisedBy}T23:59:59.000Z`,
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.balance, currency: "USD" },
      links: [{ label: `${r.customerName} in finance (${usd(r.balance)} open)`, url: `${ctx.baseUrl}/customers/${r.customerId}` }],
      dedupe: `customer:${r.customerId}`,
      tags: { variant: "customer", balanceBand: balanceBand(r.balance), daysPast: ymdDiffDays(r.promisedBy, today), partPaid },
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
// Phase 3: pay-slipping, big-order-overdue, reorder-due, season-missed
// ---------------------------------------------------------------------------

export const STORY_SIGNAL_RULES = {
  paySlipMinPaid: 4,
  paySlipHighOverdue: 1_000,
  bigOrderMin: 1_000,
  bigOrderDays: 7,
  bigOrderMinOverdue: 500,
  bigOrderMinPastDue: 30,
  reorderFactor: 1.5,
  reorderMinDays: 14,
  /** A customer quiet for over a year has lapsed — not "due" (judgement call). */
  reorderMaxDays: 365,
};

const usd0 = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

export type PaySlipFacts = {
  customerId: string;
  customerName: string;
  money: Money;
  pay: PayBehaviour;
  promisedPayBy: string | null;
};

export function buildPaySlippingSignals(rows: PaySlipFacts[], ctx: { now: Date; baseUrl: string }): Signal[] {
  const today = todayYmd(ctx.now);
  const out: Signal[] = [];
  for (const r of rows) {
    const u = r.pay.usualDaysToPay;
    const age = r.money.oldestOverdueAgeDays;
    if (u === null || age === null || r.pay.invoicesPaid2y < STORY_SIGNAL_RULES.paySlipMinPaid) continue;
    if (r.money.balance < SIGNAL_RULES.minBalance || r.money.overdue <= 0) continue;
    if (!isSlipping(age, u)) continue;
    if (isPromiseActive(r.promisedPayBy, ctx.now)) continue;
    // The day the oldest invoice crossed the slipping line.
    const crossAt = Math.max(Math.floor(1.5 * u) + 1, u + 20);
    const since = addDaysYmd(addDaysYmd(today, -age), crossAt);
    out.push({
      key: safeKey(`finance.pay-slipping.${r.customerId}.${today.slice(0, 7)}`),
      kind: "pay-slipping",
      severity: r.money.overdue >= STORY_SIGNAL_RULES.paySlipHighOverdue ? "high" : "medium",
      title: clip(`${r.customerName}: usually pays in ${u} days, oldest invoice now ${age} days (${usd(r.money.overdue)} overdue)`, 160),
      detail: clip(
        `Over ${r.pay.invoicesPaid2y} invoices paid in the last 2 years they took a median ${u} days from invoice date${
          r.pay.onTimePct !== null ? ` (${r.pay.onTimePct}% by the due date)` : ""
        }. Their oldest overdue invoice is ${age} days old${r.money.oldestOverdueDays !== null ? `, ${r.money.oldestOverdueDays} days past due` : ""}. ${usd(r.money.balance)} open in total.`,
        400,
      ),
      since: `${since}T00:00:00.000Z`,
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.money.overdue, currency: "USD" },
      links: [{ label: `${r.customerName} in finance (${usd(r.money.overdue)} overdue)`, url: `${ctx.baseUrl}/customers/${r.customerId}?tab=invoices` }],
      dedupe: `customer:${r.customerId}`,
      tags: {
        balanceBand: balanceBand(r.money.balance),
        oldestDays: age,
        ...(r.pay.onTimePct !== null ? { onTimePct: r.pay.onTimePct } : {}),
        ...(r.pay.trend ? { trend: r.pay.trend } : {}),
      },
    });
  }
  return out;
}

export type BigOrderFacts = {
  orderId: string;
  orderNumber: string | null;
  orderDate: Date;
  orderTotal: number;
  customerId: string;
  customerName: string;
  money: Money;
};

export function buildBigOrderSignals(rows: BigOrderFacts[], ctx: { now: Date; baseUrl: string }): Signal[] {
  const oldest = ctx.now.getTime() - STORY_SIGNAL_RULES.bigOrderDays * DAY_MS;
  const out: Signal[] = [];
  for (const r of rows) {
    if (r.orderDate.getTime() < oldest || r.orderDate.getTime() > ctx.now.getTime() + DAY_MS) continue;
    if (r.orderTotal < STORY_SIGNAL_RULES.bigOrderMin) continue;
    if (r.money.overdue < STORY_SIGNAL_RULES.bigOrderMinOverdue) continue;
    if ((r.money.oldestOverdueDays ?? 0) < STORY_SIGNAL_RULES.bigOrderMinPastDue) continue;
    const n = r.orderNumber ? `#${r.orderNumber.replace(/^#/, "")}` : "";
    out.push({
      key: safeKey(`finance.big-order-overdue.${r.customerId}.${r.orderId}`),
      kind: "big-order-overdue",
      severity: "high",
      title: clip(
        `${r.customerName}: new order ${n} for ${usd(r.orderTotal)} while ${usd(r.money.overdue)} is overdue (oldest ${r.money.oldestOverdueDays} days past due)`,
        160,
      ),
      detail: clip(
        `Shopify order ${n} placed ${ymd(r.orderDate)}. Decide whether it ships before the overdue balance is settled; ${usd(r.money.balance)} open in total.`,
        400,
      ),
      since: r.orderDate.toISOString(),
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: r.money.overdue, currency: "USD" },
      links: [
        { label: `${r.customerName}: orders in finance`, url: `${ctx.baseUrl}/customers/${r.customerId}?tab=orders` },
        { label: `${r.customerName}: overdue invoices`, url: `${ctx.baseUrl}/customers/${r.customerId}?tab=invoices` },
      ],
      dedupe: `customer:${r.customerId}`,
      tags: { balanceBand: balanceBand(r.money.balance), orderTotal: Math.round(r.orderTotal), oldestPastDue: r.money.oldestOverdueDays ?? 0 },
    });
  }
  return out;
}

export type ReorderFacts = {
  customerId: string;
  customerName: string;
  country: string | null;
  customerType: "b2b" | "b2c" | null;
  holdStatus: "active" | "hold" | "payment_upfront";
  /** Feldart invoice totals per day, 2 years, ascending. */
  days: InvoiceDay[];
};

/**
 * US check for the Feldart (US) book. There's no currency on invoices, so
 * the QBO billing country decides; a blank country counts as US (nearly
 * every US customer is synced without one).
 */
export function isUsCustomer(country: string | null): boolean {
  const c = (country ?? "").trim().toLowerCase().replace(/\./g, "");
  return c === "" || c === "us" || c === "usa" || c === "united states" || c === "united states of america";
}

export function buildReorderSignals(rows: ReorderFacts[], ctx: { now: Date; baseUrl: string }): Signal[] {
  const today = todayYmd(ctx.now);
  const out: Signal[] = [];
  for (const r of rows) {
    if (!isUsCustomer(r.country) || r.customerType === "b2c" || r.holdStatus === "hold") continue;
    const b = buildBuying(r.days);
    if (b.usualGapDays === null || b.usualGapDays <= 0 || !b.lastOrderAt || b.avgOrderUsd === null) continue;
    const since = ymdDiffDays(b.lastOrderAt, today);
    if (since <= STORY_SIGNAL_RULES.reorderFactor * b.usualGapDays || since < STORY_SIGNAL_RULES.reorderMinDays) continue;
    if (since > STORY_SIGNAL_RULES.reorderMaxDays) continue;
    const dueOn = addDaysYmd(b.lastOrderAt, Math.max(Math.floor(STORY_SIGNAL_RULES.reorderFactor * b.usualGapDays) + 1, STORY_SIGNAL_RULES.reorderMinDays));
    out.push({
      key: safeKey(`finance.reorder-due.${r.customerId}.${b.lastOrderAt}`),
      kind: "reorder-due",
      severity: "info",
      title: clip(`${r.customerName} usually orders every ~${b.usualGapDays} days; it's been ${since} (avg order ${usd0(b.avgOrderUsd)})`, 160),
      detail: clip(`${b.orders2y} invoiced orders in the last 2 years; the last was ${b.lastOrderAt}. Worth a check-in from sales.`, 400),
      since: `${dueOn}T00:00:00.000Z`,
      customer: { id: r.customerId, name: r.customerName },
      amount: { value: b.avgOrderUsd, currency: "USD" },
      links: [{ label: `${r.customerName}: invoices in finance`, url: `${ctx.baseUrl}/customers/${r.customerId}?tab=invoices` }],
      dedupe: `customer:${r.customerId}`,
      tags: { group: "sales", usualGapDays: b.usualGapDays, daysSince: since, orders2y: b.orders2y },
    });
  }
  return out;
}

export type SeasonMissFacts = SeasonMiss & { customerName: string };

export function buildSeasonMissedSignals(rows: SeasonMissFacts[], ctx: { now: Date; baseUrl: string }): Signal[] {
  return rows.map((r) => ({
    key: safeKey(`finance.season-missed.${r.customerId}.${r.season}.${r.year}`),
    kind: "season-missed" as const,
    severity: "info" as const,
    title: clip(
      `${r.customerName}: bought ${r.season} stock the last ${r.pastYears.length} seasons (${[...r.pastYears].sort().join(", ")}); nothing yet for ${r.year}`,
      160,
    ),
    detail: clip(
      `The ${r.season} ${r.year} buying window runs ${r.windowStart} to ${r.windowEnd}. They spent about ${usd0(r.avgSpend)} on ${r.season} items per season before.`,
      400,
    ),
    since: `${addDaysYmd(r.windowStart, -SEASON_RULES.leadDays)}T00:00:00.000Z`,
    customer: { id: r.customerId, name: r.customerName },
    amount: { value: r.avgSpend, currency: "USD" as const },
    links: [{ label: `${r.customerName}: invoices in finance`, url: `${ctx.baseUrl}/customers/${r.customerId}?tab=invoices` }],
    dedupe: `customer:${r.customerId}`,
    tags: { group: "sales", season: clip(r.season, 60), seasonYear: r.year },
  }));
}

export type SignalCustomerInfo = { email?: string | null; payUsualDays?: number | null; promiseRecord?: string | null };

/**
 * Adds customer.email to every signal and payUsualDays / promiseRecord to
 * money signals, never past the 8-tag limit (existing tags win).
 */
export function enrichSignals(signals: Signal[], info: Map<string, SignalCustomerInfo>): Signal[] {
  return signals.map((s) => {
    const i = info.get(s.customer.id);
    if (!i) return s;
    const email = i.email?.trim().toLowerCase();
    const customer = email ? { ...s.customer, email } : s.customer;
    const tags: SignalTags = { ...(s.tags ?? {}) };
    if (MONEY_KINDS.has(s.kind)) {
      const room = () => Object.keys(tags).length < 8;
      if (typeof i.payUsualDays === "number" && room()) tags.payUsualDays = i.payUsualDays;
      if (i.promiseRecord && room()) tags.promiseRecord = i.promiseRecord;
    }
    return { ...s, customer, ...(Object.keys(tags).length ? { tags } : {}) };
  });
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
  const outbound = await db
    .select({
      id: activities.id,
      customerId: activities.customerId,
      occurredAt: activities.occurredAt,
      subject: activities.subject,
      meta: activities.meta,
    })
    .from(activities)
    .where(and(eq(activities.kind, "email_out"), inArray(activities.customerId, ids), gte(activities.occurredAt, fromDay)));

  const cust = new Map(custRows.map((c) => [c.id, c]));
  const inbound = new Map(inboundRows.map((r) => [r.customerId, toDate(r.last)]));

  const out: ChaseFacts[] = [];
  for (const [customerId, c] of latest) {
    const cu = cust.get(customerId);
    if (!cu) continue;
    const meta = (c.meta ?? {}) as { level?: unknown; messageId?: unknown; threadId?: unknown };
    const followUp = pickFollowUp(
      {
        chasedAt: toDate(c.occurredAt)!,
        chaseActivityId: c.id,
        chaseMessageId: typeof meta.messageId === "string" ? meta.messageId : null,
        chaseThreadId: typeof meta.threadId === "string" ? meta.threadId : null,
      },
      outbound
        .filter((o) => o.customerId === customerId)
        .map((o) => {
          const om = (o.meta ?? {}) as { gmailMessageId?: unknown; messageId?: unknown; threadId?: unknown };
          const mid = typeof om.gmailMessageId === "string" ? om.gmailMessageId : typeof om.messageId === "string" ? om.messageId : null;
          return {
            activityId: o.id,
            at: toDate(o.occurredAt)!,
            subject: o.subject,
            messageId: mid,
            threadId: typeof om.threadId === "string" ? om.threadId : null,
          };
        }),
    );
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
      followUp,
    });
  }
  return out;
}

/** Subjects that read as a money follow-up (not order/product chatter). */
const FOLLOW_UP_SUBJECT = /statement|overdue|outstanding|balance|payment|remittance|follow[- ]?up|chase|reminder/i;
/**
 * Automated sends that are NOT a follow-up even though they mention money:
 * statement runs ("Feldart - Statement of Account (...)") and hold-ladder
 * notices. A customer ignoring five statements is more worrying, not less.
 * A human reply to one ("Re: Feldart - Statement...") still counts.
 */
const AUTOMATED_SUBJECT = /statement of account|is on hold|still on hold|^\s*credit memo|^\s*invoice\b/i;
const IS_REPLY = /^\s*(re|fw|fwd)\s*:/i;

export type OutboundEmail = {
  activityId: string;
  at: Date;
  subject: string | null;
  messageId: string | null;
  threadId: string | null;
};

/**
 * Latest email we sent this customer after their chase that counts as a
 * follow-up: on the chase's own Gmail thread, or with a money subject. The
 * chase's own copy (Gmail poll records it again) and anything within 10
 * minutes of it are ignored.
 */
export function pickFollowUp(
  chase: { chasedAt: Date; chaseActivityId: string; chaseMessageId: string | null; chaseThreadId: string | null },
  sent: OutboundEmail[],
): { at: Date; messageId: string | null; activityId: string; subject: string | null } | null {
  const after = chase.chasedAt.getTime() + 10 * 60_000;
  let best: OutboundEmail | null = null;
  for (const s of sent) {
    if (s.activityId === chase.chaseActivityId) continue;
    if (chase.chaseMessageId && s.messageId === chase.chaseMessageId) continue;
    if (s.at.getTime() <= after) continue;
    const onThread = chase.chaseThreadId !== null && s.threadId === chase.chaseThreadId;
    const subject = s.subject ?? "";
    if (!onThread && !FOLLOW_UP_SUBJECT.test(subject)) continue;
    if (!IS_REPLY.test(subject) && AUTOMATED_SUBJECT.test(subject)) continue;
    if (!best || s.at.getTime() > best.at.getTime()) best = s;
  }
  return best ? { at: best.at, messageId: best.messageId, activityId: best.activityId, subject: best.subject } : null;
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
const KIND_ORDER: Record<SignalKind, number> = {
  "promise-missed": 0,
  "big-order-overdue": 1,
  "chase-no-reply": 2,
  "pay-slipping": 3,
  "promise-suggested": 4,
  "reorder-due": 5,
  "season-missed": 6,
};

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
  const phase12 = Promise.all([
    loadChaseFacts(ctx.now).catch(fail("chase-no-reply")) as Promise<ChaseFacts[]>,
    loadPromiseFacts().catch(fail("promise-missed")) as Promise<PromiseFacts[]>,
    loadCustomerPromiseFacts(ctx.now).catch(fail("promise-missed")) as Promise<CustomerPromiseFacts[]>,
    loadSuggestionFacts(ctx.now).catch(fail("promise-suggested")) as Promise<SuggestionFacts[]>,
  ]);
  // Phase 3 starts its candidate queries at once; it only waits for the
  // phase 1–2 customer ids before loading ledgers for the enrichment tags.
  const storyFacts = loadStorySignalFacts({
    now: ctx.now,
    fail,
    feedCustomerIds: phase12.then(([c, p, cp, s]) => [
      ...c.map((r) => r.customerId),
      ...p.map((r) => r.customerId),
      ...cp.map((r) => r.customerId),
      ...s.map((r) => r.customerId),
    ]),
  }).catch((err: unknown) => {
    fail("story")(err);
    return null;
  });
  const [[chase, promise, customerPromise, suggested], story] = await Promise.all([phase12, storyFacts]);
  const built = dedupeByKey([
    // The customer-level promise is the richer record; the held-order
    // variant with the same customer + date is dropped.
    ...buildCustomerPromiseSignals(customerPromise, ctx),
    ...buildPromiseSignals(promise, ctx),
    ...buildChaseSignals(chase, ctx),
    ...buildSuggestedSignals(suggested, ctx),
    ...(story
      ? [
          ...buildBigOrderSignals(story.bigOrders, ctx),
          ...buildPaySlippingSignals(story.paySlip, ctx),
          ...buildReorderSignals(story.reorder, ctx),
          ...buildSeasonMissedSignals(story.season, ctx),
        ]
      : []),
  ]);
  const all = story ? enrichSignals(built, story.info) : built;
  const valid = all.filter((s) => {
    const problems = signalContractProblems(s, ctx.baseUrl);
    if (problems.length > 0) log.warn({ key: s.key, problems }, "signals: dropped a signal that breaks the contract");
    return problems.length === 0;
  });
  return { signals: sortSignals(valid), errors };
}
