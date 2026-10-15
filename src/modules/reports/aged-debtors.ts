// Aged debtors (Feldart AI task G): one row per customer × book with the
// open balance bucketed by days past due, plus unapplied credits and a
// net figure. Same invoice scope as the dashboard Money card: balance > 0
// and not void.

import { and, gt, inArray, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import {
  dayOf,
  daysPastDue,
  isoDay,
  money,
  num,
  shapeRows,
  sumKeys,
  usd,
  type DateLike,
  type ReportRow,
  type ReportColumn,
  type ReportTable,
} from "./table.js";

export type Book = "feldart" | "tj";
export type BookScope = Book | "both";

export type AgedInvoiceInput = {
  customerId: string;
  origin: Book;
  issueDate: DateLike;
  dueDate: DateLike;
  balance: string | number;
};

export type AgedCreditInput = {
  customerId: string;
  origin: Book;
  balance: string | number;
};

export type AgedCustomerInput = {
  id: string;
  name: string;
  email: string | null;
  holdStatus: string | null;
};

export const AGED_DEBTOR_COLUMNS: ReportColumn[] = [
  { key: "customer", label: "Customer", type: "text" },
  { key: "book", label: "Book", type: "text" },
  usd("current", "Current"),
  usd("d1_30", "1-30 days"),
  usd("d31_60", "31-60 days"),
  usd("d61_90", "61-90 days"),
  usd("d90plus", "90+ days"),
  usd("total", "Total open"),
  usd("credits", "Unapplied credits (on debtor accounts)"),
  usd("net", "Net owed"),
  { key: "oldestDue", label: "Oldest due date", type: "date" },
  { key: "invoices", label: "Open invoices", type: "number" },
  { key: "hold", label: "Account status", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "url", label: "Finance link", type: "url" },
];

const MONEY_KEYS = ["current", "d1_30", "d31_60", "d61_90", "d90plus", "total", "credits", "net"];

export function bucketFor(days: number | null): "current" | "d1_30" | "d31_60" | "d61_90" | "d90plus" {
  if (days === null || days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90plus";
}

const BOOK_LABEL: Record<Book, string> = { feldart: "Feldart", tj: "Torah Judaica" };
const HOLD_LABEL: Record<string, string> = {
  active: "Active",
  hold: "On hold",
  payment_upfront: "Payment upfront",
};

export function buildAgedDebtors(input: {
  invoices: AgedInvoiceInput[];
  credits: AgedCreditInput[];
  customers: AgedCustomerInput[];
  books: Book[];
  now: Date;
  customerUrl: (id: string) => string;
}): ReportTable {
  const today = isoDay(input.now);
  const books = new Set(input.books);
  const byCustomer = new Map(input.customers.map((c) => [c.id, c]));

  type Acc = {
    customerId: string;
    book: Book;
    current: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90plus: number;
    credits: number;
    oldestDue: string | null;
    invoices: number;
  };
  const acc = new Map<string, Acc>();
  const get = (customerId: string, book: Book): Acc => {
    const k = `${customerId}|${book}`;
    let a = acc.get(k);
    if (!a) {
      a = {
        customerId,
        book,
        current: 0,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        d90plus: 0,
        credits: 0,
        oldestDue: null,
        invoices: 0,
      };
      acc.set(k, a);
    }
    return a;
  };

  let futureDated = 0;
  let futureAmount = 0;
  for (const inv of input.invoices) {
    if (!books.has(inv.origin)) continue;
    const bal = num(inv.balance);
    if (bal <= 0) continue;
    const a = get(inv.customerId, inv.origin);
    a[bucketFor(daysPastDue(inv.dueDate, today))] += bal;
    a.invoices += 1;
    const due = dayOf(inv.dueDate);
    if (due && (!a.oldestDue || due < a.oldestDue)) a.oldestDue = due;
    const issued = dayOf(inv.issueDate);
    if (issued && issued > today) {
      futureDated += 1;
      futureAmount += bal;
    }
  }
  // Credits only attach to customers who still owe on that book — a
  // credit-only customer isn't a debtor.
  for (const cr of input.credits) {
    const a = acc.get(`${cr.customerId}|${cr.origin}`);
    if (a) a.credits += num(cr.balance);
  }

  const records = [...acc.values()]
    .map((a) => {
      const c = byCustomer.get(a.customerId);
      const total = a.current + a.d1_30 + a.d31_60 + a.d61_90 + a.d90plus;
      const rec: ReportRow = {
        customer: c?.name ?? a.customerId,
        book: BOOK_LABEL[a.book],
        current: money(a.current),
        d1_30: money(a.d1_30),
        d31_60: money(a.d31_60),
        d61_90: money(a.d61_90),
        d90plus: money(a.d90plus),
        total: money(total),
        credits: money(-a.credits),
        net: money(total - a.credits),
        oldestDue: a.oldestDue,
        invoices: a.invoices,
        hold: HOLD_LABEL[c?.holdStatus ?? "active"] ?? c?.holdStatus ?? "Active",
        email: c?.email ?? null,
        url: input.customerUrl(a.customerId),
      };
      return { rec, sortKey: a.d90plus * 1e6 + total };
    })
    // Worst first: most 90+ exposure, then biggest total.
    .sort((x, y) => y.sortKey - x.sortKey)
    .map((x) => x.rec);

  const rows = shapeRows(AGED_DEBTOR_COLUMNS, records);
  const warnings: string[] = [];
  if (futureDated > 0) {
    warnings.push(
      `${futureDated} open invoice${futureDated === 1 ? " is" : "s are"} dated in the future (likely placeholders): $${money(futureAmount).toFixed(2)} counted as current and included in the totals.`,
    );
  }
  const scope = input.books.length === 2 ? "both books" : BOOK_LABEL[input.books[0]!];
  return {
    title: `Aged debtors (${scope}) — ${today}`,
    asOf: input.now.toISOString(),
    columns: AGED_DEBTOR_COLUMNS,
    rows,
    totals: sumKeys(rows, [...MONEY_KEYS, "invoices"]),
    warnings,
  };
}

export function booksFor(scope: BookScope): Book[] {
  return scope === "both" ? ["feldart", "tj"] : [scope];
}

export async function loadAgedDebtors(input: {
  book: BookScope;
  now: Date;
  customerUrl: (id: string) => string;
}): Promise<ReportTable> {
  const books = booksFor(input.book);
  const invRows = await db
    .select({
      customerId: invoices.customerId,
      origin: invoices.origin,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      balance: invoices.balance,
    })
    .from(invoices)
    .where(
      and(
        gt(invoices.balance, "0"),
        ne(invoices.status, "void"),
        inArray(invoices.origin, books),
      ),
    );
  const customerIds = [...new Set(invRows.map((r) => r.customerId))];
  if (customerIds.length === 0) {
    return buildAgedDebtors({
      invoices: [],
      credits: [],
      customers: [],
      books,
      now: input.now,
      customerUrl: input.customerUrl,
    });
  }

  const [custRows, creditRows] = await Promise.all([
    db
      .select({
        id: customers.id,
        name: customers.displayName,
        email: customers.primaryEmail,
        holdStatus: customers.holdStatus,
      })
      .from(customers)
      .where(inArray(customers.id, customerIds)),
    db
      .select({
        customerId: creditMemos.customerId,
        origin: creditMemos.origin,
        balance: creditMemos.balance,
      })
      .from(creditMemos)
      .where(
        and(
          gt(creditMemos.balance, "0"),
          inArray(creditMemos.customerId, customerIds),
          inArray(creditMemos.origin, books),
        ),
      ),
  ]);

  return buildAgedDebtors({
    invoices: invRows,
    credits: creditRows,
    customers: custRows,
    books,
    now: input.now,
    customerUrl: input.customerUrl,
  });
}
