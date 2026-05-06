import type { Rma, RmaItem } from "../../db/schema/returns.js";
import { QboClient } from "../../integrations/qb/client.js";
import { env } from "../../lib/env.js";

export type BuildAndPushInput = {
  rma: Rma;
  items: RmaItem[];
  shippingDeduction: string | null;
  restockingFee: string | null;
  // Sales tax. When applyTax is true we set TxnTaxCodeRef on the QBO payload
  // so the credit memo mirrors the source invoice's tax treatment. taxCodeRef
  // is the QBO id of the tax code (from the original invoice's TxnTaxDetail);
  // QBO recomputes the actual tax amount from that code's current rate.
  applyTax?: boolean;
  taxCodeRef?: string | null;
};

export type BuildAndPushResult = {
  qboCreditMemoId: string;
  docNumber: string;
};

// ---------------------------------------------------------------------------
// Pure helper — formats the per-line description for a credit memo line.
//
// Format:
//   {sku} — {name}
//   {sku} — {name} (orig. inv. {docNumber})
//   {sku} — {name} (orig. inv. {docNumber}, {date})
//   {sku} — {name} (orig. inv. {docNumber}, {date}; X% inv discount applied)
//
// invoiceDiscountPct is a Drizzle decimal column stored as a string (e.g.
// "5.0000"). Zero ("0.0000") is treated as no discount — no note appended.
// originalInvoiceDate is a Drizzle date column; drivers may return a Date
// object or a "yyyy-MM-dd" string. We normalise both to "yyyy-MM-dd".
// ---------------------------------------------------------------------------
export function buildCreditMemoLineDescription(item: RmaItem): string {
  const head = `${item.sku} — ${item.name}`;

  if (!item.originalInvoiceDocNumber) {
    return head;
  }

  // Build the parenthetical suffix
  const parts: string[] = [];

  let invRef = `orig. inv. ${item.originalInvoiceDocNumber}`;
  if (item.originalInvoiceDate != null) {
    invRef += `, ${formatInvoiceDate(item.originalInvoiceDate)}`;
  }
  parts.push(invRef);

  if (item.invoiceDiscountPct != null) {
    const pct = parseFloat(item.invoiceDiscountPct);
    if (pct > 0) {
      // Format as integer when whole-number (e.g. 5 not 5.0000)
      const pctStr = Number.isInteger(pct) ? String(pct) : String(pct);
      parts.push(`${pctStr}% inv discount applied`);
    }
  }

  return `${head} (${parts.join("; ")})`;
}

// Drizzle date() in MySQL infers as Date. In tests and edge cases the driver
// may return a Date object or an already-formatted "yyyy-MM-dd" string.
// Normalise both to "yyyy-MM-dd" so we never expose a Date.toISOString()
// timestamp (which includes time + timezone) in the line description.
function formatInvoiceDate(date: Date | string): string {
  if (date instanceof Date) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  // Already a "yyyy-MM-dd" string (legacy / alternative driver path)
  return date;
}

// ---------------------------------------------------------------------------
// buildAndPushCreditMemo — builds a QBO CreditMemo payload and creates it
// via the QboClient.
//
// Line shape per item:
//   - DetailType: "SalesItemLineDetail"
//   - Amount: lineTotal (from RMA item — already post-discount total)
//   - Description: buildCreditMemoLineDescription(item)
//   - SalesItemLineDetail: { ItemRef, Qty (receivedQuantity ?? quantity), UnitPrice }
//
// If shippingDeduction > 0: adds a negative SalesItemLineDetail line.
// If restockingFee > 0: adds a negative SalesItemLineDetail line.
//
// Shipping / restocking negative lines reference placeholder item IDs.
// TODO: configure shipping fee item id in settings — operator should create
// a "Shipping Fee" and "Restocking Fee" service item in QBO and store the
// resulting Item Ids in app settings before going live.
//
// DocNumber:
//   - damage RMA: use rmaNumber (the DC-... string)
//   - non-damage: omit (QBO autogenerates, e.g. "42CR")
// ---------------------------------------------------------------------------

// QBO Item ids used as line refs for the shipping + restocking fee
// deductions. Configured via RMA_SHIPPING_FEE_QBO_ITEM_ID and
// RMA_RESTOCKING_FEE_QBO_ITEM_ID env vars. When unset the deduction
// path throws (see assertFeeItemConfigured below) rather than silently
// posting a CM against the wrong QBO item — which would either fail
// noisily ("Item id 1 doesn't exist") or, worse, succeed against an
// unrelated item if id 1 happens to be populated.
function assertFeeItemConfigured(
  kind: "shipping" | "restocking",
  itemId: string,
): asserts itemId is string {
  if (!itemId.trim()) {
    throw new Error(
      `RMA ${kind}-fee deduction requested but RMA_${kind.toUpperCase()}_FEE_QBO_ITEM_ID is not set. ` +
        `Create the service item in QBO and set the env var before issuing CMs with ${kind} fees.`,
    );
  }
}

export async function buildAndPushCreditMemo(
  input: BuildAndPushInput,
  qbo: QboClient = new QboClient(),
): Promise<BuildAndPushResult> {
  const lines: Array<{
    DetailType: "SalesItemLineDetail";
    Amount: number;
    Description: string;
    SalesItemLineDetail: {
      ItemRef: { value: string };
      Qty: number;
      UnitPrice: number;
    };
  }> = [];

  // One line per returned item.
  //
  // IMPORTANT: when receivedQuantity differs from quantity (warehouse received
  // a partial), Amount must equal Qty * UnitPrice — otherwise QBO rejects the
  // line or silently recomputes it server-side, producing a credit memo whose
  // total disagrees with what the operator sees in the UI. We always derive
  // Amount from qty * unitPrice (rounded to 2dp) rather than trusting the
  // stored item.lineTotal, which was computed against the original quantity.
  for (const item of input.items) {
    const qty = parseFloat(item.receivedQuantity ?? item.quantity);
    const unitPrice = parseFloat(item.unitPrice);
    const amount = Math.round(qty * unitPrice * 100) / 100;

    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: amount,
      Description: buildCreditMemoLineDescription(item),
      SalesItemLineDetail: {
        ItemRef: { value: item.qbItemId },
        Qty: qty,
        UnitPrice: unitPrice,
      },
    });
  }

  // Shipping deduction negative line
  if (input.shippingDeduction != null) {
    const shippingAmt = parseFloat(input.shippingDeduction);
    if (shippingAmt > 0) {
      const shippingItemId = env.RMA_SHIPPING_FEE_QBO_ITEM_ID;
      assertFeeItemConfigured("shipping", shippingItemId);
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: -shippingAmt,
        Description: "Return shipping costs deducted",
        SalesItemLineDetail: {
          ItemRef: { value: shippingItemId },
          Qty: 1,
          UnitPrice: -shippingAmt,
        },
      });
    }
  }

  // Restocking fee negative line
  if (input.restockingFee != null) {
    const restockAmt = parseFloat(input.restockingFee);
    if (restockAmt > 0) {
      const restockItemId = env.RMA_RESTOCKING_FEE_QBO_ITEM_ID;
      assertFeeItemConfigured("restocking", restockItemId);
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: -restockAmt,
        Description: "Restocking fee",
        SalesItemLineDetail: {
          ItemRef: { value: restockItemId },
          Qty: 1,
          UnitPrice: -restockAmt,
        },
      });
    }
  }

  // DocNumber: only set for damage RMAs (DC-... format). For seasonal/non-seasonal,
  // omit and let QBO autogenerate (e.g. "42CR").
  const docNumber =
    input.rma.returnType === "damage" ? (input.rma.rmaNumber ?? undefined) : undefined;

  const payload: Record<string, unknown> = {
    CustomerRef: { value: input.rma.qbCustomerId },
    CustomerMemo: { value: `RMA ${input.rma.rmaNumber}` },
    Line: lines,
  };

  if (docNumber !== undefined) {
    payload.DocNumber = docNumber;
  }

  // Mirror the source invoice's tax treatment when requested. Setting
  // TxnTaxDetail.TxnTaxCodeRef is enough — QBO recomputes TotalTax server-side
  // from the code's current rate and the line subtotal. When applyTax is off
  // we omit the block entirely; QBO will treat the CM as non-taxable.
  if (input.applyTax && input.taxCodeRef) {
    payload.TxnTaxDetail = {
      TxnTaxCodeRef: { value: input.taxCodeRef },
    };
  }

  const response = await qbo.createCreditMemo(payload);

  return {
    qboCreditMemoId: response.Id,
    docNumber: response.DocNumber ?? "",
  };
}
