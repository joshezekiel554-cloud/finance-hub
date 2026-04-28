// Feldart shipment email parser.
//
// Parses outbound shipment notifications from the Feldart fulfillment center
// (sender notifications@secure-wms.com, delivered via Amazon SES, subject
// "requested transaction notification"). The body is a templated HTML
// payload, base64-encoded by SES. The format is stable enough that a regex
// parser is sufficient; Claude tool-use fallback handles the long tail when a
// required field is missing.
//
// Entry points:
//   parseShipmentEml(raw)   - parses a raw .eml string (full RFC 822 message)
//   parseShipmentHtml(html) - parses an already-decoded HTML body
//
// See tests/fixtures/feldart-shipments/README.md for the field reference.

import type { ParsedLineItem, ParsedShipment, ParseResult } from "./types.js";

const REQUIRED_FIELDS = [
  "poNumber",
  "transactionNumber",
  "endCustomerName",
  "carrierShort",
  "trackingNumber",
  "shipDate",
] as const satisfies ReadonlyArray<keyof ParsedShipment>;

export function parseShipmentEml(raw: string): ParseResult {
  const html = extractBase64Body(raw);
  return parseShipmentHtml(html);
}

export function parseShipmentHtml(html: string): ParseResult {
  // Normalize: collapse <br/> and whitespace runs so anchor strings stay on
  // one logical line. Original HTML keeps tags, just neutralizes line breaks.
  const flat = html.replace(/<br\s*\/?>/gi, "\n");

  const poNumber = matchOne(flat, /PO Number:\s+([A-Z0-9-]+)/i);
  const transactionNumber = matchOne(flat, /Transaction Number:\s*(\d+)/i);
  const endCustomerName = matchOne(
    flat,
    /to your customer\s+(.+?)\s+via\s+/i,
  );
  const carrierLong = matchOne(flat, /\svia\s+([^.\n]+?)\.\s/i);
  const carrierShort = matchOne(flat, /Carrier:\s*([^\s<\n]+)/i);
  const trackingNumber = matchOne(flat, /Tracking Number:\s*([A-Z0-9]+)/i);
  const shipDateRaw = matchOne(flat, /Ship Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  // Shipping Cost can legitimately be empty in the source ("Shipping Cost: ").
  // We need to distinguish "label not present" (null) from "label present but
  // empty" ("0.00"), so we run the match directly rather than going through
  // matchOne (which collapses empty captures to null).
  const shippingCostRaw = matchShippingCost(flat);

  const shipment: ParsedShipment = {
    poNumber,
    shopifyOrderNumber: deriveShopifyOrderNumber(poNumber),
    transactionNumber,
    endCustomerName,
    carrierLong,
    carrierShort,
    trackingNumber,
    shipDate: usDateToIso(shipDateRaw),
    shippingCost: normalizeShippingCost(shippingCostRaw),
    lineItems: parseLineItems(html),
  };

  const missingFields: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (shipment[field] === null) missingFields.push(field);
  }
  if (shipment.lineItems.length === 0) missingFields.push("lineItems");

  const totalChecks = REQUIRED_FIELDS.length + 1;
  const confidence =
    Math.round(((totalChecks - missingFields.length) / totalChecks) * 100) / 100;

  return {
    shipment,
    confidence,
    missingFields,
    decodedHtml: html,
  };
}

// ---------- helpers ----------

// Extracts the body section of the .eml and base64-decodes it. Headers and
// body are separated by a blank line per RFC 822. SES emits the base64 body as
// hard-wrapped 64-char lines; we strip whitespace before decoding.
function extractBase64Body(raw: string): string {
  const sep = raw.indexOf("\n\n");
  const sepCrlf = raw.indexOf("\r\n\r\n");
  const headerEnd =
    sepCrlf !== -1 && (sep === -1 || sepCrlf < sep) ? sepCrlf + 4 : sep + 2;
  if (headerEnd <= 1) return "";

  const body = raw.slice(headerEnd);
  const compact = body.replace(/\s+/g, "");
  if (compact.length === 0) return "";

  try {
    return Buffer.from(compact, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

// Returns null when the "Shipping Cost:" label isn't found at all; returns ""
// when the label is present but the value is empty/whitespace; returns the
// trimmed value otherwise. Distinguishing label-absent from value-empty lets
// normalizeShippingCost render an empty source as "0.00" without false
// positives on completely malformed input.
function matchShippingCost(input: string): string | null {
  const m = /Shipping Cost:[ \t]*([^<\n]*)/i.exec(input);
  if (!m) return null;
  return (m[1] ?? "").trim();
}

function matchOne(input: string, re: RegExp): string | null {
  const m = re.exec(input);
  if (!m || !m[1]) return null;
  const value = m[1].trim();
  return value.length > 0 ? value : null;
}

function deriveShopifyOrderNumber(po: string | null): string | null {
  if (!po) return null;
  const m = /^SHOP(\d+)/i.exec(po);
  return m && m[1] ? m[1] : null;
}

// US M/D/YYYY → ISO YYYY-MM-DD. Returns null on malformed input.
function usDateToIso(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!m) return null;
  const month = m[1]!.padStart(2, "0");
  const day = m[2]!.padStart(2, "0");
  const year = m[3]!;
  return `${year}-${month}-${day}`;
}

// Empty string in source → "0.00" so downstream code never has to special-case
// the blank case. Non-empty values are trimmed and returned as-is (the source
// already formats decimals correctly when present).
function normalizeShippingCost(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return "0.00";
  return trimmed;
}

// Pulls SKU + qty rows from the order-summary HTML table. Skips the header row
// (Item / Quantity). Tolerant to whitespace and case-insensitive tag names.
// Zero quantities are preserved — the reconciler interprets qty=0 as a split
// shipment signal and proposes a remove-from-invoice action.
function parseLineItems(html: string): ParsedLineItem[] {
  const items: ParsedLineItem[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push((cellMatch[1] ?? "").replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length < 2) continue;
    const sku = cells[0]!;
    const qty = cells[1]!;
    // Skip the header row: header cells use <th>, not <td>. Header text is
    // "Item" / "Quantity"; reject any row that doesn't have a numeric qty.
    if (!/^-?\d+(\.\d+)?$/.test(qty)) continue;
    if (sku.length === 0) continue;
    items.push({ sku, quantity: qty });
  }

  return items;
}
