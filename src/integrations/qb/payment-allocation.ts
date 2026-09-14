// Attribute a QBO Payment to the Feldart / TJ books.
//
// A Payment's Line[] entries each link to the transaction they pay down.
// Lines linked to a known Invoice take that invoice's book; everything else
// (unapplied amount sitting as credit, lines linked to credit memos or to
// invoices we haven't synced) is "unallocated". Pure — the sync feeds it
// the invoice → origin map.

import type { QboPayment } from "./types.js";

export type Book = "feldart" | "tj";

export type PaymentAllocation = {
  feldart: number;
  tj: number;
  unallocated: number;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function allocatePaymentByBook(
  payment: QboPayment,
  originByQbInvoiceId: ReadonlyMap<string, Book>,
): PaymentAllocation {
  const total = round2(payment.TotalAmt ?? 0);
  let feldart = 0;
  let tj = 0;

  for (const line of payment.Line ?? []) {
    const amount = line.Amount ?? 0;
    if (!amount) continue;
    const invoiceLink = (line.LinkedTxn ?? []).find((l) => l.TxnType === "Invoice");
    const book = invoiceLink ? originByQbInvoiceId.get(invoiceLink.TxnId) : undefined;
    if (book === "feldart") feldart += amount;
    else if (book === "tj") tj += amount;
    // else: unknown / non-invoice → falls into unallocated below
  }

  // When a credit memo is applied alongside a payment, QBO's line Amount
  // includes the memo's portion, so lines can sum above the cash total.
  // Only cash counts as "received": scale the book shares down to the total.
  const linked = feldart + tj;
  if (linked > total && linked > 0) {
    const k = total / linked;
    feldart *= k;
    tj *= k;
  }
  feldart = round2(feldart);
  tj = round2(tj);
  // Whatever the books don't account for (unapplied credit, unknown links,
  // rounding) is the remainder — never negative, so parts never exceed total.
  const unallocated = round2(Math.max(0, total - feldart - tj));
  return { feldart, tj, unallocated };
}
