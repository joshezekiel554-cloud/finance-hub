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
