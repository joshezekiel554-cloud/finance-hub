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

function parseItems(body: string): Array<{ sku: string; quantity: number }> {
  const items: Array<{ sku: string; quantity: number }> = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = ITEM_ROW_RE.exec(trimmed);
    if (!m) continue;
    const sku = m[1]!;
    // Skip obvious header rows
    if (HEADER_WORDS.has(sku.toLowerCase())) continue;
    const qty = parseFloat(m[2]!);
    if (Number.isNaN(qty)) continue;
    items.push({ sku, quantity: qty });
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
  const parsedItems = parseItems(body);
  const confidence = computeConfidence("return_receipt", txNumber, refString, parsedItems);

  return {
    direction: "return_receipt",
    ...(txNumber !== undefined ? { txNumber } : {}),
    ...(refString !== undefined ? { refString } : {}),
    parsedItems,
    confidence,
  };
}
