// Pure helpers for the Invoicing Today "Extensiv shipment" view and the
// Shopify-retail reference column. Kept free of React so they can be unit
// tested (the repo has no DOM test environment).

export type RetailPriceHit = {
  sku: string;
  price: number;
  compareAtPrice: number | null;
  productTitle: string;
  variantTitle: string | null;
  productStatus: string | null;
};

// The slice of a Today row these helpers read.
export type ExtensivRowShape = {
  parsed: {
    poNumber: string | null;
    shopifyOrderNumber: string | null;
    transactionNumber: string | null;
    lineItems: Array<{ sku: string; quantity: string }>;
  };
  qbInvoice: unknown | null;
  reconcileResult: unknown | null;
};

// True when the shipment's reference isn't a Shopify order number (no
// "SHOP" prefix), e.g. "MERKAZleathers" or an Etsy order.
export function isNonShopifyShipment(row: ExtensivRowShape): boolean {
  return row.parsed.shopifyOrderNumber === null;
}

// Show the Extensiv panel whenever nothing else on the card lists what was
// shipped, i.e. there is no reconcile table (no matched QBO doc, or the
// shipment metadata was incomplete).
export function shouldShowExtensivPanel(row: ExtensivRowShape): boolean {
  return row.reconcileResult === null || row.qbInvoice === null;
}

// Human copy for a row with no QBO match, replacing the raw lookup errors
// ("no shopify order number parsed") the card used to show.
export function noMatchExplanation(row: ExtensivRowShape): string {
  if (isNonShopifyShipment(row)) {
    const ref = row.parsed.poNumber ? ` (reference ${row.parsed.poNumber})` : "";
    return `Not a Shopify order${ref}, so there's no QB invoice to match automatically.`;
  }
  return `No QB invoice found for order ${row.parsed.shopifyOrderNumber}.`;
}

// Distinct SKUs, order-preserving, case-insensitive.
export function uniqueSkus(skus: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of skus) {
    const t = (s ?? "").trim();
    if (!t) continue;
    const k = t.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// SKUs of the lines the operator prices by hand on a reconcile table: every
// "add" action (warehouse shipped it but it wasn't on the invoice/order, or
// it was added from the QB picker).
export function addSkusNeedingReference(
  actions: Array<{ type: string; sku?: string }>,
): string[] {
  return uniqueSkus(actions.filter((a) => a.type === "add").map((a) => a.sku));
}

export function formatRetail(hit: RetailPriceHit | undefined): string {
  return hit ? `$${hit.price.toFixed(2)}` : "—";
}

export function retailTooltip(hit: RetailPriceHit | undefined): string | undefined {
  if (!hit) return "Not found in the Shopify catalogue";
  const name = hit.variantTitle ? `${hit.productTitle} – ${hit.variantTitle}` : hit.productTitle;
  const parts = [name];
  if (hit.compareAtPrice !== null) parts.push(`compare-at $${hit.compareAtPrice.toFixed(2)}`);
  if (hit.productStatus && hit.productStatus !== "ACTIVE") parts.push(hit.productStatus.toLowerCase());
  return parts.join(" · ");
}

// ---------- Extensiv warehouse charges (shipping cost) ----------

// Mirrors the server's ShipmentCharges (src/integrations/extensiv/charges.ts).
export type ShipmentChargesView = {
  transactionNumber: string;
  reference: string | null;
  shipping: number | null;
  lines: Array<{ label: string; amount: number }>;
  totalCharges: number | null;
  carrierService: string | null;
  carrierRate: number | null;
};

// Short label for the card: "Shipping $6.87", or why there isn't one.
export function shippingLabel(c: ShipmentChargesView | undefined): string | null {
  if (!c) return null;
  if (c.shipping !== null) return `Shipping $${c.shipping.toFixed(2)}`;
  if (c.totalCharges === null) return "Shipping: not billed yet";
  return "Shipping: no freight charge";
}

// Hover breakdown: every billed line, the total, and the carrier's own rate.
export function shippingTooltip(c: ShipmentChargesView | undefined): string | undefined {
  if (!c) return undefined;
  const parts = c.lines.map((l) => `${l.label} $${l.amount.toFixed(2)}`);
  if (c.totalCharges !== null) parts.push(`Total Blue Chip charges $${c.totalCharges.toFixed(2)}`);
  if (c.carrierRate !== null) {
    parts.push(`Carrier rate${c.carrierService ? ` (${c.carrierService})` : ""} $${c.carrierRate.toFixed(2)}`);
  }
  return parts.length > 0 ? `Extensiv / Blue Chip:\n${parts.join("\n")}` : undefined;
}

// Numeric, de-duplicated, sorted transaction numbers for the batch lookup.
export function transactionNumbersFor(
  rows: Array<{ parsed: { transactionNumber: string | null } }>,
): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const t = r.parsed.transactionNumber?.trim();
    if (t && /^\d{1,12}$/.test(t)) out.add(t);
  }
  return Array.from(out).sort();
}
