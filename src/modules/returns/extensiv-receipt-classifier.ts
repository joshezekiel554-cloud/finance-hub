// Extensiv (Fulfilled by Amazon SES, sender notifications@secure-wms.com) email classifier.
//
// Distinguishes outbound shipment notifications from return-receipt notifications.
// Per spec §11: "put into inventory" and "summary of the receipt" are stable markers
// in Extensiv's email templates and reliably distinguish receipt emails from shipment emails.
//
// Entry point: classifyExtensivEmail({ from, subject, body })

export type ExtensivEmailDirection = "outbound" | "return_receipt" | "unknown";

export type ClassifiedExtensivEmail = {
  direction: ExtensivEmailDirection;
  txNumber?: string;
  refString?: string;
  // Best-effort customer name extracted from the Ref: line. The matcher's
  // tier-3 fuzzy path reads this when tx# and exact-ref both miss; without
  // it that tier is dead. Conservative: empty string → undefined (treated
  // as null by the persistence layer).
  inferredCustomerName?: string;
  parsedItems?: Array<{ sku: string; quantity: number }>;
  confidence: number;
};

const EXTENSIV_SENDER = "notifications@secure-wms.com";

// Matches "(12345)" — Extensiv embeds the tx# in parens in the subject or body.
const TX_NUMBER_RE = /\((\d+)\)/;

// "Ref: Customer Acme returns" or "Ref Acme Company returns" (colon optional)
const REF_STRING_RE = /Ref:?\s*([^\n]+)/i;

// Table rows like:   SKU-001\t5   or   SKU-001\t5.00
// Also handles a space-separated form: SKU-001  5
// Skips lines that are obviously headers ("Item", "SKU", "Quantity", etc.)
const ITEM_ROW_RE = /^([A-Za-z0-9_\-.]+)[\t ]+(\d+(?:\.\d+)?)\s*$/;
const HEADER_WORDS = new Set(["item", "sku", "qty", "quantity", "description", "part"]);

function parseTxNumber(text: string): string | undefined {
  const m = TX_NUMBER_RE.exec(text);
  return m?.[1] ?? undefined;
}

function parseRefString(body: string): string | undefined {
  const m = REF_STRING_RE.exec(body);
  if (!m?.[1]) return undefined;
  return m[1].trim() || undefined;
}

// Season tokens we expect to see embedded in the Ref line. Matches:
//   Spring2026, Summer 2025, Fall2026, Winter 2026, Pesach2026, Pesach 2025,
//   RoshHashana 5787, Sukkot 5786, Pesach, etc.
// The year part (4 digits) is optional and may be Gregorian or Hebrew.
// The leading-anchor and trailing-anchor variants are both supported because
// in practice the Ref looks like "{customer} {season}{year} returns" but we
// have seen variants where the season comes first.
const SEASON_TOKEN = "(?:spring|summer|fall|autumn|winter|pesach|passover|sukkot|sukkos|shavuos|shavuot|hannukah|chanukah|hanukkah|roshhashana|rosh\\s*hashana)";
// Trailing form: "...word Spring2026" or "...word Spring 2026"
const TRAILING_SEASON_RE = new RegExp(`\\s+${SEASON_TOKEN}\\s*\\d{0,4}\\s*$`, "i");
// Leading form: "Spring2026 word..." or "2026 word..."
const LEADING_SEASON_RE = new RegExp(`^\\s*(?:${SEASON_TOKEN}\\s*\\d{0,4}|\\d{4})\\s+`, "i");
// Match the trailing "returns" / "return" word — leading whitespace is
// optional so a Ref of just "returns" (rare/empty case) collapses to "".
const TRAILING_RETURNS_RE = /(?:^|\s+)returns?\s*$/i;

// Extract a best-effort customer name from a parsed Ref string.
// Examples:
//   "Acme Company Spring2026 returns" → "Acme Company"
//   "Test Customer Spring2026 returns" → "Test Customer"
//   "Best Boutique Summer 2025 returns" → "Best Boutique"
//   "Pesach2026 Acme Company returns" → "Acme Company"
//
// Conservative: returns undefined for empty results so the matcher stays
// safe rather than fuzzy-matching on noise.
export function inferCustomerNameFromRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  let remainder = ref.trim();
  // 1. Strip trailing "returns" / "return"
  remainder = remainder.replace(TRAILING_RETURNS_RE, "").trim();
  // 2. Strip trailing season token (the common case)
  remainder = remainder.replace(TRAILING_SEASON_RE, "").trim();
  // 3. Strip leading season-y token (rarer — season-prefixed refs)
  remainder = remainder.replace(LEADING_SEASON_RE, "").trim();
  return remainder.length > 0 ? remainder : undefined;
}

// Bluechip's "summary of the receipt" usually arrives as an HTML table
// (no text/plain part), so the line-by-line regex can't see SKUs that
// are wrapped in <td>. Strip tags + entities before the regex runs.
// Replace structural elements with whitespace so cells from one row end
// up on a single line ("<td>SKU</td><td>1.00</td>" → "SKU 1.00").
function stripHtmlForParse(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|p|div|li)>/gi, "\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseItems(body: string): Array<{ sku: string; quantity: number }> {
  // Run the line regex on both the raw body (catches plain-text formats)
  // and the HTML-stripped variant (catches table-cell formats). Dedupe
  // on SKU so we don't double-count when both forms match.
  const seen = new Set<string>();
  const items: Array<{ sku: string; quantity: number }> = [];
  for (const variant of [body, stripHtmlForParse(body)]) {
    for (const line of variant.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = ITEM_ROW_RE.exec(trimmed);
      if (!m) continue;
      const sku = m[1]!;
      if (HEADER_WORDS.has(sku.toLowerCase())) continue;
      if (seen.has(sku)) continue;
      const qty = parseFloat(m[2]!);
      if (Number.isNaN(qty)) continue;
      seen.add(sku);
      items.push({ sku, quantity: qty });
    }
  }
  return items;
}

function computeConfidence(
  direction: ExtensivEmailDirection,
  txNumber: string | undefined,
  refString: string | undefined,
  parsedItems: Array<{ sku: string; quantity: number }>,
): number {
  if (direction !== "return_receipt") return direction === "outbound" ? 1.0 : 0;

  const hasTxOrRef = Boolean(txNumber ?? refString);
  const hasItems = parsedItems.length > 0;

  if (hasTxOrRef && hasItems) return 1.0;
  if (hasTxOrRef && !hasItems) return 0.7;
  // direction set but neither tx# nor ref
  return 0.5;
}

export function classifyExtensivEmail(input: {
  from: string;
  subject: string;
  body: string;
}): ClassifiedExtensivEmail {
  const { from, subject, body } = input;

  // Sender guard — any email not from Extensiv is unknown.
  if (!from.includes(EXTENSIV_SENDER)) {
    return { direction: "unknown", confidence: 0 };
  }

  const fullText = `${subject}\n${body}`;

  // Return-receipt markers (order matters: "summary of the receipt" is the
  // primary signal; "put into inventory" is a secondary signal when the
  // summary phrase isn't present).
  const hasSummaryMarker = /summary of the receipt/i.test(body);
  const hasInventoryMarker = /put into inventory/i.test(body);

  if (!hasSummaryMarker && !hasInventoryMarker) {
    // Outbound shipment notification — default for valid Extensiv emails.
    return { direction: "outbound", confidence: 1.0 };
  }

  // --- Return receipt path ---
  const txNumber = parseTxNumber(fullText);
  const refString = parseRefString(body);
  const inferredCustomerName = inferCustomerNameFromRef(refString);
  const parsedItems = parseItems(body);
  const confidence = computeConfidence("return_receipt", txNumber, refString, parsedItems);

  return {
    direction: "return_receipt",
    ...(txNumber !== undefined ? { txNumber } : {}),
    ...(refString !== undefined ? { refString } : {}),
    ...(inferredCustomerName !== undefined ? { inferredCustomerName } : {}),
    parsedItems,
    confidence,
  };
}
