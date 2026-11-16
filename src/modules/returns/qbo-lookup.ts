import { QboClient } from "../../integrations/qb/client.js";
import type { QboInvoice, QboInvoiceLine } from "../../integrations/qb/types.js";

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------

export type LookupItemPriceInput = {
  qboCustomerId: string;
  qbItemId: string;
  /** The row's product code, if the caller knows it. Used only when no
   *  invoice billed `qbItemId` itself — see findMatchingInvoice. When omitted
   *  it is read from the QBO item. */
  sku?: string | null;
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
  /** The QBO item the matched invoice line actually billed. Differs from the
   *  requested qbItemId when QBO holds duplicate items sharing one SKU. */
  matchedQbItemId: string;
};

export type FindOriginalInvoiceInput = {
  qboCustomerId: string;
  qbItemId: string;
  sku?: string | null;
  qbo?: QboClient;
};

export type FindOriginalInvoiceResult = {
  qboInvoiceId: string;
  docNumber: string;
  txnDate: string;
  matchedQbItemId: string;
};

// ---------------------------------------------------------------------------
// Internal: find the most recent invoice that contains the given item
// ---------------------------------------------------------------------------

type InvoiceMatch = {
  invoice: QboInvoice;
  unitPrice: number;
  matchedQbItemId: string;
};

/**
 * Searches `invoices` (expected in DESC TxnDate order from the client) for the
 * first invoice with a SalesItemLineDetail line accepted by `accept`.
 */
function findMostRecentInvoice(
  invoices: QboInvoice[],
  accept: (line: QboInvoiceLine) => boolean,
): InvoiceMatch | null {
  for (const invoice of invoices) {
    const line = (invoice.Line ?? []).find(
      (l) => l.DetailType === "SalesItemLineDetail" && accept(l),
    );
    if (line) {
      return {
        invoice,
        unitPrice: line.SalesItemLineDetail?.UnitPrice ?? 0,
        matchedQbItemId: line.SalesItemLineDetail?.ItemRef?.value ?? "",
      };
    }
  }
  return null;
}

/**
 * Most recent invoice for this customer that billed the item.
 *
 * 1. Exact QBO item id — the common case, no extra QBO calls.
 * 2. Otherwise, by product code: QBO can hold several items with the same
 *    Sku (e.g. #1917 "Classic Round Pan Holder - Gold" and #1918 "... ( 1918 )",
 *    both PHCR01G). The picker resolves one of them, the invoice may have
 *    billed the other. Accept a line whose item shares the SKU, or whose
 *    Description is the SKU (Feldart invoices carry the code there).
 */
async function findMatchingInvoice(
  qbo: QboClient,
  invoices: QboInvoice[],
  qbItemId: string,
  skuHint: string | null | undefined,
): Promise<InvoiceMatch | null> {
  const exact = findMostRecentInvoice(
    invoices,
    (l) => l.SalesItemLineDetail?.ItemRef?.value === qbItemId,
  );
  if (exact || invoices.length === 0) return exact;

  // Best-effort: if either QBO call fails, keep the old "no match" answer
  // rather than turning a soft miss into a 500.
  let sku = "";
  const siblings = new Set<string>([qbItemId]);
  try {
    sku =
      skuHint?.trim() || (await qbo.getItemById(qbItemId))?.Sku?.trim() || "";
    if (!sku) return null;
    for (const item of await qbo.getItemsBySku(sku)) siblings.add(item.Id);
  } catch {
    if (!sku) return null;
  }
  const skuUpper = sku.toUpperCase();

  return findMostRecentInvoice(invoices, (l) => {
    const ref = l.SalesItemLineDetail?.ItemRef?.value;
    if (ref && siblings.has(ref)) return true;
    return (l.Description ?? "").trim().toUpperCase() === skuUpper;
  });
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
  const match = await findMatchingInvoice(qbo, invoices, input.qbItemId, input.sku);
  if (!match) return null;

  const { invoice, unitPrice: listUnitPrice, matchedQbItemId } = match;

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
    matchedQbItemId,
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
  const match = await findMatchingInvoice(qbo, invoices, input.qbItemId, input.sku);
  if (!match) return null;

  const { invoice, matchedQbItemId } = match;
  return {
    qboInvoiceId: invoice.Id,
    docNumber: invoice.DocNumber ?? "",
    txnDate: invoice.TxnDate ?? "",
    matchedQbItemId,
  };
}
