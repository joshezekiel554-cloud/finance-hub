// buildInvoiceLineRows is the pure row-mapping behind syncInvoiceLines.
// Covers: the SKU comes from the QBO Item catalogue (Feldart names items by
// product title and puts the code in Description), the Description
// fallback, sku_source bookkeeping for the self-healing backfill, column
// clamps, and non-SalesItemLineDetail lines (subtotals/discounts) skipped.
import { describe, expect, it } from "vitest";
import { buildInvoiceLineRows, resolveLineSku } from "./sync.js";
import type { QboInvoiceLine } from "./types.js";

const line = (over: Partial<QboInvoiceLine> & { itemId?: string; itemName?: string }): QboInvoiceLine => ({
  DetailType: "SalesItemLineDetail",
  Description: over.Description,
  Amount: 10,
  LineNum: 1,
  SalesItemLineDetail: {
    ItemRef: { value: over.itemId ?? "42", name: over.itemName ?? "Woven Leatherite Oil Jug - Gold" },
    Qty: 2,
    UnitPrice: 5,
  },
});

describe("resolveLineSku", () => {
  const items = new Map([["42", "OJL03G"]]);

  it("prefers a code-like Description — what the invoice actually says", () => {
    // The catalogue can be wrong (silver item carrying the gold SKU).
    expect(resolveLineSku("42", "OJL03S", items)).toEqual({ sku: "OJL03S", source: "description" });
    expect(resolveLineSku(undefined, " AHC01GS ", null)).toEqual({ sku: "AHC01GS", source: "description" });
  });

  it("uses the Item catalogue SKU when the Description is free text", () => {
    expect(resolveLineSku("42", "OJL03G (5% discount)", items)).toEqual({ sku: "OJL03G", source: "item" });
    expect(resolveLineSku("42", undefined, items)).toEqual({ sku: "OJL03G", source: "item" });
  });

  it("refuses free text and digit-less words as a SKU", () => {
    expect(resolveLineSku("99", "Shipping", items)).toEqual({ sku: null, source: "none" });
    expect(resolveLineSku("99", "Gift box 2 pack", items)).toEqual({ sku: null, source: "none" });
    // A "Services" line's reference number is not a SKU.
    expect(resolveLineSku("99", "25781", items)).toEqual({ sku: null, source: "none" });
    expect(resolveLineSku("99", undefined, items)).toEqual({ sku: null, source: "none" });
  });
});

describe("buildInvoiceLineRows", () => {
  it("writes the SKU, keeps the title as item_name and the Description as-is", () => {
    const rows = buildInvoiceLineRows("inv-1", [line({ Description: "Oil jug" })], new Map([["42", "OJL03G"]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sku: "OJL03G",
      description: "Oil jug",
      qbItemId: "42",
      itemName: "Woven Leatherite Oil Jug - Gold",
      skuSource: "item",
      qty: "2",
      unitPrice: "5",
    });
  });

  it("leaves sku_source NULL when the catalogue was unavailable, so the next sync heals the row", () => {
    const rows = buildInvoiceLineRows("inv-1", [line({ Description: "OJL03G" })], null);
    expect(rows[0]).toMatchObject({ sku: "OJL03G", skuSource: null });
  });

  it("clamps over-long values to the column widths", () => {
    const rows = buildInvoiceLineRows(
      "inv-1",
      [line({ Description: "x", itemName: "N".repeat(300) })],
      new Map([["42", "S".repeat(70)]]),
    );
    expect(rows[0]?.sku).toBe("S".repeat(64));
    expect(rows[0]?.itemName).toBe("N".repeat(255));
  });

  it("skips non-SalesItemLineDetail lines (subtotals/discounts)", () => {
    const rows = buildInvoiceLineRows(
      "inv-1",
      [{ DetailType: "SubTotalLineDetail", Amount: 10 } as QboInvoiceLine, line({ Description: "WIDGET-1" })],
      new Map(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "WIDGET-1", skuSource: "description" });
  });
});
