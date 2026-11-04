// Feldart AI ops reads — money questions the dashboard can't answer in one
// line: unapplied credits sitting on customers who still owe, and a cash
// outlook (what's due in the coming weeks vs what usually comes in).
// Read-only; applying credits is a money-out action and not offered here.

import { and, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { payments } from "../../db/schema/payments.js";
import { dayOf, isoDay, money, num } from "../reports/table.js";
import { fitRows, parse, RESULT_BUDGET_BYTES, type ToolDef } from "./finance-tools.js";

const DAY_MS = 86_400_000;
const BOOK_LABEL = { feldart: "Feldart", tj: "Torah Judaica" } as const;
type Book = keyof typeof BOOK_LABEL;

export type CreditRow = { customerId: string; origin: Book; docNumber: string | null; balance: number; date: string | null };
export type OpenRow = { customerId: string; origin: Book; docNumber: string | null; balance: number; dueDate: string | null };

/**
 * Per customer+book: unapplied credit vs open balance, and which open
 * invoices the credit would cover oldest-first (a suggestion, not an action).
 */
export function matchCredits(credits: CreditRow[], open: OpenRow[]) {
  const key = (r: { customerId: string; origin: Book }) => `${r.customerId}|${r.origin}`;
  const openBy = new Map<string, OpenRow[]>();
  for (const o of open) openBy.set(key(o), [...(openBy.get(key(o)) ?? []), o]);
  const creditBy = new Map<string, CreditRow[]>();
  for (const c of credits) creditBy.set(key(c), [...(creditBy.get(key(c)) ?? []), c]);
  const out = [];
  for (const [k, cs] of creditBy) {
    const [customerId, origin] = k.split("|") as [string, Book];
    const inv = [...(openBy.get(k) ?? [])].sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
    const credit = money(cs.reduce((s, c) => s + c.balance, 0));
    const owed = money(inv.reduce((s, i) => s + i.balance, 0));
    let left = credit;
    const wouldCover: Array<{ invoice: string | null; balance: number; dueDate: string | null; covered: number }> = [];
    for (const i of inv) {
      if (left <= 0) break;
      const covered = money(Math.min(left, i.balance));
      wouldCover.push({ invoice: i.docNumber, balance: i.balance, dueDate: i.dueDate, covered });
      left = money(left - covered);
    }
    out.push({
      customerId,
      book: BOOK_LABEL[origin],
      unappliedCredit: credit,
      openBalance: owed,
      credits: cs.map((c) => ({ creditMemo: c.docNumber, balance: c.balance, date: c.date })),
      wouldCover,
      creditLeftAfter: left,
    });
  }
  return out.sort((a, b) => Math.min(b.unappliedCredit, b.openBalance) - Math.min(a.unappliedCredit, a.openBalance));
}

const unappliedCredits: ToolDef = {
  name: "unapplied_credits",
  ops: true,
  description:
    "Customers with unapplied credit memos in QuickBooks, per book, next to what they still owe — and which of their open invoices (oldest due first) the credit would cover if applied. Use for \"who has credit sitting unused\", \"can we net X's credit against their invoices\", statement clean-up. A suggestion only: applying a credit in QuickBooks is a money action the assistant can't do from chat yet. `owingOnly` (default true) keeps only customers who also owe money.",
  input_schema: {
    type: "object",
    properties: {
      owingOnly: { type: "boolean", description: "Only customers who also have open invoices in the same book (default true)." },
      top: { type: "integer", minimum: 1, maximum: 100, description: "Max customers (default 25)." },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(z.object({ owingOnly: z.boolean().default(true), top: z.number().int().min(1).max(100).default(25) }), input);
    const credits = await db
      .select({ customerId: creditMemos.customerId, origin: creditMemos.origin, docNumber: creditMemos.docNumber, balance: creditMemos.balance, date: creditMemos.txnDate })
      .from(creditMemos)
      .where(gt(creditMemos.balance, "0"));
    const ids = [...new Set(credits.map((c) => c.customerId))];
    const open = ids.length
      ? await db
          .select({ customerId: invoices.customerId, origin: invoices.origin, docNumber: invoices.docNumber, balance: invoices.balance, dueDate: invoices.dueDate })
          .from(invoices)
          .where(and(inArray(invoices.customerId, ids), gt(invoices.balance, "0"), ne(invoices.status, "void")))
      : [];
    const names = ids.length
      ? new Map((await db.select({ id: customers.id, name: customers.displayName }).from(customers).where(inArray(customers.id, ids))).map((c) => [c.id, c.name]))
      : new Map<string, string>();
    let rows = matchCredits(
      credits.map((c) => ({ ...c, balance: num(c.balance), date: dayOf(c.date) })),
      open.map((o) => ({ ...o, balance: num(o.balance), dueDate: dayOf(o.dueDate) })),
    );
    if (p.owingOnly) rows = rows.filter((r) => r.openBalance > 0);
    const total = rows.length;
    const shaped = rows.slice(0, p.top).map((r) => ({ customer: names.get(r.customerId) ?? r.customerId, ...r, url: `${ctx.baseUrl}/customers/${r.customerId}` }));
    const { rows: kept, note } = fitRows(shaped, RESULT_BUDGET_BYTES - 3_000);
    return {
      asOf: ctx.now.toISOString(),
      currency: "USD",
      count: total,
      totalUnappliedCredit: money(rows.reduce((s, r) => s + r.unappliedCredit, 0)),
      customers: kept,
      warnings: [
        ...(total > p.top ? [`Top ${p.top} of ${total} shown (biggest nettable amount first).`] : []),
        ...(note ? [note] : []),
        "Suggestions only — applying a credit is done in QuickBooks (or on the customer's statement) by a person for now.",
      ],
    };
  },
};

// ---------------------------------------------------------------------------

export function weekBuckets(rows: Array<{ balance: number; dueDate: string | null }>, today: string, days: number) {
  const start = Date.parse(`${today}T00:00:00Z`);
  const buckets: Array<{ week: string; from: string; to: string; due: number; invoices: number }> = [];
  for (let d = 0; d < days; d += 7) {
    const from = isoDay(new Date(start + d * DAY_MS));
    const to = isoDay(new Date(start + Math.min(d + 6, days - 1) * DAY_MS));
    buckets.push({ week: d === 0 ? "this week" : `in ${d / 7} week${d / 7 === 1 ? "" : "s"}`, from, to, due: 0, invoices: 0 });
  }
  let overdue = 0;
  let overdueCount = 0;
  for (const r of rows) {
    if (!r.dueDate) continue;
    if (r.dueDate < today) {
      overdue += r.balance;
      overdueCount += 1;
      continue;
    }
    const b = buckets.find((x) => r.dueDate! >= x.from && r.dueDate! <= x.to);
    if (b) {
      b.due += r.balance;
      b.invoices += 1;
    }
  }
  return { buckets: buckets.map((b) => ({ ...b, due: money(b.due) })), overdue: money(overdue), overdueInvoices: overdueCount };
}

const cashOutlook: ToolDef = {
  name: "cash_outlook",
  ops: true,
  description:
    "What money is due to come in: open invoices falling due week by week over the next N days (default 28), plus what's already overdue, per book — next to what has actually come in recently (average cash received per week over the last 8 weeks). Use for \"what's coming in this month\", \"cash forecast\", \"how much is due next week\". It's what's DUE, not a prediction — say so, and point at the overdue figure as the at-risk part.",
  input_schema: {
    type: "object",
    properties: {
      days: { type: "integer", minimum: 7, maximum: 90, description: "Look ahead this many days (default 28)." },
      book: { type: "string", enum: ["feldart", "tj", "both"], description: "Default both (reported separately)." },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(z.object({ days: z.number().int().min(7).max(90).default(28), book: z.enum(["feldart", "tj", "both"]).default("both") }), input);
    const today = isoDay(ctx.now);
    const books: Book[] = p.book === "both" ? ["feldart", "tj"] : [p.book];
    const [open, paid] = await Promise.all([
      db
        .select({ origin: invoices.origin, balance: invoices.balance, dueDate: invoices.dueDate })
        .from(invoices)
        .where(and(gt(invoices.balance, "0"), ne(invoices.status, "void"), inArray(invoices.origin, books))),
      db
        .select({ feldart: sql<string>`COALESCE(SUM(${payments.feldartAmount}),0)`, tj: sql<string>`COALESCE(SUM(${payments.tjAmount}),0)` })
        .from(payments)
        .where(sql`${payments.txnDate} >= ${new Date(ctx.now.getTime() - 56 * DAY_MS)}`),
    ]);
    const perBook = Object.fromEntries(
      books.map((b) => {
        const rows = open.filter((o) => o.origin === b).map((o) => ({ balance: num(o.balance), dueDate: dayOf(o.dueDate) }));
        const w = weekBuckets(rows, today, p.days);
        const recv8w = num(paid[0]?.[b] ?? 0);
        return [
          BOOK_LABEL[b],
          {
            dueInWindow: money(w.buckets.reduce((s, x) => s + x.due, 0)),
            weeks: w.buckets,
            alreadyOverdue: w.overdue,
            overdueInvoices: w.overdueInvoices,
            receivedPerWeekLast8Weeks: money(recv8w / 8),
          },
        ];
      }),
    );
    return {
      asOf: ctx.now.toISOString(),
      currency: "USD",
      days: p.days,
      books: perBook,
      warnings: [
        "These are amounts DUE by invoice due date, not a prediction of payment. Compare with the recent weekly cash received.",
        "Invoices dated in the future (QuickBooks placeholders) fall into the week they're due.",
      ],
    };
  },
};

export const OPS_MONEY_READS: ToolDef[] = [unappliedCredits, cashOutlook];

