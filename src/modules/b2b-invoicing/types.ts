// Types for the Feldart shipment email parser.
//
// Source emails come from notifications@secure-wms.com (the WMS that the
// Feldart fulfillment center uses), are delivered via Amazon SES, and follow a
// templated HTML format. See tests/fixtures/feldart-shipments/README.md for a
// breakdown of the extractable fields.

export type ParsedLineItem = {
  sku: string;
  // Decimal qty as a string to preserve precision (e.g. "23.00"). Numeric
  // coercion happens at the reconciler boundary alongside QBO line totals.
  quantity: string;
};

export type ParsedShipment = {
  // PO number from the email (e.g. "SHOP18301"). Includes the "SHOP" prefix.
  poNumber: string | null;
  // Shopify order number derived from PO (PO with "SHOP" prefix stripped, e.g. "18301").
  // null if PO doesn't start with "SHOP" or is missing.
  shopifyOrderNumber: string | null;
  // Internal Feldart transaction id (e.g. "99863"). Useful for de-duping if
  // the same shipment notification is delivered twice.
  transactionNumber: string | null;
  // End-customer name extracted from "to your customer X via {Carrier}".
  endCustomerName: string | null;
  // Long carrier description from the body sentence (e.g. "United Parcel Service").
  carrierLong: string | null;
  // Short carrier code from the "Carrier:" label (e.g. "UPS").
  carrierShort: string | null;
  trackingNumber: string | null;
  // Ship date as ISO date string (YYYY-MM-DD), parsed from US M/D/YYYY format.
  shipDate: string | null;
  // Shipping cost as a string ("0.00" if blank in source). Some emails leave it empty.
  shippingCost: string | null;
  lineItems: ParsedLineItem[];
};

// Wrapper around ParsedShipment that captures parse health. confidence is a
// rough 0..1 signal — number of required fields present / total. Used by the
// reconciler to decide whether to fall back to Claude tool-use for re-parse.
export type ParseResult = {
  shipment: ParsedShipment;
  confidence: number;
  // Field names that the regex parser failed to extract. Empty array on a
  // perfect parse.
  missingFields: string[];
  // Decoded HTML body, retained for re-parsing/debugging. Not persisted.
  decodedHtml: string;
};

// ---------- reconciler ----------
//
// The reconciler aligns a QB invoice's lines to what Feldart actually shipped.
// The Feldart Transaction Report is treated as the source of truth: anything
// on the invoice but missing from the shipment gets qty_change'd to 0 (line
// stays on the invoice for audit visibility, just zeroed out). Anything on
// the shipment but missing from the invoice triggers an add (rare; flagged
// for human review since price provenance is uncertain).
//
// The reconciler is pure: caller pre-decorates the QB invoice lines with
// resolved SKUs (QBO lines reference Items by ID, not SKU directly), and
// optionally provides Shopify order line prices for the add-fallback.

// Narrow input shape — caller resolves QBO ItemRef.value -> SKU before calling.
// We accept SKU directly (rather than the raw QboInvoiceLine) so the
// reconciler doesn't need to depend on QBO types or Item lookup logic.
export type InvoiceLineForReconcile = {
  // QBO Line.Id — needed to address the line on update later.
  lineId: string;
  // Resolved SKU. May be null if the QBO line has no Item or the item has no
  // SKU — those lines are passed through as keeps (we don't touch them).
  sku: string | null;
  qty: number;
  unitPrice: number;
  description?: string | null;
};

export type ShopifyOrderLineForReconcile = {
  sku: string;
  // Shopify storefront retail price as a number. The reconciler halves it for
  // the add-row B2B price; the caller is responsible for currency conversion
  // if applicable (US-only at launch, so this is USD throughout).
  retailPrice: number;
};

export type ShipmentForReconcile = {
  trackingNumber: string;
  shipVia: string;
  shipDate: string; // ISO YYYY-MM-DD
  lineItems: Array<{ sku: string; qty: number }>;
};

export type ReconcileInput = {
  shipment: ShipmentForReconcile;
  invoiceLines: InvoiceLineForReconcile[];
  shopifyOrderLines?: ShopifyOrderLineForReconcile[];
};

export type ReconcileAction =
  | {
      type: "keep";
      lineId: string;
      sku: string;
      qty: number;
    }
  | {
      type: "qty_change";
      lineId: string;
      sku: string;
      fromQty: number;
      toQty: number;
      // Optional unit-price override. When set, the sender writes this onto
      // the QBO line; when undefined, the original line's UnitPrice stays.
      // Set client-side when the user edits the QB price cell on any row.
      unitPriceOverride?: number;
      // "shipped_less" / "shipped_more" / "not_shipped" / "split_zero" — UI
      // can render these distinctly (e.g. red for not_shipped, yellow for
      // split_zero). "user_override" is only emitted client-side when a
      // human edits a Final qty cell that the reconciler had set as `keep`.
      // "price_change" is emitted when only the unit price was edited (qty
      // unchanged). Pure metadata; doesn't affect the QBO write.
      reason:
        | "shipped_less"
        | "shipped_more"
        | "not_shipped"
        | "split_zero"
        | "user_override"
        | "price_change";
    }
  | {
      type: "add";
      sku: string;
      qty: number;
      unitPrice: number | null;
      // shopify_b2b: 50% of Shopify retail (price source confident)
      // fallback:    no Shopify match — UI prompts user to set the price
      priceSource: "shopify_b2b" | "fallback";
    }
  | {
      type: "set_metadata";
      trackingNumber: string;
      shipVia: string;
      shipDate: string;
    };

export type ReconcileResult = {
  actions: ReconcileAction[];
  // Convenience counts for UI summaries / logs. Always derivable from actions.
  summary: {
    keep: number;
    qty_change: number;
    add: number;
    // SKUs the reconciler couldn't price (priceSource=fallback). Surface in
    // UI as "needs price" warnings.
    addsNeedingPrice: string[];
  };
};
