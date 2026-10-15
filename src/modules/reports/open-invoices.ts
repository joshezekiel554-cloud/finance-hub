// Customer open-invoices sheet (Feldart AI task O): the sheet twin of the
// Statement PDF. Invoices come from the statement's own loader so both
// always list the same documents; unapplied credits come from the synced
// credit_memos mirror (the PDF asks QBO live — the mirror is at most one
// sync behind).

import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { loadOpenInvoicesByBook } from "../statements/send.js";
import { booksFor, type Book, type BookScope } from "./aged-debtors.js";
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

export type OpenInvoiceInput = {
  origin: Book;
  docNumber: string | null;
  issueDate: DateLike;
  dueDate: DateLike;
  total: string | number;
  balance: string | number;
  disputeState: string | null;
};

export type OpenCreditInput = {
  origin: Book;
  docNumber: string | null;
  txnDate: DateLike;
  total: string | number;
  balance: string | number;
};

export const OPEN_INVOICE_COLUMNS: ReportColumn[] = [
  { key: "book", label: "Book", type: "text" },
  { key: "type", label: "Type", type: "text" },
  { key: "docNumber", label: "Number", type: "text" },
  { key: "date", label: "Date", type: "date" },
  { key: "dueDate", label: "Due date", type: "date" },
  { key: "daysOverdue", label: "Days overdue", type: "number" },
  usd("total", "Original amount"),
  usd("balance", "Balance"),
  { key: "status", label: "Status", type: "text" },
];

const BOOK_LABEL: Record<Book, string> = { feldart: "Feldart", tj: "Torah Judaica" };

export function buildOpenInvoices(input: {
  customerName: string;
  invoices: OpenInvoiceInput[];
  credits: OpenCreditInput[];
  books: Book[];
  now: Date;
}): ReportTable {
  const today = isoDay(input.now);
  const records: ReportRow[] = [];
  for (const book of input.books) {
    const invs = input.invoices
      .filter((i) => i.origin === book && num(i.balance) > 0)
      .sort((a, b) => (dayOf(a.issueDate) ?? "").localeCompare(dayOf(b.issueDate) ?? ""));
    for (const inv of invs) {
      const days = daysPastDue(inv.dueDate, today);
      records.push({
        book: BOOK_LABEL[book],
        type: "Invoice",
        docNumber: inv.docNumber,
        date: dayOf(inv.issueDate),
        dueDate: dayOf(inv.dueDate),
        daysOverdue: days !== null && days > 0 ? days : 0,
        total: money(num(inv.total)),
        balance: money(num(inv.balance)),
        status:
          inv.disputeState === "verifying"
            ? "Verifying payment"
            : days !== null && days > 0
              ? "Overdue"
              : "Not yet due",
      });
    }
    for (const cr of input.credits.filter((c) => c.origin === book && num(c.balance) > 0)) {
      records.push({
        book: BOOK_LABEL[book],
        type: "Credit",
        docNumber: cr.docNumber,
        date: dayOf(cr.txnDate),
        dueDate: null,
        daysOverdue: null,
        total: money(-num(cr.total)),
        balance: money(-num(cr.balance)),
        status: "Unapplied credit",
      });
    }
  }
  const rows = shapeRows(OPEN_INVOICE_COLUMNS, records);
  const warnings: string[] = [];
  if (rows.length === 0) warnings.push("No open invoices or unapplied credits.");
  return {
    title: `${input.customerName} — open invoices — ${today}`,
    asOf: input.now.toISOString(),
    columns: OPEN_INVOICE_COLUMNS,
    rows,
    totals: sumKeys(rows, ["balance"]),
    warnings,
  };
}

export class ReportNotFoundError extends Error {}

export async function loadOpenInvoices(input: {
  customerId: string;
  book: BookScope;
  now: Date;
}): Promise<ReportTable> {
  const [customer] = await db
    .select({ name: customers.displayName })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  if (!customer) throw new ReportNotFoundError("customer not found");

  const books = booksFor(input.book);
  const [byBook, creditRows] = await Promise.all([
    loadOpenInvoicesByBook(input.customerId, input.book),
    db
      .select({
        origin: creditMemos.origin,
        docNumber: creditMemos.docNumber,
        txnDate: creditMemos.txnDate,
        total: creditMemos.total,
        balance: creditMemos.balance,
      })
      .from(creditMemos)
      .where(
        and(
          eq(creditMemos.customerId, input.customerId),
          gt(creditMemos.balance, "0"),
          inArray(creditMemos.origin, books),
        ),
      ),
  ]);

  return buildOpenInvoices({
    customerName: customer.name,
    invoices: [...byBook.values()].flat(),
    credits: creditRows,
    books,
    now: input.now,
  });
}
