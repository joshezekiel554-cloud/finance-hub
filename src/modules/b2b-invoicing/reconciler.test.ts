import { describe, expect, it } from "vitest";
import { reconcile } from "./reconciler.js";
import type {
  InvoiceLineForReconcile,
  ReconcileAction,
  ShipmentForReconcile,
  ShopifyOrderLineForReconcile,
} from "./types.js";

function makeShipment(
  lineItems: Array<{ sku: string; qty: number }>,
  overrides: Partial<ShipmentForReconcile> = {},
): ShipmentForReconcile {
  return {
    trackingNumber: "1Z0JF5830328583312",
    shipVia: "UPS",
    shipDate: "2026-04-27",
    lineItems,
    ...overrides,
  };
}

function makeLine(
  sku: string | null,
  qty: number,
  unitPrice = 100,
  lineId = `line-${sku ?? "x"}`,
): InvoiceLineForReconcile {
  return { lineId, sku, qty, unitPrice };
}

function findOnly<K extends ReconcileAction["type"]>(
  actions: ReconcileAction[],
  type: K,
): Extract<ReconcileAction, { type: K }>[] {
  return actions.filter((a) => a.type === type) as Extract<
    ReconcileAction,
    { type: K }
  >[];
}

describe("reconcile — set_metadata always emitted first", () => {
  it("emits exactly one set_metadata action with header values", () => {
    const result = reconcile({
      shipment: makeShipment([]),
      invoiceLines: [],
    });
    expect(result.actions[0]).toEqual({
      type: "set_metadata",
      trackingNumber: "1Z0JF5830328583312",
      shipVia: "UPS",
      shipDate: "2026-04-27",
    });
    expect(findOnly(result.actions, "set_metadata")).toHaveLength(1);
  });
});

describe("reconcile — keep when shipped qty matches invoice qty", () => {
  it("emits a keep action and zero qty_changes when SKUs and qty all match", () => {
    const result = reconcile({
      shipment: makeShipment([
        { sku: "HCTOG01", qty: 23 },
        { sku: "ABC-123", qty: 5 },
      ]),
      invoiceLines: [
        makeLine("HCTOG01", 23, 50),
        makeLine("ABC-123", 5, 12),
      ],
    });
    expect(result.summary).toEqual({
      keep: 2,
      qty_change: 0,
      add: 0,
      addsNeedingPrice: [],
    });
    const keeps = findOnly(result.actions, "keep");
    expect(keeps.map((k) => k.sku)).toEqual(["HCTOG01", "ABC-123"]);
  });

  it("matches SKUs case-insensitively", () => {
    const result = reconcile({
      shipment: makeShipment([{ sku: "hctog01", qty: 23 }]),
      invoiceLines: [makeLine("HCTOG01", 23)],
    });
    expect(result.summary.keep).toBe(1);
    expect(result.summary.qty_change).toBe(0);
  });
});

describe("reconcile — qty_change reasons", () => {
  it("classifies shipped_less when Feldart shipped fewer than invoice qty", () => {
    const result = reconcile({
      shipment: makeShipment([{ sku: "HCTOG01", qty: 10 }]),
      invoiceLines: [makeLine("HCTOG01", 23)],
    });
    const changes = findOnly(result.actions, "qty_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sku: "HCTOG01",
      fromQty: 23,
      toQty: 10,
      reason: "shipped_less",
    });
  });

  it("classifies shipped_more when Feldart shipped more than invoice qty", () => {
    const result = reconcile({
      shipment: makeShipment([{ sku: "HCTOG01", qty: 30 }]),
      invoiceLines: [makeLine("HCTOG01", 23)],
    });
    const changes = findOnly(result.actions, "qty_change");
    expect(changes[0]?.reason).toBe("shipped_more");
    expect(changes[0]?.toQty).toBe(30);
  });

  it("classifies not_shipped when invoice has SKU but shipment does not list it at all", () => {
    const result = reconcile({
      shipment: makeShipment([{ sku: "HCTOG01", qty: 23 }]),
      invoiceLines: [
        makeLine("HCTOG01", 23),
        makeLine("MISSING-SKU", 5),
      ],
    });
    const changes = findOnly(result.actions, "qty_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sku: "MISSING-SKU",
      fromQty: 5,
      toQty: 0,
      reason: "not_shipped",
    });
  });

  it("classifies split_zero when shipment explicitly says qty 0", () => {
    const result = reconcile({
      shipment: makeShipment([
        { sku: "HCTOG01", qty: 23 },
        { sku: "SPLIT-SKU", qty: 0 },
      ]),
      invoiceLines: [
        makeLine("HCTOG01", 23),
        makeLine("SPLIT-SKU", 5),
      ],
    });
    const changes = findOnly(result.actions, "qty_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sku: "SPLIT-SKU",
      fromQty: 5,
      toQty: 0,
      reason: "split_zero",
    });
  });
});

describe("reconcile — add when shipment has SKU not on invoice", () => {
  it("uses 50% of Shopify retail when SKU is in shopifyOrderLines", () => {
    const result = reconcile({
      shipment: makeShipment([
        { sku: "HCTOG01", qty: 23 },
        { sku: "EXTRA-SKU", qty: 4 },
      ]),
      invoiceLines: [makeLine("HCTOG01", 23)],
      shopifyOrderLines: [
        { sku: "HCTOG01", retailPrice: 17.1 },
        { sku: "EXTRA-SKU", retailPrice: 80.0 },
      ],
    });
    const adds = findOnly(result.actions, "add");
    expect(adds).toHaveLength(1);
    expect(adds[0]).toEqual({
      type: "add",
      sku: "EXTRA-SKU",
      qty: 4,
      unitPrice: 40.0,
      priceSource: "shopify_b2b",
    });
    expect(result.summary.addsNeedingPrice).toEqual([]);
  });

  it("falls back to null price + flags SKU when no Shopify match", () => {
    const result = reconcile({
      shipment: makeShipment([{ sku: "MYSTERY-SKU", qty: 1 }]),
      invoiceLines: [],
      shopifyOrderLines: [],
    });
    const adds = findOnly(result.actions, "add");
    expect(adds[0]).toMatchObject({
      sku: "MYSTERY-SKU",
      qty: 1,
      unitPrice: null,
      priceSource: "fallback",
    });
    expect(result.summary.addsNeedingPrice).toEqual(["MYSTERY-SKU"]);
  });

  it("rounds the 50%-retail price to cents", () => {
    const result = reconcile({
      shipment: makeShipment([{ sku: "ODD-SKU", qty: 1 }]),
      invoiceLines: [],
      shopifyOrderLines: [{ sku: "ODD-SKU", retailPrice: 7.21 }],
    });
    const adds = findOnly(result.actions, "add");
    // 7.21 / 2 = 3.605; round-half-away-from-zero → 3.61
    expect(adds[0]?.unitPrice).toBe(3.61);
  });

  it("does not emit add for shipment rows with explicit qty 0", () => {
    // A zero-qty shipment row with no invoice match is informational only —
    // we wouldn't add a $0 line and there's nothing to remove.
    const result = reconcile({
      shipment: makeShipment([{ sku: "GHOST-SKU", qty: 0 }]),
      invoiceLines: [],
    });
    expect(findOnly(result.actions, "add")).toHaveLength(0);
    expect(findOnly(result.actions, "qty_change")).toHaveLength(0);
  });
});

describe("reconcile — defensive cases", () => {
  it("passes through invoice lines with no resolved SKU as keep, untouched", () => {
    const result = reconcile({
      shipment: makeShipment([{ sku: "HCTOG01", qty: 23 }]),
      invoiceLines: [
        makeLine("HCTOG01", 23),
        makeLine(null, 1, 0, "shipping-line"),
      ],
    });
    const keeps = findOnly(result.actions, "keep");
    expect(keeps.find((k) => k.lineId === "shipping-line")).toBeDefined();
    expect(findOnly(result.actions, "qty_change")).toHaveLength(0);
  });

  it("collapses duplicate shipment SKU rows by summing", () => {
    const result = reconcile({
      shipment: makeShipment([
        { sku: "HCTOG01", qty: 10 },
        { sku: "HCTOG01", qty: 13 },
      ]),
      invoiceLines: [makeLine("HCTOG01", 23)],
    });
    expect(result.summary.keep).toBe(1);
    expect(result.summary.qty_change).toBe(0);
  });

  it("ignores shipment rows with empty/whitespace SKUs", () => {
    const result = reconcile({
      shipment: makeShipment([
        { sku: "HCTOG01", qty: 23 },
        { sku: "   ", qty: 5 },
      ]),
      invoiceLines: [makeLine("HCTOG01", 23)],
    });
    expect(result.summary.keep).toBe(1);
    expect(result.summary.add).toBe(0);
    expect(result.summary.qty_change).toBe(0);
  });
});

describe("reconcile — live-fixture alignment (HCTOG01 / SHOP18301)", () => {
  it("a perfect match against the live SHOP18301 invoice produces only set_metadata + keep", () => {
    // Mirrors the smoke-tested reality: parser fixture says HCTOG01 × 23
    // shipped, Shopify confirms HCTOG01 × 23 on order #18301, and the auto-
    // synced QB invoice carries the same line. Reconciler should propose
    // nothing except stamping the tracking metadata onto the header.
    const result = reconcile({
      shipment: makeShipment([{ sku: "HCTOG01", qty: 23 }]),
      invoiceLines: [makeLine("HCTOG01", 23, 8.55)],
    });
    expect(result.summary).toEqual({
      keep: 1,
      qty_change: 0,
      add: 0,
      addsNeedingPrice: [],
    });
    expect(result.actions.map((a) => a.type)).toEqual(["set_metadata", "keep"]);
  });
});
