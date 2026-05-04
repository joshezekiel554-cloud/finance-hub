import type { Rma, RmaItem } from "../../db/schema/returns.js";
import { QboClient } from "../../integrations/qb/client.js";

export type BuildAndPushInput = {
  rma: Rma;
  items: RmaItem[];
  shippingDeduction: string | null;
  restockingFee: string | null;
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

// Placeholder IDs for deduction service items. Replace with real QBO Item
// IDs once the operator creates these in QBO.
// TODO: configure shipping fee item id in settings
const SHIPPING_FEE_ITEM_ID = "1";
// TODO: configure restocking fee item id in settings
const RESTOCKING_FEE_ITEM_ID = "1";

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

  // One line per returned item
  for (const item of input.items) {
    const qty = parseFloat(item.receivedQuantity ?? item.quantity);
    const unitPrice = parseFloat(item.unitPrice);
    const amount = parseFloat(item.lineTotal);

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
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: -shippingAmt,
        Description: "Return shipping costs deducted",
        SalesItemLineDetail: {
          ItemRef: { value: SHIPPING_FEE_ITEM_ID },
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
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: -restockAmt,
        Description: "Restocking fee",
        SalesItemLineDetail: {
          ItemRef: { value: RESTOCKING_FEE_ITEM_ID },
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

  const response = await qbo.createCreditMemo(payload);

  return {
    qboCreditMemoId: response.Id,
    docNumber: response.DocNumber ?? "",
  };
}
