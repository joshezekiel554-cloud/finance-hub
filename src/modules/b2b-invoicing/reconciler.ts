// B2B invoice reconciler.
//
// Aligns a QB invoice's line items to what Feldart actually shipped, treating
// the Feldart Transaction Report as the source of truth. Pure function: takes
// already-resolved inputs (SKUs decoded from QBO Item references upstream),
// returns a list of proposed actions. The UI / send action layer turns those
// actions into QBO writes; the reconciler itself never writes anywhere.
//
// Match strategy: SKU comparison is case-insensitive (`HCTOG01` ≡ `hctog01`).
// QBO lines without a resolved SKU are passed through as `keep` — we don't
// touch lines we can't identify.
//
// The 3rd-party Shopify→QB sync already creates the QB invoice with the right
// B2B prices baked in (special pricing, special offers, customer-specific
// terms). The reconciler does NOT recompute existing line prices. Pricing
// only enters the picture for the rare add-row case (Feldart shipped a SKU
// not on the invoice), where we default to 50% of the Shopify retail and
// flag the row for manual review when no Shopify match is available.

import type {
  ReconcileAction,
  ReconcileInput,
  ReconcileResult,
} from "./types.js";

export function reconcile(input: ReconcileInput): ReconcileResult {
  const actions: ReconcileAction[] = [];

  // Always emit set_metadata first — independent of line diff, header always
  // gets the tracking/ship_via/ship_date stamped onto custom fields.
  actions.push({
    type: "set_metadata",
    trackingNumber: input.shipment.trackingNumber,
    shipVia: input.shipment.shipVia,
    shipDate: input.shipment.shipDate,
  });

  // Index shipment lines by normalized SKU. The Feldart email occasionally has
  // duplicate SKU rows (rare but theoretically possible — split-shipment
  // mid-line); collapse by summing.
  const shippedBySku = new Map<string, number>();
  for (const item of input.shipment.lineItems) {
    const key = normalizeSku(item.sku);
    if (!key) continue;
    shippedBySku.set(key, (shippedBySku.get(key) ?? 0) + item.qty);
  }

  // Index Shopify retail prices by SKU for add-row fallback pricing.
  const retailBySku = new Map<string, number>();
  for (const line of input.shopifyOrderLines ?? []) {
    const key = normalizeSku(line.sku);
    if (!key) continue;
    retailBySku.set(key, line.retailPrice);
  }

  // Track which shipment SKUs we've already accounted for via invoice match.
  // Anything left over after walking invoice lines becomes an `add`.
  const matchedShipmentSkus = new Set<string>();

  for (const line of input.invoiceLines) {
    const key = normalizeSku(line.sku);
    // Lines without a resolved SKU are passed through unchanged. Could be
    // a one-off "Shipping" or "Discount" item the QBO sync attached — we
    // don't have enough info to safely modify it.
    if (!key) {
      actions.push({
        type: "keep",
        lineId: line.lineId,
        sku: line.sku ?? "",
        qty: line.qty,
      });
      continue;
    }

    const shippedQty = shippedBySku.get(key);

    if (shippedQty === undefined) {
      // Invoice has this SKU but Feldart didn't ship it at all. Per the
      // user's rule (the Transaction Report is authoritative), zero out the
      // invoice line. Audit-friendly — line stays at qty 0 on the invoice.
      actions.push({
        type: "qty_change",
        lineId: line.lineId,
        sku: line.sku!,
        fromQty: line.qty,
        toQty: 0,
        reason: "not_shipped",
      });
      continue;
    }

    matchedShipmentSkus.add(key);

    if (shippedQty === line.qty) {
      actions.push({
        type: "keep",
        lineId: line.lineId,
        sku: line.sku!,
        qty: line.qty,
      });
      continue;
    }

    // Quantity differs. Classify the reason for UI affordances; the QBO
    // write is identical regardless of reason.
    let reason: "shipped_less" | "shipped_more" | "split_zero";
    if (shippedQty === 0) {
      reason = "split_zero";
    } else if (shippedQty < line.qty) {
      reason = "shipped_less";
    } else {
      reason = "shipped_more";
    }
    actions.push({
      type: "qty_change",
      lineId: line.lineId,
      sku: line.sku!,
      fromQty: line.qty,
      toQty: shippedQty,
      reason,
    });
  }

  // Anything Feldart shipped that wasn't on the invoice → add row. Iterate
  // shipment lines in original order so the actions list stays deterministic.
  for (const item of input.shipment.lineItems) {
    const key = normalizeSku(item.sku);
    if (!key) continue;
    if (matchedShipmentSkus.has(key)) continue;
    if (item.qty === 0) {
      // A shipment row with explicit qty 0 that has no invoice match. Either
      // a malformed split row or the warehouse zero'd a SKU that was never
      // on the invoice. No action — there's nothing to add (we wouldn't add
      // a $0 line) and nothing to remove (it wasn't there).
      continue;
    }

    const retail = retailBySku.get(key);
    if (retail !== undefined) {
      actions.push({
        type: "add",
        sku: item.sku,
        qty: item.qty,
        // 50% of retail, rounded to cents to match QBO's currency handling.
        unitPrice: round2(retail / 2),
        priceSource: "shopify_b2b",
      });
    } else {
      actions.push({
        type: "add",
        sku: item.sku,
        qty: item.qty,
        unitPrice: null,
        priceSource: "fallback",
      });
    }
    // Not strictly needed (we only walk shipment lines once), but keeps the
    // set consistent if we ever loop back over it.
    matchedShipmentSkus.add(key);
  }

  return {
    actions,
    summary: summarize(actions),
  };
}

// ---------- helpers ----------

function normalizeSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const trimmed = sku.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarize(actions: ReconcileAction[]): ReconcileResult["summary"] {
  let keep = 0;
  let qty_change = 0;
  let add = 0;
  const addsNeedingPrice: string[] = [];
  for (const a of actions) {
    if (a.type === "keep") keep++;
    else if (a.type === "qty_change") qty_change++;
    else if (a.type === "add") {
      add++;
      if (a.priceSource === "fallback") addsNeedingPrice.push(a.sku);
    }
  }
  return { keep, qty_change, add, addsNeedingPrice };
}
