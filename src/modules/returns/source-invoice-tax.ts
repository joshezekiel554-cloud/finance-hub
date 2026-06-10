// source-invoice-tax — looks up the original invoice(s) for an RMA's items
// in QBO to determine whether the source sale was taxed, what rate was used,
// and which tax code QBO recorded. Drives the "Sales tax" checkbox on the
// credit memo dialog: default it on when any source invoice had tax so the
// credit memo mirrors the sale, default off otherwise.
//
// An RMA can have items from multiple invoices. We aggregate:
//   - hadTax       = true if ANY source invoice has TotalTax > 0
//   - ratePercent  = subtotal-weighted tax rate across all invoices found
//   - taxCodeRef   = TxnTaxCodeRef from the first invoice with tax (mirroring
//                    a single code is the common case; mixed-rate RMAs are
//                    rare and the operator can adjust manually if needed)
//
// Errors looking up an individual invoice (deleted, never synced, QBO 404)
// are skipped so a single bad reference doesn't block the rest of the lookup —
// but lookup ERRORS (network/auth/5xx, as opposed to "not found") are reported
// via failedDocNumbers so callers can warn that the tax status may be
// incomplete instead of silently defaulting a taxed return to non-taxable.

import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { rmaItems } from "../../db/schema/returns.js";
import { QboClient } from "../../integrations/qb/client.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "returns.source-invoice-tax" });

export type SourceInvoiceTaxStatus = {
  hadTax: boolean;
  ratePercent: number;
  taxCodeRef: string | null;
  // Doc numbers whose QBO lookup errored (NOT "not found") — tax status may
  // be incomplete when non-empty.
  failedDocNumbers: string[];
};

export async function getSourceInvoiceTaxStatus(
  rmaId: string,
  qbo: QboClient = new QboClient(),
): Promise<SourceInvoiceTaxStatus> {
  const items = await db
    .select({ docNumber: rmaItems.originalInvoiceDocNumber })
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, rmaId));

  const docNumbers = Array.from(
    new Set(
      items
        .map((it) => it.docNumber)
        .filter((d): d is string => typeof d === "string" && d.length > 0),
    ),
  );

  if (docNumbers.length === 0) {
    return { hadTax: false, ratePercent: 0, taxCodeRef: null, failedDocNumbers: [] };
  }

  let totalTax = 0;
  let totalSubtotal = 0;
  let anyHadTax = false;
  let taxCodeRef: string | null = null;
  const failedDocNumbers: string[] = [];

  for (const docNum of docNumbers) {
    try {
      const inv = await qbo.getInvoiceByDocNumber(docNum);
      if (!inv) continue;
      const tax = inv.TxnTaxDetail?.TotalTax ?? 0;
      const total = inv.TotalAmt ?? 0;
      // QBO's default GlobalTaxCalculation is "TaxExcluded" — line amounts are
      // pre-tax so subtotal = TotalAmt - TotalTax. If a future tenant flips
      // to "TaxInclusive" the rate computed here will be slightly off but
      // hadTax + taxCodeRef remain correct, which is what drives behavior.
      const subtotal = total - tax;
      totalTax += tax;
      totalSubtotal += subtotal;
      if (tax > 0) {
        anyHadTax = true;
        if (!taxCodeRef && inv.TxnTaxDetail?.TxnTaxCodeRef?.value) {
          taxCodeRef = inv.TxnTaxDetail.TxnTaxCodeRef.value;
        }
      }
    } catch (err) {
      // Lookup failure for one invoice shouldn't block the others — but
      // record it so callers can surface that the result may be incomplete.
      failedDocNumbers.push(docNum);
      log.warn({ rmaId, docNumber: docNum, err }, "source-invoice tax lookup failed");
    }
  }

  const ratePercent =
    totalSubtotal > 0 ? (totalTax / totalSubtotal) * 100 : 0;

  return {
    hadTax: anyHadTax,
    ratePercent,
    taxCodeRef,
    failedDocNumbers,
  };
}
