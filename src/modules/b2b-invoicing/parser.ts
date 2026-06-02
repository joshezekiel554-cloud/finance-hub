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

  const { items: lineItems, unparsedRows } = parseLineItems(html);

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
    lineItems,
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
    unparsedRows,
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

// Pulls SKU + qty rows from the order-summary HTML table, AND records rows
// that look like items but couldn't be read (the parse-gap signal).
//
// Scoping: we first identify the items table (the <table> with the most
// numeric-quantity rows — robust to header styling) and only parse rows there.
// This stops us pulling phantom "items" from layout tables, and lets us
// confidently flag a row with a SKU but an unreadable quantity as a possible
// miss. If no items table can be identified (e.g. malformed email), we fall
// back to scanning the whole document for items and flag NOTHING — an empty
// `unparsedRows` is correct rather than a stream of false positives.
//
// Header rows (<th>, or literal "Item"/"Quantity"/"SKU"/"Qty" cells) are never
// items and never flagged. Zero quantities are preserved — the reconciler
// reads qty=0 as a split-shipment signal.
const NUMERIC_QTY = /^-?\d+(\.\d+)?$/;

function parseLineItems(html: string): {
  items: ParsedLineItem[];
  unparsedRows: string[];
} {
  const items: ParsedLineItem[] = [];
  const unparsedRows: string[] = [];

  const itemsTable = extractItemsTable(html);
  const scope = itemsTable ?? html;
  const collectUnparsed = itemsTable !== null;

  for (const cells of iterRows(scope, { skipHeaderRows: true })) {
    if (cells.length < 2) continue;
    const sku = cells[0]!;
    const qty = cells[1]!;
    if (isHeaderLabel(sku) && isHeaderLabel(qty)) continue;
    if (NUMERIC_QTY.test(qty)) {
      if (sku.length > 0) items.push({ sku, quantity: qty });
      continue;
    }
    // Non-numeric quantity but a SKU is present, inside the items table: this
    // row was meant to be a line item and we couldn't read it. Record it.
    if (collectUnparsed && sku.length > 0) {
      unparsedRows.push(`${sku} — ${qty}`);
    }
  }

  return { items, unparsedRows };
}

// Yields the trimmed cell-text arrays for each <tr> in the given HTML. When
// skipHeaderRows is set, rows containing a <th> cell are skipped entirely
// (they are headers, never data).
function* iterRows(
  html: string,
  opts: { skipHeaderRows: boolean },
): Generator<string[]> {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    if (opts.skipHeaderRows && /<th[\s>]/i.test(rowHtml)) continue;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push((cellMatch[1] ?? "").replace(/<[^>]+>/g, "").trim());
    }
    yield cells;
  }
}

// Picks the <table> with the most numeric-quantity data rows — that's the
// items table regardless of how its header is styled. Returns its full HTML,
// or null when no table has any numeric-qty rows.
function extractItemsTable(html: string): string | null {
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let best: string | null = null;
  let bestScore = 0;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(html)) !== null) {
    const tableHtml = m[0];
    let score = 0;
    for (const cells of iterRows(tableHtml, { skipHeaderRows: true })) {
      if (cells.length >= 2 && NUMERIC_QTY.test(cells[1]!)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = tableHtml;
    }
  }
  return bestScore > 0 ? best : null;
}

function isHeaderLabel(s: string): boolean {
  const v = s.trim().toLowerCase();
  return v === "item" || v === "quantity" || v === "sku" || v === "qty";
}
