import type { Rma, RmaItem } from "../../db/schema/returns.js";
import { QboClient } from "../../integrations/qb/client.js";
import { loadAppSettings } from "../statements/settings.js";

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
//   - damage RMA:        use rmaNumber as-is (DC##### sequential, e.g. DC38771)
//   - seasonal RMA:      `${rmaNumber}CR` (e.g. 18743CR — Extensiv tx + "CR")
//   - non_seasonal RMA:  same `${rmaNumber}CR` shape
//   QBO "Custom transaction numbers" must be ON; otherwise DocNumber is
//   ignored and QBO autogenerates.
//
// CustomerMemo:
//   - damage:        "damaged items"
//   - seasonal:      "seasonal returns"
//   - non_seasonal:  "returns"
//   Plain-English summary the customer sees on the CM PDF — no internal
//   identifiers. Operators search QBO by DocNumber if they need to find
//   a specific CM later.
// ---------------------------------------------------------------------------

// QBO Item ids used as line refs for the shipping + restocking fee
// deductions. Loaded from app_settings (rma_shipping_fee_item_id,
// rma_restocking_fee_item_id), set via the /settings UI under the
// Returns section. When unset the deduction path throws — see
// assertFeeItemConfigured — rather than silently posting a CM against
// the wrong QBO item.
export function assertFeeItemConfigured(
  kind: "shipping" | "restocking",
  itemId: string,
): asserts itemId is string {
  if (!itemId.trim()) {
    throw new Error(
      `RMA ${kind}-fee deduction requested but rma_${kind}_fee_item_id is not configured. ` +
        `Create the service item in QBO and set the id in /settings → Returns before issuing CMs with ${kind} fees.`,
    );
  }
}

// ---------------------------------------------------------------------------
// classifyOperatorFeeLine — fee-line parity for the /process-return path.
//
// The redesigned CM create page lets the operator post free-form lines, so
// shipping/restocking deductions arrive as negative lines referencing the
// configured fee items rather than through the shippingDeduction /
// restockingFee inputs above. Classify such a line by matching its item id
// against the configured fee item ids; when it matches, run the same
// assertFeeItemConfigured guard the builder path uses so both paths reject
// fee lines against a missing/blank configuration. Returns null for ordinary
// (non-fee) lines, including negative adjustments on unrelated items.
//
// quantity/unitPrice/description are the route's string-typed body fields
// (mirrors the processReturnBodySchema line shape).
// ---------------------------------------------------------------------------
export function classifyOperatorFeeLine(
  line: {
    qbItemId: string;
    quantity: string;
    unitPrice: string;
    description: string;
  },
  settings: {
    rma_shipping_fee_item_id: string;
    rma_restocking_fee_item_id: string;
  },
): "shipping" | "restocking" | null {
  const unitPrice = parseFloat(line.unitPrice);
  const amount = parseFloat(line.quantity) * unitPrice;
  const isNegative = unitPrice < 0 || amount < 0;
  if (!isNegative) return null;

  if (line.qbItemId === settings.rma_shipping_fee_item_id) {
    assertFeeItemConfigured("shipping", settings.rma_shipping_fee_item_id);
    return "shipping";
  }
  if (line.qbItemId === settings.rma_restocking_fee_item_id) {
    assertFeeItemConfigured("restocking", settings.rma_restocking_fee_item_id);
    return "restocking";
  }

  // The matched-id paths above only fire when the setting is non-blank
  // (qbItemId is schema-guaranteed non-empty), so they can't catch the real
  // misconfiguration hazard: a negative line that LOOKS like a fee — its
  // description mentions shipping/restocking/fee — posted while the fee
  // items are unconfigured. Without this it would silently land in QBO as a
  // goods line against whatever item the operator picked. Route the
  // blank-config case through the same guard the builder uses (each branch
  // only runs when the setting is blank, so the assert always throws).
  const desc = line.description;
  if (/restock/i.test(desc) && !settings.rma_restocking_fee_item_id.trim()) {
    assertFeeItemConfigured("restocking", settings.rma_restocking_fee_item_id);
  }
  if (/shipping/i.test(desc) && !settings.rma_shipping_fee_item_id.trim()) {
    assertFeeItemConfigured("shipping", settings.rma_shipping_fee_item_id);
  }
  if (
    /fee/i.test(desc) &&
    !settings.rma_shipping_fee_item_id.trim() &&
    !settings.rma_restocking_fee_item_id.trim()
  ) {
    assertFeeItemConfigured("shipping", settings.rma_shipping_fee_item_id);
  }

  return null;
}

export async function buildAndPushCreditMemo(
  input: BuildAndPushInput,
  qbo: QboClient = new QboClient(),
): Promise<BuildAndPushResult> {
  // Loaded once per CM build; only the deduction branches read it.
  // Cheap (single SELECT) — and saves needing to thread settings
  // through every caller.
  const settings = await loadAppSettings();

  const lines: Array<{
    DetailType: "SalesItemLineDetail";
    Amount: number;
    Description: string;
    SalesItemLineDetail: {
      ItemRef: { value: string };
      Qty: number;
      UnitPrice: number;
      TaxCodeRef: { value: string };
    };
  }> = [];

  // Per-line taxability. In Feldart's QBO realm (US Automated Sales Tax) a
  // line with NO explicit TaxCodeRef defaults to taxable — omitting the
  // txn-level TxnTaxDetail block is NOT enough to make the CM non-taxable.
  // So we stamp every line "TAX"/"NON" explicitly, mirroring the /process-
  // return path (returns.ts) and the b2b sender. When applyTax is off all
  // lines are NON → QBO computes zero tax regardless of customer/item
  // defaults. When on, all lines are TAX so the taxable subtotal matches
  // the dialog preview (goods − shipping − restocking).
  const lineTaxCode = input.applyTax ? "TAX" : "NON";

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
        TaxCodeRef: { value: lineTaxCode },
      },
    });
  }

  // Shipping deduction negative line
  if (input.shippingDeduction != null) {
    const shippingAmt = parseFloat(input.shippingDeduction);
    if (shippingAmt > 0) {
      const shippingItemId = settings.rma_shipping_fee_item_id;
      assertFeeItemConfigured("shipping", shippingItemId);
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: -shippingAmt,
        Description: "Return shipping costs deducted",
        SalesItemLineDetail: {
          ItemRef: { value: shippingItemId },
          Qty: 1,
          UnitPrice: -shippingAmt,
          TaxCodeRef: { value: lineTaxCode },
        },
      });
    }
  }

  // Restocking fee negative line
  if (input.restockingFee != null) {
    const restockAmt = parseFloat(input.restockingFee);
    if (restockAmt > 0) {
      const restockItemId = settings.rma_restocking_fee_item_id;
      assertFeeItemConfigured("restocking", restockItemId);
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: -restockAmt,
        Description: "Restocking fee",
        SalesItemLineDetail: {
          ItemRef: { value: restockItemId },
          Qty: 1,
          UnitPrice: -restockAmt,
          TaxCodeRef: { value: lineTaxCode },
        },
      });
    }
  }

  // DocNumber strategy by return type:
  //   - damage:        rmaNumber as-is (DC##### sequential, allocated at
  //                    approve time via the app_settings counter)
  //   - seasonal:      `${rmaNumber}CR` where rmaNumber is the operator-
  //                    entered Extensiv warehouse tx number (e.g. 18743CR)
  //   - non_seasonal:  same `${rmaNumber}CR` shape
  //
  // QBO's "Custom transaction numbers" setting must be ON for these to
  // stick — otherwise QBO ignores DocNumber on the payload and auto-
  // generates its own. The damage path requires this, so the QBO setting
  // is assumed enabled. rmaNumber is guaranteed non-null at this point
  // because the state machine forces approve (damage) or
  // setWarehouseNumber (seasonal/non_seasonal) before reaching `received`.
  const rmaNumber = input.rma.rmaNumber;
  const docNumber =
    input.rma.returnType === "damage"
      ? (rmaNumber ?? undefined)
      : rmaNumber
        ? `${rmaNumber}CR`
        : undefined;

  // CustomerMemo prints on the QBO CM PDF the customer receives. Plain-
  // English summary by return type — no rmaNumber so the customer sees
  // a readable phrase, not an internal id. Operators can grep QBO by
  // DocNumber if they need to find a specific CM.
  const customerMemo =
    input.rma.returnType === "damage"
      ? "damaged items"
      : input.rma.returnType === "seasonal"
        ? "seasonal returns"
        : "returns";

  const payload: Record<string, unknown> = {
    CustomerRef: { value: input.rma.qbCustomerId },
    CustomerMemo: { value: customerMemo },
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
