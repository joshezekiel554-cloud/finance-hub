// The one "Money" summary both the finance dashboard and the hub's Finance
// panel read (operator, 2026-09-14): per book (Feldart / Torah Judaica /
// total) → overdue, current due, due in the next 7 days, received in the
// last 30 days. SQL groups; buildMoneySummary shapes (pure, tested).
//
// Definitions:
//   overdue     = open balance whose due date is before today
//   current due = open balance not yet past due (or with no due date)
//   due next 7  = open balance due today .. today+6
//   received 30 = QBO payments by transaction date, last 30 days, split by
//                 the invoices they were applied to (payments table);
//                 the total row also carries the unallocated remainder.
// "Today" is the MySQL server date (CURDATE()), matching the overdue_balance
// recompute in qb/sync.ts so the two never disagree.

import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";

export type Book = "feldart" | "tj";

export type InvoiceAggRow = {
  origin: Book;
  overdueAmount: string | number | null;
  overdueInvoices: number | string | null;
  overdueCustomers: number | string | null;
  currentDueAmount: string | number | null;
  currentDueInvoices: number | string | null;
  dueNext7Amount: string | number | null;
  dueNext7Invoices: number | string | null;
};

export type PaymentAggRow = {
  feldart: string | number | null;
  tj: string | number | null;
  unallocated: string | number | null;
  total: string | number | null;
  count: number | string | null;
};

export type BookMoney = {
  overdue: { amount: string; invoices: number; customers: number };
  currentDue: { amount: string; invoices: number };
  dueNext7: { amount: string; invoices: number };
  received30: { amount: string };
};

export type MoneySummary = {
  feldart: BookMoney;
  tj: BookMoney;
  total: BookMoney & { received30: { amount: string; payments: number; unallocated: string } };
  windowDays: 30;
  syncedAt: { invoices: string | null; payments: string | null };
  generatedAt: string;
};

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
const int = (v: number | string | null | undefined): number => Math.trunc(num(v));

function emptyBook(): BookMoney {
  return {
    overdue: { amount: "0.00", invoices: 0, customers: 0 },
    currentDue: { amount: "0.00", invoices: 0 },
    dueNext7: { amount: "0.00", invoices: 0 },
    received30: { amount: "0.00" },
  };
}

export function buildMoneySummary(input: {
  invoiceRows: InvoiceAggRow[];
  paymentRow: PaymentAggRow | null;
  invoicesSyncedAt: Date | null;
  paymentsSyncedAt: Date | null;
  now: Date;
}): MoneySummary {
  const books: Record<Book, BookMoney> = { feldart: emptyBook(), tj: emptyBook() };
  for (const r of input.invoiceRows) {
    const b = books[r.origin];
    if (!b) continue;
    b.overdue = { amount: money(num(r.overdueAmount)), invoices: int(r.overdueInvoices), customers: int(r.overdueCustomers) };
    b.currentDue = { amount: money(num(r.currentDueAmount)), invoices: int(r.currentDueInvoices) };
    b.dueNext7 = { amount: money(num(r.dueNext7Amount)), invoices: int(r.dueNext7Invoices) };
  }
  const p = input.paymentRow;
  books.feldart.received30 = { amount: money(num(p?.feldart)) };
  books.tj.received30 = { amount: money(num(p?.tj)) };

  const sumAmt = (a: string, b: string) => money(num(a) + num(b));
  const total: MoneySummary["total"] = {
    overdue: {
      amount: sumAmt(books.feldart.overdue.amount, books.tj.overdue.amount),
      invoices: books.feldart.overdue.invoices + books.tj.overdue.invoices,
      customers: books.feldart.overdue.customers + books.tj.overdue.customers,
    },
    currentDue: {
      amount: sumAmt(books.feldart.currentDue.amount, books.tj.currentDue.amount),
      invoices: books.feldart.currentDue.invoices + books.tj.currentDue.invoices,
    },
    dueNext7: {
      amount: sumAmt(books.feldart.dueNext7.amount, books.tj.dueNext7.amount),
      invoices: books.feldart.dueNext7.invoices + books.tj.dueNext7.invoices,
    },
    received30: {
      amount: money(num(p?.total)),
      payments: int(p?.count),
      unallocated: money(num(p?.unallocated)),
    },
  };

  return {
    feldart: books.feldart,
    tj: books.tj,
    total,
    windowDays: 30,
    syncedAt: {
      invoices: input.invoicesSyncedAt ? input.invoicesSyncedAt.toISOString() : null,
      payments: input.paymentsSyncedAt ? input.paymentsSyncedAt.toISOString() : null,
    },
    generatedAt: input.now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const rowsOf = (res: unknown): Row[] => {
  // mysql2 execute() returns [rows, fields]; drizzle's db.execute wraps as
  // { rows } in some versions. Handle both defensively.
  const r = res as { rows?: Row[] } | [Row[], unknown];
  if (Array.isArray(r)) return (r[0] ?? []) as Row[];
  return r.rows ?? [];
};

export async function loadMoneySummary(now: Date = new Date()): Promise<MoneySummary> {
  const [invRes, payRes, syncRes] = await Promise.all([
    db.execute(sql`
      SELECT origin,
        SUM(CASE WHEN due_date IS NOT NULL AND due_date < CURDATE() THEN balance ELSE 0 END) AS overdueAmount,
        SUM(CASE WHEN due_date IS NOT NULL AND due_date < CURDATE() THEN 1 ELSE 0 END) AS overdueInvoices,
        COUNT(DISTINCT CASE WHEN due_date IS NOT NULL AND due_date < CURDATE() THEN customer_id END) AS overdueCustomers,
        SUM(CASE WHEN due_date IS NULL OR due_date >= CURDATE() THEN balance ELSE 0 END) AS currentDueAmount,
        SUM(CASE WHEN due_date IS NULL OR due_date >= CURDATE() THEN 1 ELSE 0 END) AS currentDueInvoices,
        SUM(CASE WHEN due_date >= CURDATE() AND due_date < DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN balance ELSE 0 END) AS dueNext7Amount,
        SUM(CASE WHEN due_date >= CURDATE() AND due_date < DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS dueNext7Invoices
      FROM invoices
      WHERE balance > 0 AND status <> 'void'
      GROUP BY origin
    `),
    db.execute(sql`
      SELECT
        COALESCE(SUM(feldart_amount), 0) AS feldart,
        COALESCE(SUM(tj_amount), 0) AS tj,
        COALESCE(SUM(unallocated_amount), 0) AS unallocated,
        COALESCE(SUM(total), 0) AS total,
        COUNT(*) AS count
      FROM payments
      WHERE txn_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    `),
    db.execute(sql`
      SELECT (SELECT MAX(last_synced_at) FROM invoices) AS invoices,
             (SELECT MAX(last_synced_at) FROM payments) AS payments
    `),
  ]);

  const invoiceRows = rowsOf(invRes).map((r) => ({
    origin: (r.origin === "tj" ? "tj" : "feldart") as Book,
    overdueAmount: r.overdueAmount as string | null,
    overdueInvoices: r.overdueInvoices as number | null,
    overdueCustomers: r.overdueCustomers as number | null,
    currentDueAmount: r.currentDueAmount as string | null,
    currentDueInvoices: r.currentDueInvoices as number | null,
    dueNext7Amount: r.dueNext7Amount as string | null,
    dueNext7Invoices: r.dueNext7Invoices as number | null,
  }));
  const p = rowsOf(payRes)[0];
  const paymentRow: PaymentAggRow | null = p
    ? {
        feldart: p.feldart as string | null,
        tj: p.tj as string | null,
        unallocated: p.unallocated as string | null,
        total: p.total as string | null,
        count: p.count as number | null,
      }
    : null;
  const s = rowsOf(syncRes)[0] ?? {};
  const toDate = (v: unknown): Date | null => (v ? new Date(v as string) : null);

  return buildMoneySummary({
    invoiceRows,
    paymentRow,
    invoicesSyncedAt: toDate(s.invoices),
    paymentsSyncedAt: toDate(s.payments),
    now,
  });
}
