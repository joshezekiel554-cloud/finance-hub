import { QboClient } from "../../integrations/qb/client.js";
import type { QboInvoice } from "../../integrations/qb/types.js";

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------

export type LookupItemPriceInput = {
  qboCustomerId: string;
  qbItemId: string;
  /** Pass an already-constructed QboClient to avoid constructing one from env
   *  (useful for DI in tests via the optional second argument). */
  qbo?: QboClient;
};

export type LookupItemPriceResult = {
  /** Pre-discount unit price as 4-decimal string, e.g. "25.0000" */
  listUnitPrice: string;
  /** Effective post-discount unit price as 4-decimal string */
  unitPrice: string;
  /** Effective discount percentage as 4-decimal string, e.g. "5.0000"; null if none */
  invoiceDiscountPct: string | null;
  /** QBO Invoice DocNumber of the matched invoice */
  originalInvoiceDocNumber: string;
  /** TxnDate of the matched invoice, YYYY-MM-DD */
  originalInvoiceDate: string;
};

export type FindOriginalInvoiceInput = {
  qboCustomerId: string;
  qbItemId: string;
  qbo?: QboClient;
};

export type FindOriginalInvoiceResult = {
  qboInvoiceId: string;
  docNumber: string;
  txnDate: string;
};

// ---------------------------------------------------------------------------
// Internal: find the most recent invoice that contains the given item
// ---------------------------------------------------------------------------

/**
 * Searches `invoices` (expected in DESC TxnDate order from the client) for the
 * first invoice that has a SalesItemLineDetail line where ItemRef.value matches
 * `qbItemId`. Returns the invoice and matching line, or null.
 */
function findMostRecentInvoiceWithItem(
  invoices: QboInvoice[],
  qbItemId: string,
): { invoice: QboInvoice; unitPrice: number } | null {
  for (const invoice of invoices) {
    const lines = invoice.Line ?? [];
    const matchingLine = lines.find(
      (l) =>
        l.DetailType === "SalesItemLineDetail" &&
        l.SalesItemLineDetail?.ItemRef?.value === qbItemId,
    );
    if (matchingLine) {
      const unitPrice = matchingLine.SalesItemLineDetail?.UnitPrice ?? 0;
      return { invoice, unitPrice };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: compute effective discount percentage from an invoice
// ---------------------------------------------------------------------------

/**
 * Computes the effective invoice-level discount percentage.
 *
 * - If a DiscountLineDetail line exists with PercentBased=true:
 *   uses DiscountPercent directly.
 * - If a DiscountLineDetail line exists with PercentBased=false (flat $):
 *   derives the percentage as Math.abs(line.Amount) / subtotal × 100.
 *   If subtotal is zero, returns null (can't compute a meaningful percentage).
 * - If no DiscountLineDetail line: returns null.
 */
function computeDiscountPct(invoice: QboInvoice): number | null {
  const lines = invoice.Line ?? [];

  // Sum of all SalesItemLineDetail amounts = subtotal (excludes discount line)
  const subtotal = lines
    .filter((l) => l.DetailType === "SalesItemLineDetail")
    .reduce((sum, l) => sum + (l.Amount ?? 0), 0);

  const discountLine = lines.find((l) => l.DetailType === "DiscountLineDetail");
  if (!discountLine) return null;

  const detail = discountLine.DiscountLineDetail;
  if (!detail) return null;

  if (detail.PercentBased === true) {
    // QBO gives us the percentage directly
    return detail.DiscountPercent ?? null;
  } else {
    // Flat dollar discount: derive percentage from subtotal
    if (subtotal === 0) return null;
    const discountDollar = Math.abs(discountLine.Amount ?? 0);
    return (discountDollar / subtotal) * 100;
  }
}

// ---------------------------------------------------------------------------
// lookupItemPriceForCustomer
// ---------------------------------------------------------------------------

/**
 * Finds the most recent invoice for (customer, item) and computes the
 * effective per-unit price after any invoice-level discount.
 *
 * Returns null if no matching invoice is found.
 */
export async function lookupItemPriceForCustomer(
  input: LookupItemPriceInput,
  qboOverride?: QboClient,
): Promise<LookupItemPriceResult | null> {
  const qbo = input.qbo ?? qboOverride ?? new QboClient();

  const invoices = await qbo.findInvoicesForCustomer(input.qboCustomerId);
  const match = findMostRecentInvoiceWithItem(invoices, input.qbItemId);
  if (!match) return null;

  const { invoice, unitPrice: listUnitPrice } = match;

  const discountPct = computeDiscountPct(invoice);

  // Compute effective unit price after discount
  let effectiveUnitPrice: number;
  if (discountPct === null) {
    effectiveUnitPrice = listUnitPrice;
  } else {
    effectiveUnitPrice = listUnitPrice * (1 - discountPct / 100);
  }

  return {
    listUnitPrice: listUnitPrice.toFixed(4),
    unitPrice: effectiveUnitPrice.toFixed(4),
    invoiceDiscountPct: discountPct !== null ? discountPct.toFixed(4) : null,
    originalInvoiceDocNumber: invoice.DocNumber ?? "",
    originalInvoiceDate: invoice.TxnDate ?? "",
  };
}

// ---------------------------------------------------------------------------
// findOriginalInvoiceForItem
// ---------------------------------------------------------------------------

/**
 * Lightweight lookup — returns only the identifying fields of the most recent
 * invoice containing (customer, item). No price math performed.
 *
 * Returns null if no matching invoice is found.
 */
export async function findOriginalInvoiceForItem(
  input: FindOriginalInvoiceInput,
  qboOverride?: QboClient,
): Promise<FindOriginalInvoiceResult | null> {
  const qbo = input.qbo ?? qboOverride ?? new QboClient();

  const invoices = await qbo.findInvoicesForCustomer(input.qboCustomerId);
  const match = findMostRecentInvoiceWithItem(invoices, input.qbItemId);
  if (!match) return null;

  const { invoice } = match;
  return {
    qboInvoiceId: invoice.Id,
    docNumber: invoice.DocNumber ?? "",
    txnDate: invoice.TxnDate ?? "",
  };
}
