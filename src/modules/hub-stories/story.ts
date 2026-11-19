// Customer "story" for the hub's Chief of Staff panel (phase 3, "it knows the
// story" — operator approved 2026-11-19). Pure builders only; load.ts does
// the queries. GET /api/ext/customers/story(ies) and the phase-3 signals
// (pay-slipping, big-order-overdue, reorder-due) are built from these.
//
// Data notes (read before changing a rule):
//   * Dates later than today are dropped everywhere: the QBO sync writes
//     2030-01-01 placeholders on some invoices/payments.
//   * QBO gives finance no payment → invoice link (payments only carry a
//     per-book split). The day an invoice was PAID is therefore derived by
//     FIFO per book — cash (payments' Feldart/TJ share + applied credit
//     memos) pays the oldest invoice first, QBO's own auto-apply order. Only
//     invoices QBO says are fully paid (balance 0) get a paid date; one the
//     FIFO can't cover (paid by something finance doesn't see) is skipped,
//     not guessed.
//   * Days-to-pay is counted from the INVOICE date (not the due date), so
//     "usually pays in 45 days" reads naturally next to net-30/60 terms.
//   * invoice_lines.sku and the name/description columns are swapped on most
//     rows (sync quirk) — anything matching a SKU looks at all of them.

import { todayYmd, ymdDiffDays } from "../promises/promise-state.js";

export type Book = "feldart" | "tj";

export const STORY_RULES = {
  /** Pay behaviour, promise history, timeline and buying cover this window. */
  lookbackDays: 730,
  /** FIFO needs older invoices too; the rest comes in as an opening balance. */
  ledgerLookbackDays: 1095,
  /** "Recent" half of the trend comparison. */
  recentDays: 182,
  minPaidForTrend: 4,
  slipFactor: 1.5,
  slipMinDays: 20,
  /** Balance under this counts as settled (operator's $50 floor). */
  settledBelow: 50,
  timelineMax: 60,
  timelinePerKind: 15,
  minOrderDays: 4,
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.005;

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerInvoice = {
  id: string;
  docNumber: string | null;
  issueDate: string; // YYYY-MM-DD, ≤ today
  dueDate: string | null;
  total: number;
  balance: number;
  origin: Book;
  /**
   * Issued before the ledger window: kept only because it is still open (for
   * money), never part of the FIFO queue (it's inside `opening`).
   */
  beforeWindow?: boolean;
};

export type LedgerPayment = { id: string; date: string; total: number; feldart: number; tj: number };
export type LedgerCredit = { id: string; docNumber: string | null; date: string; total: number; balance: number; origin: Book };

/** Net position before the ledger window (invoiced − paid − credited). */
export type LedgerOpening = { feldart: number; tj: number; total: number };

export type Ledger = {
  invoices: LedgerInvoice[];
  payments: LedgerPayment[];
  credits: LedgerCredit[];
  opening: LedgerOpening;
};

export const emptyLedger = (): Ledger => ({ invoices: [], payments: [], credits: [], opening: { feldart: 0, tj: 0, total: 0 } });

/** Paid date per fully-paid invoice of one book, by FIFO (see header). */
export function fifoPaidDates(ledger: Ledger, book: Book): Map<string, string> {
  const queue = ledger.invoices
    .filter((i) => i.origin === book && !i.beforeWindow && i.total > EPS)
    .sort((a, b) => (a.issueDate === b.issueDate ? a.id.localeCompare(b.id) : a.issueDate < b.issueDate ? -1 : 1));
  const cash: Array<{ date: string; amount: number }> = [];
  for (const p of ledger.payments) {
    const amt = book === "feldart" ? p.feldart : p.tj;
    if (amt > EPS) cash.push({ date: p.date, amount: amt });
  }
  for (const c of ledger.credits) {
    const applied = c.total - c.balance;
    if (c.origin === book && applied > EPS) cash.push({ date: c.date, amount: applied });
  }
  cash.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const opening = ledger.opening[book];
  let debt = Math.max(0, opening); // older unpaid invoices are paid first
  let have = Math.max(0, -opening); // a prepayment / credit carried in
  let ci = 0;
  let lastCashDate: string | null = null;
  const out = new Map<string, string>();
  for (const inv of queue) {
    debt += inv.total;
    while (have + EPS < debt && ci < cash.length) {
      have += cash[ci]!.amount;
      lastCashDate = cash[ci]!.date;
      ci++;
    }
    if (have + EPS < debt) break; // cash ran out: this and later aren't FIFO-paid
    if (inv.balance > EPS) continue; // QBO says it's still open — no paid date
    const paid = lastCashDate && lastCashDate > inv.issueDate ? lastCashDate : inv.issueDate;
    out.set(inv.id, paid);
  }
  return out;
}

/** Customer balance at the end of `day`, from the ledger (for promise outcomes). */
export function balanceAt(ledger: Ledger, day: string): number {
  let b = ledger.opening.total;
  for (const i of ledger.invoices) if (!i.beforeWindow && i.issueDate <= day) b += i.total;
  for (const p of ledger.payments) if (p.date <= day) b -= p.total;
  for (const c of ledger.credits) if (c.date <= day) b -= c.total;
  return round2(b);
}

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

export type BookMoney = { balance: number; overdue: number };
export type Money = {
  /** customers.balance — QBO's own figure. */
  balance: number;
  overdue: number;
  /** Days past due of the oldest overdue invoice (null = nothing overdue). */
  oldestOverdueDays: number | null;
  /** Same invoice, days since its INVOICE date (compared to usualDaysToPay). */
  oldestOverdueAgeDays: number | null;
  book: { feldart: BookMoney; tj: BookMoney };
};

export function buildMoney(ledger: Ledger, customerBalance: number, today: string): Money {
  const book = { feldart: { balance: 0, overdue: 0 }, tj: { balance: 0, overdue: 0 } };
  let oldestDue: string | null = null;
  let oldestIssue: string | null = null;
  for (const i of ledger.invoices) {
    if (i.balance <= EPS) continue;
    book[i.origin].balance += i.balance;
    const due = i.dueDate ?? i.issueDate;
    if (due < today) {
      book[i.origin].overdue += i.balance;
      if (oldestDue === null || due < oldestDue) oldestDue = due;
      if (oldestIssue === null || i.issueDate < oldestIssue) oldestIssue = i.issueDate;
    }
  }
  for (const c of ledger.credits) if (c.balance > EPS) book[c.origin].balance -= c.balance;
  for (const b of [book.feldart, book.tj]) {
    b.balance = round2(b.balance);
    b.overdue = round2(b.overdue);
  }
  return {
    balance: round2(customerBalance),
    overdue: round2(book.feldart.overdue + book.tj.overdue),
    oldestOverdueDays: oldestDue ? ymdDiffDays(oldestDue, today) : null,
    oldestOverdueAgeDays: oldestIssue ? ymdDiffDays(oldestIssue, today) : null,
    book,
  };
}

// ---------------------------------------------------------------------------
// payBehaviour
// ---------------------------------------------------------------------------

export type PayTrend = "steady" | "slipping" | "improving";
export type PayBehaviour = {
  /** Median days from invoice date to full payment (null = nothing paid). */
  usualDaysToPay: number | null;
  /** % of those paid by their due date. */
  onTimePct: number | null;
  invoicesPaid2y: number;
  /** Median of invoices paid in the last ~6 months (null if < 2). */
  recentDaysToPay: number | null;
  trend: PayTrend | null;
};

/** True when `days` is late against `usual` by the slipping rule. */
export function isSlipping(days: number, usual: number): boolean {
  return days > STORY_RULES.slipFactor * usual && days >= usual + STORY_RULES.slipMinDays;
}

export function buildPayBehaviour(ledger: Ledger, today: string, oldestOverdueAgeDays: number | null): PayBehaviour {
  const from = addDaysYmd(today, -STORY_RULES.lookbackDays);
  const recentFrom = addDaysYmd(today, -STORY_RULES.recentDays);
  const paid: Array<{ days: number; onTime: boolean; paidOn: string }> = [];
  for (const book of ["feldart", "tj"] as const) {
    const dates = fifoPaidDates(ledger, book);
    for (const inv of ledger.invoices) {
      const p = dates.get(inv.id);
      if (!p || inv.origin !== book || inv.issueDate < from || p > today) continue;
      paid.push({ days: ymdDiffDays(inv.issueDate, p), onTime: p <= (inv.dueDate ?? inv.issueDate), paidOn: p });
    }
  }
  const usualRaw = median(paid.map((p) => p.days));
  const usual = usualRaw === null ? null : Math.round(usualRaw);
  const recent = paid.filter((p) => p.paidOn >= recentFrom).map((p) => p.days);
  const prior = paid.filter((p) => p.paidOn < recentFrom).map((p) => p.days);
  const recentMed = recent.length >= 2 ? median(recent) : null;
  const priorMed = prior.length >= 2 ? median(prior) : null;

  let trend: PayTrend | null = null;
  if (usual !== null && paid.length >= STORY_RULES.minPaidForTrend) {
    const ageLate = oldestOverdueAgeDays !== null && isSlipping(oldestOverdueAgeDays, usual);
    const recentLate = recentMed !== null && isSlipping(recentMed, usual);
    if (ageLate || recentLate) trend = "slipping";
    // Survivor bias (alice review): recent medians only see invoices already
    // PAID, so "improving" also needs nothing currently older than usual.
    else if (
      recentMed !== null && priorMed !== null && recentMed <= 0.75 * priorMed && recentMed <= priorMed - 10 &&
      (oldestOverdueAgeDays === null || oldestOverdueAgeDays <= usual)
    ) trend = "improving";
    else trend = "steady";
  }
  return {
    usualDaysToPay: usual,
    onTimePct: paid.length ? Math.round((100 * paid.filter((p) => p.onTime).length) / paid.length) : null,
    invoicesPaid2y: paid.length,
    recentDaysToPay: recentMed === null ? null : Math.round(recentMed),
    trend,
  };
}

// ---------------------------------------------------------------------------
// promises
// ---------------------------------------------------------------------------

export type PromiseMade = {
  /** When it was saved. */
  setAt: Date;
  /** Promised pay-by calendar day. */
  date: string;
  source: "customer" | "held-order";
  note?: string | null;
};
export type PromiseOutcome = "kept" | "broken" | "partPaid" | "pending";
export type PromiseResult = PromiseMade & { outcome: PromiseOutcome };
export type PromiseSummary = {
  made: number;
  kept: number;
  broken: number;
  partPaid: number;
  last?: { date: string; outcome: PromiseOutcome };
};

/**
 * Outcome of each promise, judged on money alone (conservative):
 *   kept     — by the end of the promised day the balance was under $50, or
 *              they paid at least what was owed when the promise was made
 *              (less $50) — new invoices since don't break a kept promise;
 *   partPaid — some payment between saving it and the date, not enough;
 *   broken   — no payment in that span;
 *   pending  — the date hasn't passed (it covers the whole day).
 * The same date saved twice (customer promise mirrored onto held orders,
 * re-saves) counts once, from the earliest save.
 */
export function judgePromises(made: PromiseMade[], ledger: Ledger, today: string): PromiseResult[] {
  const byDate = new Map<string, PromiseMade>();
  for (const p of made) {
    const prev = byDate.get(p.date);
    const earlier = prev ? p.setAt.getTime() - prev.setAt.getTime() : -1;
    // Earliest save wins; on a tie the customer-level record (it has the note).
    if (!prev || earlier < 0 || (earlier === 0 && p.source === "customer")) byDate.set(p.date, p);
  }
  const out: PromiseResult[] = [];
  for (const p of byDate.values()) {
    if (p.date >= today) {
      out.push({ ...p, outcome: "pending" });
      continue;
    }
    const setDay = p.setAt.toISOString().slice(0, 10);
    const owed = balanceAt(ledger, setDay);
    const paid = ledger.payments.filter((x) => x.date >= setDay && x.date <= p.date).reduce((s, x) => s + x.total, 0);
    const kept = balanceAt(ledger, p.date) < STORY_RULES.settledBelow || (owed >= STORY_RULES.settledBelow ? paid >= owed - STORY_RULES.settledBelow : true);
    out.push({ ...p, outcome: kept ? "kept" : paid > EPS ? "partPaid" : "broken" });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.setAt.getTime() - b.setAt.getTime()));
}

export function summarisePromises(results: PromiseResult[]): PromiseSummary {
  const s: PromiseSummary = { made: results.length, kept: 0, broken: 0, partPaid: 0 };
  for (const r of results) {
    if (r.outcome === "kept") s.kept++;
    else if (r.outcome === "broken") s.broken++;
    else if (r.outcome === "partPaid") s.partPaid++;
  }
  const last = results[results.length - 1];
  if (last) s.last = { date: last.date, outcome: last.outcome };
  return s;
}

/** Hub tag "kept/resolved" (pending promises aren't counted); null if none resolved. */
export function promiseRecordTag(s: PromiseSummary): string | null {
  const resolved = s.kept + s.broken + s.partPaid;
  return resolved > 0 ? `${s.kept}/${resolved}` : null;
}

// ---------------------------------------------------------------------------
// buying (B2B invoices, Feldart book)
// ---------------------------------------------------------------------------

export type Buying = {
  lastOrderAt: string | null;
  /** Median gap between consecutive invoice days (null if < 4 invoice days). */
  usualGapDays: number | null;
  avgOrderUsd: number | null;
  /** Distinct invoice days in 2 years (same-day split invoices = one order). */
  orders2y: number;
  topSkus?: string[];
};

export type InvoiceDay = { date: string; total: number };

/** Sum Feldart invoices per day (one order may be split into several invoices). */
export function invoiceDays(invoices: Array<{ issueDate: string; total: number; origin: Book }>, from: string, today: string): InvoiceDay[] {
  const m = new Map<string, number>();
  for (const i of invoices) {
    if (i.origin !== "feldart" || i.issueDate < from || i.issueDate > today || i.total <= EPS) continue;
    m.set(i.issueDate, (m.get(i.issueDate) ?? 0) + i.total);
  }
  return Array.from(m, ([date, total]) => ({ date, total })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function buildBuying(days: InvoiceDay[], topSkus?: string[]): Buying {
  const gaps: number[] = [];
  for (let k = 1; k < days.length; k++) gaps.push(ymdDiffDays(days[k - 1]!.date, days[k]!.date));
  const gap = days.length >= STORY_RULES.minOrderDays ? median(gaps) : null;
  const last = days[days.length - 1];
  return {
    lastOrderAt: last ? last.date : null,
    usualGapDays: gap === null ? null : Math.round(gap),
    avgOrderUsd: days.length ? Math.round(days.reduce((s, d) => s + d.total, 0) / days.length) : null,
    orders2y: days.length,
    ...(topSkus && topSkus.length ? { topSkus } : {}),
  };
}

const SKU_LIKE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{1,31}$/;
/** A line's SKU code: whichever of sku/description/itemName looks like one. */
export function lineSku(l: { sku: string | null; description: string | null; itemName: string | null }): string | null {
  for (const v of [l.sku, l.description, l.itemName]) {
    const t = v?.trim();
    if (t && SKU_LIKE.test(t) && /\d/.test(t)) return t.toUpperCase();
  }
  return null;
}

export function topSkus(lines: Array<{ sku: string | null; description: string | null; itemName: string | null; qty: number }>, n = 5): string[] {
  const m = new Map<string, number>();
  for (const l of lines) {
    const s = lineSku(l);
    if (s) m.set(s, (m.get(s) ?? 0) + (l.qty > 0 ? l.qty : 1));
  }
  return Array.from(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([s]) => s);
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

export type TimelineKind =
  | "order"
  | "invoice"
  | "payment"
  | "chase"
  | "promise-set"
  | "promise-kept"
  | "promise-broken"
  | "promise-part-paid"
  | "hold-on"
  | "hold-off"
  | "rma"
  | "credit-memo"
  | "statement"
  | "hub-note";

export type TimelineEvent = { date: string; kind: TimelineKind; text: string; source: "finance"; link?: string };

export type TimelineInput = {
  orders: Array<{ id: string; number: string | null; date: string; total: number | null; cancelled: boolean; holdStartedAt: string | null; holdReleasedAt: string | null; holdReason: string | null }>;
  invoices: LedgerInvoice[];
  payments: LedgerPayment[];
  credits: LedgerCredit[];
  chases: Array<{ date: string; level: number | null; subject: string | null }>;
  promises: PromiseResult[];
  holds: Array<{ date: string; on: boolean; text: string | null }>;
  rmas: Array<{ id: string; number: string | null; date: string; status: string; type: string; total: number }>;
  statements: Array<{ date: string; number: number | null; type: string }>;
  hubNotes: Array<{ date: string; text: string }>;
};

const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function buildTimeline(input: TimelineInput, ctx: { today: string; baseUrl: string; customerId: string }): TimelineEvent[] {
  const from = addDaysYmd(ctx.today, -STORY_RULES.lookbackDays);
  const cust = `${ctx.baseUrl}/customers/${ctx.customerId}`;
  const ev: TimelineEvent[] = [];
  const push = (date: string | null, kind: TimelineKind, text: string, link?: string) => {
    if (!date || date < from || date > ctx.today) return;
    ev.push({ date, kind, text: clip(oneLine(text), 160), source: "finance", ...(link ? { link } : {}) });
  };
  for (const o of input.orders) {
    const n = o.number ? `#${o.number.replace(/^#/, "")}` : "";
    push(o.date, "order", `Shopify order ${n}${o.total !== null ? ` for ${usd(o.total)}` : ""}${o.cancelled ? " (cancelled)" : ""}`, `${cust}?tab=orders`);
    push(o.holdStartedAt, "hold-on", `Order ${n} put on hold${o.holdReason ? ` (${o.holdReason.replace(/_/g, " ")})` : ""}`, `${cust}?tab=orders`);
    push(o.holdReleasedAt, "hold-off", `Order ${n} released from hold`, `${cust}?tab=orders`);
  }
  for (const i of input.invoices) {
    if (i.beforeWindow) continue;
    push(i.issueDate, "invoice", `${i.origin === "tj" ? "TJ invoice" : "Invoice"} ${i.docNumber ?? ""} for ${usd(i.total)}${i.balance > EPS ? ` (${usd(i.balance)} open)` : ""}`, `${cust}?tab=invoices`);
  }
  for (const p of input.payments) push(p.date, "payment", `Payment received: ${usd(p.total)}${p.tj > EPS && p.feldart <= EPS ? " (TJ book)" : ""}`, `${cust}?tab=invoices`);
  for (const c of input.credits) push(c.date, "credit-memo", `${c.origin === "tj" ? "TJ credit memo" : "Credit memo"} ${c.docNumber ?? ""} for ${usd(c.total)}`, `${cust}?tab=invoices`);
  for (const c of input.chases) push(c.date, "chase", `Level ${c.level ?? 1} chase email sent${c.subject ? `: "${c.subject}"` : ""}`, cust);
  for (const p of input.promises) {
    const setDay = p.setAt.toISOString().slice(0, 10);
    push(setDay, "promise-set", `Promised to pay by ${p.date}${p.source === "held-order" ? " (held order)" : ""}${p.note ? `: ${p.note}` : ""}`, cust);
    if (p.outcome === "kept") push(p.date, "promise-kept", `Promise to pay by ${p.date} kept`, cust);
    else if (p.outcome === "broken") push(addDaysYmd(p.date, 1), "promise-broken", `Promise to pay by ${p.date} broken: no payment`, cust);
    else if (p.outcome === "partPaid") push(addDaysYmd(p.date, 1), "promise-part-paid", `Promise to pay by ${p.date} only part-paid`, cust);
  }
  for (const h of input.holds) push(h.date, h.on ? "hold-on" : "hold-off", h.text ?? (h.on ? "Account put on hold" : "Account taken off hold"), cust);
  for (const r of input.rmas) {
    push(r.date, "rma", `Return ${r.number ?? "(draft)"} (${r.type.replace(/_/g, " ")}${r.total > EPS ? `, ${usd(r.total)}` : ""}): ${r.status.replace(/_/g, " ")}`, `${ctx.baseUrl}/returns/${r.id}`);
  }
  for (const s of input.statements) push(s.date, "statement", `Statement${s.number !== null ? ` #${s.number}` : ""} sent (${s.type.replace(/_/g, " ")})`, cust);
  for (const n of input.hubNotes) push(n.date, "hub-note", n.text, cust);

  // Newest first; cap each kind so a run of statements or invoices can't
  // crowd out the rest of the story.
  ev.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const perKind = new Map<TimelineKind, number>();
  const out: TimelineEvent[] = [];
  for (const e of ev) {
    const n = perKind.get(e.kind) ?? 0;
    if (n >= STORY_RULES.timelinePerKind) continue;
    perKind.set(e.kind, n + 1);
    out.push(e);
    if (out.length >= STORY_RULES.timelineMax) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

export type CustomerStory = {
  customer: { id: string; name: string; emails: string[] };
  money: Money;
  payBehaviour: PayBehaviour;
  promises: PromiseSummary;
  buying: Buying;
  timeline: TimelineEvent[];
  generatedAt: string;
};

export type StoryInputs = {
  customer: { id: string; name: string; emails: string[]; balance: number };
  ledger: Ledger;
  promisesMade: PromiseMade[];
  lines: Array<{ sku: string | null; description: string | null; itemName: string | null; qty: number }>;
  extras: Omit<TimelineInput, "invoices" | "payments" | "credits" | "promises">;
};

export function buildStory(inp: StoryInputs, ctx: { now: Date; baseUrl: string }): CustomerStory {
  const today = todayYmd(ctx.now);
  const money = buildMoney(inp.ledger, inp.customer.balance, today);
  const payBehaviour = buildPayBehaviour(inp.ledger, today, money.oldestOverdueAgeDays);
  const results = judgePromises(inp.promisesMade, inp.ledger, today);
  const buying = buildBuying(invoiceDays(inp.ledger.invoices, addDaysYmd(today, -STORY_RULES.lookbackDays), today), topSkus(inp.lines));
  return {
    customer: { id: inp.customer.id, name: inp.customer.name, emails: inp.customer.emails },
    money,
    payBehaviour,
    promises: summarisePromises(results),
    buying,
    timeline: buildTimeline(
      { ...inp.extras, invoices: inp.ledger.invoices, payments: inp.ledger.payments, credits: inp.ledger.credits, promises: results },
      { today, baseUrl: ctx.baseUrl, customerId: inp.customer.id },
    ),
    generatedAt: ctx.now.toISOString(),
  };
}
