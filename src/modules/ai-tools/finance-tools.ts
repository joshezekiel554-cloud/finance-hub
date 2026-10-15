// Finance's read-only tools for the Feldart AI chatbot (hub-run agent loop,
// contract agreed on the radio 2026-10-15): GET /api/ext/tools lists them in
// Anthropic tool format, POST /api/ext/tools/:name runs one. The hub calls
// as the signed-in member (hub service token) and finance applies its own
// staff gate, so a tool never shows a balance the member couldn't open.
//
// Descriptions are written for the model: when to use the tool and what
// comes back. Results are compact JSON with finance links, kept under
// ~40KB (rows trimmed with a note) so one call can't flood the context.

import { and, desc, eq, gt, gte, inArray, isNotNull, like, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { invoiceLines, invoices } from "../../db/schema/invoices.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { payments } from "../../db/schema/payments.js";
import { rmas } from "../../db/schema/returns.js";
import { loadAgedDebtors } from "../reports/aged-debtors.js";
import { loadOpenInvoices } from "../reports/open-invoices.js";
import { loadReturnsReport } from "../reports/returns.js";
import { likePattern } from "../reports/customers.js";
import { dayOf, isoDay, money, num, type ReportTable } from "../reports/table.js";

export type ToolContext = { now: Date; baseUrl: string };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: unknown, ctx: ToolContext) => Promise<unknown>;
};

export class ToolInputError extends Error {}

export const RESULT_BUDGET_BYTES = 40_000;

/**
 * Trim a list so the JSON result stays under the byte budget. Returns the
 * kept items and, when anything was dropped, a note the model can relay.
 */
export function fitRows<T>(rows: T[], budget = RESULT_BUDGET_BYTES): { rows: T[]; note: string | null } {
  let size = 2;
  const kept: T[] = [];
  for (const r of rows) {
    const len = JSON.stringify(r).length + 1;
    if (size + len > budget) break;
    size += len;
    kept.push(r);
  }
  return kept.length === rows.length
    ? { rows: kept, note: null }
    : {
        rows: kept,
        note: `Showing ${kept.length} of ${rows.length} rows (trimmed to fit). Ask for a narrower range, or run the matching Feldart AI task for the full sheet.`,
      };
}

/** A report table as a compact tool result (keyed rows, totals, warnings). */
function tableResult(t: ReportTable, budget = RESULT_BUDGET_BYTES - 4_000) {
  const { rows, note } = fitRows(t.rows, budget);
  return {
    title: t.title,
    asOf: t.asOf,
    currency: "USD",
    columns: t.columns.map((c) => c.key),
    rows,
    totals: t.totals ?? null,
    warnings: note ? [...t.warnings, note] : t.warnings,
  };
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new ToolInputError(
      issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid input",
    );
  }
  return r.data;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a real date");
const customerId = z.string().min(1).max(64);
const book = z.enum(["feldart", "tj", "both"]).default("both");

const BOOK_PROP = {
  type: "string",
  enum: ["feldart", "tj", "both"],
  description: 'Which books: "feldart" (the live business), "tj" (Torah Judaica, legacy wind-down book) or "both". Default both.',
};
const CUSTOMER_ID_PROP = {
  type: "string",
  description: "Finance customer id, from find_customer.",
};

const HOLD_LABEL: Record<string, string> = {
  active: "Active",
  hold: "On hold",
  payment_upfront: "Payment upfront",
};

const OPEN_RMA_STATUSES = ["approved", "awaiting_warehouse_number", "sent_to_warehouse", "received"] as const;

// ---------------------------------------------------------------------------

const findCustomer: ToolDef = {
  name: "find_customer",
  description:
    "Look up wholesale (B2B) customers in Finance by part of their name or email. Use this first whenever the user names a store, so you have its customerId for the other finance tools. Returns up to 10 matches with id, name, email, account status (active / on hold / payment upfront) and open balance per book.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Part of the store name or email, e.g. \"bais hasforim\"." } },
    required: ["query"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const { query } = parse(z.object({ query: z.string().trim().min(2).max(100) }), input);
    const pattern = likePattern(query);
    const found = await db
      .select({
        id: customers.id,
        name: customers.displayName,
        email: customers.primaryEmail,
        holdStatus: customers.holdStatus,
      })
      .from(customers)
      .where(or(like(customers.displayName, pattern), like(customers.primaryEmail, pattern)))
      .limit(10);
    const balances = await openBalancesFor(found.map((c) => c.id));
    return {
      customers: found.map((c) => ({
        ...c,
        holdStatus: HOLD_LABEL[c.holdStatus] ?? c.holdStatus,
        openBalance: balances.get(c.id) ?? { feldart: 0, tj: 0 },
        url: `${ctx.baseUrl}/customers/${c.id}`,
      })),
      note: found.length === 0 ? "No customer matches. Try a shorter part of the name." : null,
    };
  },
};

async function openBalancesFor(ids: string[]): Promise<Map<string, { feldart: number; tj: number }>> {
  const out = new Map<string, { feldart: number; tj: number }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      customerId: invoices.customerId,
      origin: invoices.origin,
      balance: sql<string>`SUM(${invoices.balance})`,
    })
    .from(invoices)
    .where(and(inArray(invoices.customerId, ids), gt(invoices.balance, "0"), ne(invoices.status, "void")))
    .groupBy(invoices.customerId, invoices.origin);
  for (const r of rows) {
    const b = out.get(r.customerId) ?? { feldart: 0, tj: 0 };
    b[r.origin] = money(num(r.balance));
    out.set(r.customerId, b);
  }
  return out;
}

const customerSummary: ToolDef = {
  name: "customer_summary",
  description:
    "One customer's account at a glance from Finance: account status and terms, open and overdue balance per book (Feldart / Torah Judaica), oldest overdue due date, unapplied credits, last payment, and RMAs still in progress. Use for questions like \"how is X doing\", \"does X owe us\", \"when did X last pay\".",
  input_schema: {
    type: "object",
    properties: { customerId: CUSTOMER_ID_PROP },
    required: ["customerId"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const { customerId: id } = parse(z.object({ customerId }), input);
    const [c] = await db
      .select({
        name: customers.displayName,
        email: customers.primaryEmail,
        holdStatus: customers.holdStatus,
        paymentTerms: customers.paymentTerms,
      })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    if (!c) throw new ToolInputError("customerId: no such customer. Use find_customer first.");
    const today = isoDay(ctx.now);

    const [open, credits, lastPay, openRmas] = await Promise.all([
      db
        .select({ origin: invoices.origin, balance: invoices.balance, dueDate: invoices.dueDate, issueDate: invoices.issueDate })
        .from(invoices)
        .where(and(eq(invoices.customerId, id), gt(invoices.balance, "0"), ne(invoices.status, "void"))),
      db
        .select({ origin: creditMemos.origin, balance: creditMemos.balance })
        .from(creditMemos)
        .where(and(eq(creditMemos.customerId, id), gt(creditMemos.balance, "0"))),
      db
        .select({ txnDate: payments.txnDate, total: payments.total })
        .from(payments)
        .where(eq(payments.customerId, id))
        .orderBy(desc(payments.txnDate))
        .limit(1),
      db
        .select({ id: rmas.id, rmaNumber: rmas.rmaNumber, status: rmas.status, totalValue: rmas.totalValue })
        .from(rmas)
        .where(and(eq(rmas.customerId, id), inArray(rmas.status, [...OPEN_RMA_STATUSES]))),
    ]);

    const books = { feldart: { open: 0, overdue: 0, invoices: 0, oldestOverdueDue: null as string | null, credits: 0 }, tj: { open: 0, overdue: 0, invoices: 0, oldestOverdueDue: null as string | null, credits: 0 } };
    let futureDated = 0;
    for (const inv of open) {
      const b = books[inv.origin];
      const bal = num(inv.balance);
      b.open += bal;
      b.invoices += 1;
      const due = dayOf(inv.dueDate);
      if (due && due < today) {
        b.overdue += bal;
        if (!b.oldestOverdueDue || due < b.oldestOverdueDue) b.oldestOverdueDue = due;
      }
      const issued = dayOf(inv.issueDate);
      if (issued && issued > today) futureDated += 1;
    }
    for (const cr of credits) books[cr.origin].credits += num(cr.balance);
    const round = (b: typeof books.feldart) => ({
      ...b,
      open: money(b.open),
      overdue: money(b.overdue),
      credits: money(b.credits),
      net: money(b.open - b.credits),
    });

    return {
      customer: { id, ...c, holdStatus: HOLD_LABEL[c.holdStatus] ?? c.holdStatus, url: `${ctx.baseUrl}/customers/${id}` },
      asOf: ctx.now.toISOString(),
      currency: "USD",
      books: { feldart: round(books.feldart), tj: round(books.tj) },
      lastPayment: lastPay[0] ? { date: dayOf(lastPay[0].txnDate), amount: money(num(lastPay[0].total)) } : null,
      rmasInProgress: openRmas.map((r) => ({
        rma: r.rmaNumber,
        status: r.status,
        value: money(num(r.totalValue)),
        url: `${ctx.baseUrl}/returns/${r.id}`,
      })),
      warnings:
        futureDated > 0
          ? [`${futureDated} open invoice(s) are dated in the future (QuickBooks placeholders) and are counted as not yet due.`]
          : [],
    };
  },
};

const openInvoicesTool: ToolDef = {
  name: "open_invoices",
  description:
    "Every unpaid invoice and unapplied credit for one customer — the same documents as their statement — with dates, days overdue, original amount and balance. Use when the user wants the detail behind a balance or which invoices are outstanding.",
  input_schema: {
    type: "object",
    properties: { customerId: CUSTOMER_ID_PROP, book: BOOK_PROP },
    required: ["customerId"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(z.object({ customerId, book }), input);
    try {
      return tableResult(await loadOpenInvoices({ ...p, now: ctx.now }));
    } catch (err) {
      if (err instanceof Error && err.message === "customer not found") {
        throw new ToolInputError("customerId: no such customer. Use find_customer first.");
      }
      throw err;
    }
  },
};

/** Debtor rows by total open (desc) or by 90+ exposure then total (desc). */
export function sortDebtorRows<R extends Record<string, unknown>>(rows: R[], by: "total" | "over90"): R[] {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return [...rows].sort((a, b) =>
    by === "total"
      ? n(b.total) - n(a.total)
      : n(b.d90plus) - n(a.d90plus) || n(b.total) - n(a.total),
  );
}

const agedDebtorsTool: ToolDef = {
  name: "aged_debtors",
  description:
    "Who owes Feldart money: one row per customer and book with the open balance split into current / 1-30 / 31-60 / 61-90 / 90+ days past due, unapplied credits, net owed and account status. `sort`: \"total\" (default — biggest total open balance first, for \"who owes us the most\") or \"over90\" (most 90+ day debt first, for collections / \"who is most overdue\"). `top` limits the number of rows (default 25); totals always cover everyone.",
  input_schema: {
    type: "object",
    properties: {
      book: BOOK_PROP,
      top: { type: "integer", minimum: 1, maximum: 200, description: "How many rows to return after sorting. Default 25." },
      sort: { type: "string", enum: ["total", "over90"], description: "total = biggest open balance first (default); over90 = most 90+ day debt first." },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(
      z.object({ book, top: z.number().int().min(1).max(200).default(25), sort: z.enum(["total", "over90"]).default("total") }),
      input,
    );
    const t = await loadAgedDebtors({
      book: p.book,
      now: ctx.now,
      customerUrl: (id) => `${ctx.baseUrl}/customers/${id}`,
    });
    const total = t.rows.length;
    const sorted = sortDebtorRows(t.rows, p.sort);
    const result = tableResult({ ...t, rows: sorted.slice(0, p.top) });
    return {
      ...result,
      warnings:
        total > p.top
          ? [...result.warnings, `Top ${p.top} of ${total} rows shown (sorted by ${p.sort === "total" ? "total open balance" : "90+ day debt"}); totals cover all ${total}.`]
          : result.warnings,
    };
  },
};

const returnsTool: ToolDef = {
  name: "returns",
  description:
    "Returns (RMAs) raised in a date range, from Finance's RMA records: per RMA (number, customer, status, type, units, value, credit memo) or per returned line (SKU, product, qty, reason, original invoice). Optionally for one customer. Denied/cancelled RMAs are listed but excluded from totals. Return requests that only exist as emails are NOT here (that's an inbox tool).",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date YYYY-MM-DD (inclusive), on the RMA's created date." },
      to: { type: "string", description: "End date YYYY-MM-DD (inclusive)." },
      customerId: CUSTOMER_ID_PROP,
      view: { type: "string", enum: ["rmas", "lines"], description: "rmas = one row per RMA (default); lines = one row per returned SKU." },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(
      z
        .object({ from: isoDate, to: isoDate, customerId: customerId.optional(), view: z.enum(["rmas", "lines"]).default("rmas") })
        .refine((v) => v.from <= v.to, { message: "from must be on or before to", path: ["from"] }),
      input,
    );
    return tableResult(
      await loadReturnsReport({ ...p, now: ctx.now, rmaUrl: (id) => `${ctx.baseUrl}/returns/${id}` }),
    );
  },
};

// Customer purchase history from invoice lines, grouped by SKU. Relies on
// the 2026-10-15 sync fix (invoice_lines.sku = the real code); rows still
// awaiting the one-off rewrite are reported, not guessed.
export type HistoryLineInput = {
  sku: string | null;
  itemName: string | null;
  description: string | null;
  qty: string | number | null;
  unitPrice: string | number | null;
  lineTotal: string | number | null;
  issueDate: Date | string | null;
  origin: "feldart" | "tj";
};

export function buildCustomerHistory(lines: HistoryLineInput[]) {
  type Acc = { sku: string | null; product: string | null; qty: number; value: number; invoices: number; lastDate: string | null; lastUnitPrice: number | null; books: Set<string> };
  const by = new Map<string, Acc>();
  for (const l of lines) {
    const key = l.sku ?? `name:${l.itemName ?? l.description ?? "?"}`;
    const a = by.get(key) ?? { sku: l.sku, product: l.itemName ?? l.description, qty: 0, value: 0, invoices: 0, lastDate: null, lastUnitPrice: null, books: new Set<string>() };
    a.qty += num(l.qty);
    a.value += num(l.lineTotal);
    a.invoices += 1;
    a.books.add(l.origin);
    const d = dayOf(l.issueDate);
    if (d && (!a.lastDate || d >= a.lastDate)) {
      a.lastDate = d;
      a.lastUnitPrice = l.unitPrice === null ? null : money(num(l.unitPrice));
    }
    by.set(key, a);
  }
  return [...by.values()]
    .sort((x, y) => y.value - x.value)
    .map((a) => ({
      sku: a.sku,
      product: a.product,
      qty: Math.round(a.qty * 1000) / 1000,
      value: money(a.value),
      lines: a.invoices,
      lastBought: a.lastDate,
      lastUnitPrice: a.lastUnitPrice,
      books: [...a.books].sort().join("+"),
    }));
}

const customerHistory: ToolDef = {
  name: "customer_history",
  description:
    "What one customer bought from Feldart, from QuickBooks invoice lines: one row per SKU with total quantity, value, number of lines, last purchase date and last unit price, biggest first. Optional date range on the invoice date. Use for \"what does X usually order\", \"what did X buy for Rosh Hashanah\", reorder suggestions. Shipping/fees appear without a SKU.",
  input_schema: {
    type: "object",
    properties: {
      customerId: CUSTOMER_ID_PROP,
      from: { type: "string", description: "Optional start date YYYY-MM-DD (invoice date, inclusive)." },
      to: { type: "string", description: "Optional end date YYYY-MM-DD (inclusive). Defaults to today." },
    },
    required: ["customerId"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const today = isoDay(ctx.now);
    const p = parse(
      z
        .object({ customerId, from: isoDate.optional(), to: isoDate.optional() })
        .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "from must be on or before to", path: ["from"] }),
      input,
    );
    const to = p.to && p.to < today ? p.to : today; // future-dated invoices are QBO placeholders
    const [c] = await db.select({ name: customers.displayName }).from(customers).where(eq(customers.id, p.customerId)).limit(1);
    if (!c) throw new ToolInputError("customerId: no such customer. Use find_customer first.");

    const conds = [
      eq(invoices.customerId, p.customerId),
      ne(invoices.status, "void"),
      isNotNull(invoices.issueDate),
      lte(invoices.issueDate, new Date(`${to}T00:00:00Z`)),
    ];
    if (p.from) conds.push(gte(invoices.issueDate, new Date(`${p.from}T00:00:00Z`)));
    const rows = await db
      .select({
        sku: invoiceLines.sku,
        itemName: invoiceLines.itemName,
        description: invoiceLines.description,
        qty: invoiceLines.qty,
        unitPrice: invoiceLines.unitPrice,
        lineTotal: invoiceLines.lineTotal,
        skuSource: invoiceLines.skuSource,
        issueDate: invoices.issueDate,
        origin: invoices.origin,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(...conds));

    const pending = rows.filter((r) => r.skuSource === null).length;
    const usable = rows.filter((r) => r.skuSource !== null);
    const items = buildCustomerHistory(usable);
    const { rows: kept, note } = fitRows(items, RESULT_BUDGET_BYTES - 3_000);
    const warnings: string[] = [];
    if (pending > 0) {
      warnings.push(
        `${pending} of ${rows.length} invoice lines are still waiting for the SKU rebuild (next QuickBooks sync) and are left out.`,
      );
    }
    if (note) warnings.push(note);
    if (rows.length === 0) warnings.push("No invoices for this customer in that range.");
    return {
      customer: { id: p.customerId, name: c.name, url: `${ctx.baseUrl}/customers/${p.customerId}` },
      range: { from: p.from ?? null, to },
      currency: "USD",
      totals: {
        value: money(items.reduce((s, i) => s + i.value, 0)),
        skus: items.filter((i) => i.sku).length,
      },
      items: kept,
      warnings,
    };
  },
};

export const FINANCE_TOOLS: ToolDef[] = [
  findCustomer,
  customerSummary,
  openInvoicesTool,
  agedDebtorsTool,
  returnsTool,
  customerHistory,
];

export function toolManifest(): { tools: Array<Pick<ToolDef, "name" | "description" | "input_schema">> } {
  return {
    tools: FINANCE_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
  };
}

export function toolByName(name: string): ToolDef | undefined {
  return FINANCE_TOOLS.find((t) => t.name === name);
}
