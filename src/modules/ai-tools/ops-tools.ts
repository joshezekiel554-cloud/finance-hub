// Feldart AI OPS tools (radio build 2026-11-03, Josh's go): read tools for
// the hub's ops agent — invoice lookup with a PDF link, customer payments,
// and RMA status (open RMAs, returns waiting to be processed, return
// tracking). Same contract as finance-tools.ts, but only listed/served to
// members the hub marks ops:true AND finance's FINANCE_AI_OPS_EMAILS has
// (see routes/ext-tools.ts). Read-only: nothing here changes data.

import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { invoices } from "../../db/schema/invoices.js";
import { payments } from "../../db/schema/payments.js";
import { extensivReceipts, rmas, type RmaStatus } from "../../db/schema/returns.js";
import { QboClient } from "../../integrations/qb/client.js";
import type { QboPayment } from "../../integrations/qb/types.js";
import { pdfFileName } from "../../lib/file-link.js";
import { createLogger } from "../../lib/logger.js";
import { dayOf, isoDay, money, num } from "../reports/table.js";
import {
  CUSTOMER_ID_PROP,
  customerId,
  fitRows,
  isoDate,
  parse,
  RESULT_BUDGET_BYTES,
  ToolInputError,
  type PdfLink,
  type ToolDef,
} from "./finance-tools.js";

const log = createLogger({ component: "ai-tools.ops" });

const BOOK_LABEL = { feldart: "Feldart", tj: "Torah Judaica" } as const;
const DAY_MS = 86_400_000;

function daysBetween(fromDay: string | null, toDay: string): number | null {
  if (!fromDay) return null;
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// find_invoice

/** "#1234", "INV 1234", "invoice no. 1234", " 1234 " → "1234". */
export function normalizeDocNumber(raw: string): string {
  return raw
    .trim()
    .replace(/^(invoice|inv|credit\s*memo|cm)\b\.?\s*(no\.?|number|#)?\s*[:#-]?\s*/i, "")
    .replace(/^#\s*/, "")
    .trim();
}

export type InvoiceState = "void" | "paid" | "overdue" | "open";

export function invoiceState(
  inv: { status: string | null; balance: string | number; dueDate: Date | string | null },
  today: string,
): InvoiceState {
  if (inv.status === "void") return "void";
  if (num(inv.balance) <= 0) return "paid";
  const due = dayOf(inv.dueDate);
  return due && due < today ? "overdue" : "open";
}

type DocRow = {
  type: "invoice" | "credit_memo";
  /** Finance id — pass to send_invoice_qbo / dismiss_email_review. */
  invoiceId?: string;
  number: string | null;
  book: string;
  customer: string;
  customerId: string;
  date: string | null;
  dueDate: string | null;
  total: number;
  balance: number;
  state: InvoiceState | "unapplied" | "applied";
  daysOverdue: number | null;
  pdf: PdfLink | null;
  customerUrl: string;
};

const findInvoice: ToolDef = {
  name: "find_invoice",
  ops: true,
  description:
    "Find a QuickBooks invoice (or credit memo) and get its PDF. Give `number` for a specific document (e.g. \"1234\", \"#1234\"), or `customerId` (from find_customer) for that customer's invoices, newest first, optionally in a date range and/or only unpaid ones. Each document comes back with book (Feldart / Torah Judaica), dates, total, balance, state (open / overdue / paid / void) and a `pdf` download link valid for 15 minutes — give the user that link; don't paste invoice contents from memory. Data is the finance mirror of QuickBooks (synced every 30 min).",
  input_schema: {
    type: "object",
    properties: {
      number: { type: "string", description: "Invoice or credit memo number, e.g. \"10234\"." },
      customerId: CUSTOMER_ID_PROP,
      from: { type: "string", description: "Optional start date YYYY-MM-DD (invoice date, inclusive). With customerId only." },
      to: { type: "string", description: "Optional end date YYYY-MM-DD (inclusive). With customerId only." },
      unpaidOnly: { type: "boolean", description: "With customerId: only invoices with a balance still owed." },
      limit: { type: "integer", minimum: 1, maximum: 25, description: "Max documents (default 10)." },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(
      z
        .object({
          number: z.string().trim().min(1).max(64).optional(),
          customerId: customerId.optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          unpaidOnly: z.boolean().default(false),
          limit: z.number().int().min(1).max(25).default(10),
        })
        .refine((v) => v.number || v.customerId, { message: "give a number or a customerId", path: ["number"] })
        .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "from must be on or before to", path: ["from"] }),
      input,
    );
    const today = isoDay(ctx.now);
    const docNumber = p.number ? normalizeDocNumber(p.number) : null;
    if (p.number && !docNumber) throw new ToolInputError("number: not a document number");

    const invConds = [];
    if (docNumber) invConds.push(eq(invoices.docNumber, docNumber));
    if (p.customerId) invConds.push(eq(invoices.customerId, p.customerId));
    if (p.from) invConds.push(gte(invoices.issueDate, new Date(`${p.from}T00:00:00Z`)));
    if (p.to) invConds.push(lte(invoices.issueDate, new Date(`${p.to}T00:00:00Z`)));
    if (p.unpaidOnly) invConds.push(sql`${invoices.balance} > 0`, ne(invoices.status, "void"));

    const invRows = await db
      .select({
        id: invoices.id,
        qbId: invoices.qbInvoiceId,
        number: invoices.docNumber,
        origin: invoices.origin,
        customerId: invoices.customerId,
        customer: customers.displayName,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        total: invoices.total,
        balance: invoices.balance,
        status: invoices.status,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(...invConds))
      .orderBy(desc(invoices.issueDate))
      .limit(p.limit + 1);

    // A bare number may be a credit memo instead (customer-scoped lists stay invoices-only).
    const cmRows = docNumber
      ? await db
          .select({
            qbId: creditMemos.qbCreditMemoId,
            number: creditMemos.docNumber,
            origin: creditMemos.origin,
            customerId: creditMemos.customerId,
            customer: customers.displayName,
            txnDate: creditMemos.txnDate,
            total: creditMemos.total,
            balance: creditMemos.balance,
          })
          .from(creditMemos)
          .innerJoin(customers, eq(customers.id, creditMemos.customerId))
          .where(
            p.customerId
              ? and(eq(creditMemos.docNumber, docNumber), eq(creditMemos.customerId, p.customerId))
              : eq(creditMemos.docNumber, docNumber),
          )
          .limit(5)
      : [];

    const link = (kind: "invoice" | "creditmemo", qbId: string, label: string) =>
      ctx.signPdf ? ctx.signPdf(kind, qbId, pdfFileName(label)) : null;

    const docs: DocRow[] = [
      ...invRows.slice(0, p.limit).map((r): DocRow => {
        const state = invoiceState(r, today);
        const due = dayOf(r.dueDate);
        return {
          type: "invoice",
          invoiceId: r.id,
          number: r.number,
          book: BOOK_LABEL[r.origin],
          customer: r.customer,
          customerId: r.customerId,
          date: dayOf(r.issueDate),
          dueDate: due,
          total: money(num(r.total)),
          balance: money(num(r.balance)),
          state,
          daysOverdue: state === "overdue" ? daysBetween(due, today) : null,
          pdf: link("invoice", r.qbId, `Invoice ${r.number ?? r.qbId} - ${r.customer}`),
          customerUrl: `${ctx.baseUrl}/customers/${r.customerId}`,
        };
      }),
      ...cmRows.map((r): DocRow => ({
        type: "credit_memo",
        number: r.number,
        book: BOOK_LABEL[r.origin],
        customer: r.customer,
        customerId: r.customerId,
        date: dayOf(r.txnDate),
        dueDate: null,
        total: money(num(r.total)),
        balance: money(num(r.balance)),
        state: num(r.balance) > 0 ? "unapplied" : "applied",
        daysOverdue: null,
        pdf: link("creditmemo", r.qbId, `Credit memo ${r.number ?? r.qbId} - ${r.customer}`),
        customerUrl: `${ctx.baseUrl}/customers/${r.customerId}`,
      })),
    ];

    const warnings: string[] = [];
    if (docs.length === 0) {
      warnings.push(
        docNumber
          ? `No invoice or credit memo numbered "${docNumber}" in finance. It may be newer than the last QuickBooks sync (every 30 min), or the number may be different — try find_customer and list their invoices.`
          : "No invoices for this customer with those filters.",
      );
    }
    if (invRows.length > p.limit) warnings.push(`More than ${p.limit} invoices match; showing the newest ${p.limit}. Narrow the date range to see older ones.`);
    if (!ctx.signPdf) warnings.push("PDF links are unavailable right now (finance isn't configured to sign them).");

    const files = docs.flatMap((d) => (d.pdf ? [d.pdf] : [])).slice(0, 5);
    return {
      asOf: ctx.now.toISOString(),
      currency: "USD",
      documents: docs,
      ...(files.length === 1 ? { file: files[0] } : {}),
      files,
      warnings,
    };
  },
};

// ---------------------------------------------------------------------------
// customer_payments

/** Payment id → [{invoice qb id, amount}] from QBO payment lines. */
export function linkedInvoicesByPayment(
  qboPayments: QboPayment[],
): Map<string, Array<{ qbInvoiceId: string; amount: number }>> {
  const out = new Map<string, Array<{ qbInvoiceId: string; amount: number }>>();
  for (const p of qboPayments) {
    const lines: Array<{ qbInvoiceId: string; amount: number }> = [];
    for (const line of p.Line ?? []) {
      for (const l of line.LinkedTxn ?? []) {
        if (l.TxnType === "Invoice") lines.push({ qbInvoiceId: l.TxnId, amount: money(line.Amount ?? 0) });
      }
    }
    out.set(p.Id, lines);
  }
  return out;
}

const QBO_TIMEOUT_MS = 8_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const customerPayments: ToolDef = {
  name: "customer_payments",
  ops: true,
  description:
    "A customer's payments from QuickBooks, newest first: date, amount, method, reference, how it split across the Feldart / Torah Judaica books, and which invoices each payment paid. Also the days since their last payment, total paid in the last 90 days, and what they still owe (open and overdue per book). Use for \"when did X last pay\", \"what did X's last payment cover\", \"is X paying\".",
  input_schema: {
    type: "object",
    properties: {
      customerId: CUSTOMER_ID_PROP,
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many recent payments (default 10)." },
      from: { type: "string", description: "Optional start date YYYY-MM-DD (payment date, inclusive)." },
      to: { type: "string", description: "Optional end date YYYY-MM-DD (inclusive)." },
    },
    required: ["customerId"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(
      z
        .object({
          customerId,
          limit: z.number().int().min(1).max(50).default(10),
          from: isoDate.optional(),
          to: isoDate.optional(),
        })
        .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "from must be on or before to", path: ["from"] }),
      input,
    );
    const [c] = await db
      .select({ name: customers.displayName, qbCustomerId: customers.qbCustomerId })
      .from(customers)
      .where(eq(customers.id, p.customerId))
      .limit(1);
    if (!c) throw new ToolInputError("customerId: no such customer. Use find_customer first.");
    const today = isoDay(ctx.now);
    const since90 = isoDay(new Date(ctx.now.getTime() - 90 * DAY_MS));

    const conds = [eq(payments.customerId, p.customerId)];
    if (p.from) conds.push(gte(payments.txnDate, new Date(`${p.from}T00:00:00Z`)));
    if (p.to) conds.push(lte(payments.txnDate, new Date(`${p.to}T00:00:00Z`)));

    const [rows, last, paid90, open] = await Promise.all([
      db
        .select({
          qbPaymentId: payments.qbPaymentId,
          date: payments.txnDate,
          total: payments.total,
          method: payments.paymentMethod,
          reference: payments.docNumber,
          feldart: payments.feldartAmount,
          tj: payments.tjAmount,
          unallocated: payments.unallocatedAmount,
        })
        .from(payments)
        .where(and(...conds))
        .orderBy(desc(payments.txnDate))
        .limit(p.limit),
      db
        .select({ date: payments.txnDate, total: payments.total })
        .from(payments)
        .where(eq(payments.customerId, p.customerId))
        .orderBy(desc(payments.txnDate))
        .limit(1),
      db
        .select({ total: sql<string>`COALESCE(SUM(${payments.total}), 0)` })
        .from(payments)
        .where(and(eq(payments.customerId, p.customerId), gte(payments.txnDate, new Date(`${since90}T00:00:00Z`)))),
      db
        .select({ origin: invoices.origin, balance: invoices.balance, dueDate: invoices.dueDate })
        .from(invoices)
        .where(and(eq(invoices.customerId, p.customerId), sql`${invoices.balance} > 0`, ne(invoices.status, "void"))),
    ]);

    // Which invoices each payment paid isn't mirrored — read it live from QBO.
    const warnings: string[] = [];
    let linked: Map<string, Array<{ qbInvoiceId: string; amount: number }>> | null = null;
    if (rows.length > 0 && c.qbCustomerId) {
      try {
        linked = linkedInvoicesByPayment(
          await withTimeout(new QboClient().getPaymentsForCustomer(c.qbCustomerId), QBO_TIMEOUT_MS),
        );
      } catch (err) {
        log.warn({ err, customerId: p.customerId }, "qbo payment lines unavailable");
        warnings.push("Couldn't reach QuickBooks for which invoices each payment paid; dates and amounts are from the last sync.");
      }
    }
    const invIds = [...new Set([...(linked?.values() ?? [])].flat().map((l) => l.qbInvoiceId))];
    const docByQbId = new Map<string, string | null>();
    if (invIds.length > 0) {
      const found = await db
        .select({ qbId: invoices.qbInvoiceId, number: invoices.docNumber })
        .from(invoices)
        .where(inArray(invoices.qbInvoiceId, invIds));
      for (const f of found) docByQbId.set(f.qbId, f.number);
    }

    const owed = { feldart: { open: 0, overdue: 0 }, tj: { open: 0, overdue: 0 } };
    for (const inv of open) {
      const bal = num(inv.balance);
      owed[inv.origin].open += bal;
      const due = dayOf(inv.dueDate);
      if (due && due < today) owed[inv.origin].overdue += bal;
    }
    const lastDate = last[0] ? dayOf(last[0].date) : null;

    const list = rows.map((r) => ({
      date: dayOf(r.date),
      amount: money(num(r.total)),
      method: r.method,
      reference: r.reference,
      books: { feldart: money(num(r.feldart)), tj: money(num(r.tj)), unallocated: money(num(r.unallocated)) },
      invoicesPaid:
        linked === null
          ? null
          : (linked.get(r.qbPaymentId) ?? []).map((l) => ({ invoice: docByQbId.get(l.qbInvoiceId) ?? `QBO #${l.qbInvoiceId}`, amount: l.amount })),
    }));
    const { rows: kept, note } = fitRows(list, RESULT_BUDGET_BYTES - 3_000);
    if (note) warnings.push(note);
    if (rows.length === 0) warnings.push(lastDate ? "No payments in that range." : "No payments on record for this customer.");

    return {
      customer: { id: p.customerId, name: c.name, url: `${ctx.baseUrl}/customers/${p.customerId}` },
      asOf: ctx.now.toISOString(),
      currency: "USD",
      lastPayment: last[0] ? { date: lastDate, amount: money(num(last[0].total)), daysAgo: daysBetween(lastDate, today) } : null,
      paidLast90Days: money(num(paid90[0]?.total ?? 0)),
      stillOwed: {
        feldart: { open: money(owed.feldart.open), overdue: money(owed.feldart.overdue) },
        tj: { open: money(owed.tj.open), overdue: money(owed.tj.overdue) },
      },
      payments: kept,
      warnings,
    };
  },
};

// ---------------------------------------------------------------------------
// RMAs

export const RMA_STATUS_LABEL: Record<RmaStatus, string> = {
  draft: "Draft (not approved yet)",
  approved: "Approved — waiting for the customer to send it back",
  awaiting_warehouse_number: "Approved — waiting for the warehouse return number",
  sent_to_warehouse: "Sent to warehouse — expecting the parcel",
  received: "Received at warehouse — needs credit / closing",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
};

const RETURN_TYPE_LABEL = { damage: "Damage", seasonal: "Seasonal", non_seasonal: "Non-seasonal" } as const;

/** Statuses where the customer is still expected to ship goods back. */
export const AWAITING_PARCEL_STATUSES = ["approved", "awaiting_warehouse_number", "sent_to_warehouse"] as const;

type RmaQueryRow = {
  id: string;
  rmaNumber: string | null;
  customerId: string;
  customer: string;
  email: string | null;
  returnType: keyof typeof RETURN_TYPE_LABEL;
  status: RmaStatus;
  totalValue: string;
  createdAt: Date;
  approvedAt: Date | null;
  sentToWarehouseAt: Date | null;
  receivedAtWarehouseAt: Date | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  trackingSavedAt: Date | null;
  creditMemoDocNumber: string | null;
  extensivRef: string | null;
};

/** One RMA as the model sees it. `daysOpen` counts from approval (else creation). */
export function rmaRow(r: RmaQueryRow, today: string, baseUrl: string) {
  const created = dayOf(r.createdAt);
  const approved = dayOf(r.approvedAt);
  const received = dayOf(r.receivedAtWarehouseAt);
  return {
    rmaId: r.id,
    rma: r.rmaNumber,
    customer: r.customer,
    customerEmail: r.email,
    type: RETURN_TYPE_LABEL[r.returnType],
    status: RMA_STATUS_LABEL[r.status],
    value: money(num(r.totalValue)),
    created,
    approved,
    sentToWarehouse: dayOf(r.sentToWarehouseAt),
    receivedAtWarehouse: received,
    daysOpen: daysBetween(approved ?? created, today),
    tracking: r.trackingNumber
      ? { number: r.trackingNumber, carrier: r.trackingCarrier, saved: dayOf(r.trackingSavedAt) }
      : null,
    creditMemo: r.creditMemoDocNumber,
    warehouseRef: r.extensivRef,
    url: `${baseUrl}/returns/${r.id}`,
  };
}

export async function loadRmas(statuses: readonly RmaStatus[], opts: { customerId?: string; returnType?: string }) {
  const conds = [inArray(rmas.status, [...statuses])];
  if (opts.customerId) conds.push(eq(rmas.customerId, opts.customerId));
  if (opts.returnType) conds.push(eq(rmas.returnType, opts.returnType as RmaQueryRow["returnType"]));
  return db
    .select({
      id: rmas.id,
      rmaNumber: rmas.rmaNumber,
      customerId: rmas.customerId,
      customer: customers.displayName,
      email: customers.primaryEmail,
      returnType: rmas.returnType,
      status: rmas.status,
      totalValue: rmas.totalValue,
      createdAt: rmas.createdAt,
      approvedAt: rmas.approvedAt,
      sentToWarehouseAt: rmas.sentToWarehouseAt,
      receivedAtWarehouseAt: rmas.receivedAtWarehouseAt,
      trackingNumber: rmas.trackingNumber,
      trackingCarrier: rmas.trackingCarrier,
      trackingSavedAt: rmas.trackingSavedAt,
      creditMemoDocNumber: rmas.creditMemoDocNumber,
      extensivRef: rmas.extensivRef,
    })
    .from(rmas)
    .innerJoin(customers, eq(customers.id, rmas.customerId))
    .where(and(...conds))
    .orderBy(asc(sql`COALESCE(${rmas.approvedAt}, ${rmas.createdAt})`));
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

const returnTypeSchema = z.enum(["damage", "seasonal", "non_seasonal"]).optional();
const RETURN_TYPE_PROP = {
  type: "string",
  enum: ["damage", "seasonal", "non_seasonal"],
  description: "Optional: only this kind of return.",
};

const openRmas: ToolDef = {
  name: "open_rmas",
  ops: true,
  description:
    "Every RMA (return authorisation) that is still open in Finance — approved but not yet completed, denied or cancelled — oldest first, with status in plain words (waiting for the customer / for a warehouse number / parcel expected / received and needs credit), days open, value, return tracking if the customer sent it, credit memo and link. Optionally one customer or one return type; `includeDrafts` adds RMAs not approved yet.",
  input_schema: {
    type: "object",
    properties: {
      customerId: CUSTOMER_ID_PROP,
      returnType: RETURN_TYPE_PROP,
      includeDrafts: { type: "boolean", description: "Also list draft RMAs that haven't been approved. Default false." },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(
      z.object({ customerId: customerId.optional(), returnType: returnTypeSchema, includeDrafts: z.boolean().default(false) }),
      input,
    );
    const statuses: RmaStatus[] = [...(p.includeDrafts ? (["draft"] as const) : []), ...AWAITING_PARCEL_STATUSES, "received"];
    const today = isoDay(ctx.now);
    const found = await loadRmas(statuses, p);
    const list = found.map((r) => rmaRow(r, today, ctx.baseUrl));
    const { rows, note } = fitRows(list, RESULT_BUDGET_BYTES - 3_000);
    return {
      asOf: ctx.now.toISOString(),
      currency: "USD",
      count: list.length,
      byStatus: countBy(list, (r) => r.status),
      totalValue: money(list.reduce((s, r) => s + r.value, 0)),
      rmas: rows,
      warnings: [
        ...(list.length === 0 ? ["No open RMAs."] : []),
        ...(note ? [note] : []),
        "US/Feldart RMAs only. UK returns are tracked in the inbox app (open_uk_returns).",
      ],
    };
  },
};

const RECEIPT_CAP = 50;

const openReturns: ToolDef = {
  name: "open_returns",
  ops: true,
  description:
    "Returns waiting to be processed: (1) RMAs whose goods have arrived at the warehouse but haven't been credited/closed yet, oldest arrival first, and (2) warehouse return receipts (from Extensiv emails) that aren't tied to an RMA yet or are matched but still need a person to confirm. Use for \"what returns still need processing\", \"what came back to the warehouse that we haven't dealt with\".",
  input_schema: {
    type: "object",
    properties: { customerId: CUSTOMER_ID_PROP },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(z.object({ customerId: customerId.optional() }), input);
    const today = isoDay(ctx.now);
    const received = (await loadRmas(["received"], p))
      .map((r) => rmaRow(r, today, ctx.baseUrl))
      .map((r) => ({ ...r, daysSinceReceived: daysBetween(r.receivedAtWarehouse, today) }))
      .sort((a, b) => (b.daysSinceReceived ?? 0) - (a.daysSinceReceived ?? 0));

    // Receipts aren't customer-keyed (only an inferred name), so the
    // customer filter applies to RMAs only.
    const receipts = p.customerId
      ? []
      : await db
          .select({
            receiptId: extensivReceipts.id,
            txNumber: extensivReceipts.txNumber,
            ref: extensivReceipts.refString,
            customerGuess: extensivReceipts.inferredCustomerName,
            matchKind: extensivReceipts.matchKind,
            rmaId: extensivReceipts.rmaId,
            rmaNumber: rmas.rmaNumber,
            classifiedAt: extensivReceipts.classifiedAt,
          })
          .from(extensivReceipts)
          .leftJoin(rmas, eq(rmas.id, extensivReceipts.rmaId))
          .where(and(isNull(extensivReceipts.dismissedAt), isNull(extensivReceipts.confirmedAt)))
          .orderBy(asc(extensivReceipts.classifiedAt))
          .limit(RECEIPT_CAP + 1);

    const receiptsCapped = receipts.length > RECEIPT_CAP;
    const receiptRows = receipts.slice(0, RECEIPT_CAP).map((r) => ({
      receiptId: r.receiptId,
      warehouseTx: r.txNumber,
      ref: r.ref,
      customerGuess: r.customerGuess,
      received: dayOf(r.classifiedAt),
      daysWaiting: daysBetween(dayOf(r.classifiedAt), today),
      state: r.rmaId ? `Matched to RMA ${r.rmaNumber ?? "(unnumbered)"} — needs confirming` : "Not matched to any RMA",
    }));
    const { rows, note } = fitRows(received, RESULT_BUDGET_BYTES - 12_000);
    return {
      asOf: ctx.now.toISOString(),
      currency: "USD",
      receivedNotClosed: { count: received.length, value: money(received.reduce((s, r) => s + r.value, 0)), rmas: rows },
      warehouseReceiptsToReview: {
        count: receiptsCapped ? `more than ${RECEIPT_CAP}` : receiptRows.length,
        receipts: receiptRows,
        reviewUrl: `${ctx.baseUrl}/returns`,
      },
      warnings: [
        ...(note ? [note] : []),
        ...(receiptsCapped ? [`Showing the oldest ${RECEIPT_CAP} warehouse receipts to review; there are more. Open the Returns page for the full queue.`] : []),
        ...(p.customerId ? ["Warehouse receipts aren't filtered by customer, so they're left out when a customer is given."] : []),
        ...(received.length === 0 && receiptRows.length === 0 ? ["Nothing waiting to be processed."] : []),
      ],
    };
  },
};

const rmaTrackingStatus: ToolDef = {
  name: "rma_tracking_status",
  ops: true,
  description:
    "For RMAs where the customer still has to send goods back (approved, waiting for a warehouse number, or sent to the warehouse), whether we have their return tracking yet. Lists RMAs WITHOUT tracking (oldest first, with days waiting and the customer's email to chase) and RMAs WITH tracking (number, carrier, date saved). Tracking counts once someone saves it on the RMA in Finance — a tracking number sitting unread in an email isn't counted. `missingOnly` drops the ones that have tracking.",
  input_schema: {
    type: "object",
    properties: {
      customerId: CUSTOMER_ID_PROP,
      returnType: RETURN_TYPE_PROP,
      missingOnly: { type: "boolean", description: "Only RMAs still missing tracking. Default false." },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(
      z.object({ customerId: customerId.optional(), returnType: returnTypeSchema, missingOnly: z.boolean().default(false) }),
      input,
    );
    const today = isoDay(ctx.now);
    const all = (await loadRmas(AWAITING_PARCEL_STATUSES, p)).map((r) => rmaRow(r, today, ctx.baseUrl));
    const missing = all.filter((r) => !r.tracking);
    const withTracking = p.missingOnly ? [] : all.filter((r) => r.tracking);
    const half = RESULT_BUDGET_BYTES / 2 - 2_000;
    const m = fitRows(missing, p.missingOnly ? half * 2 : half);
    const w = fitRows(withTracking, half);
    return {
      asOf: ctx.now.toISOString(),
      awaitingParcel: all.length,
      missingTracking: { count: missing.length, rmas: m.rows },
      haveTracking: { count: all.length - missing.length, rmas: w.rows },
      warnings: [
        ...[m.note, w.note].filter((n): n is string => n !== null),
        ...(all.length === 0 ? ["No RMAs are waiting on a parcel from the customer."] : []),
      ],
    };
  },
};

export const OPS_TOOLS: ToolDef[] = [findInvoice, customerPayments, openRmas, openReturns, rmaTrackingStatus];

