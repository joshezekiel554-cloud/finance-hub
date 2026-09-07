// buildInvoiceLineRows is the pure row-mapping behind syncInvoiceLines.
// Covers: over-long sku clamped to the invoice_lines.sku varchar(64) width,
// and non-SalesItemLineDetail lines (subtotals/discounts) skipped.
import { describe, expect, it } from "vitest";
import { buildInvoiceLineRows } from "./sync.js";
import type { QboInvoiceLine } from "./types.js";

describe("buildInvoiceLineRows", () => {
  it("clamps an over-long sku to the column width", () => {
    const longSku = "S".repeat(70);
    const lines: QboInvoiceLine[] = [
      {
        DetailType: "SalesItemLineDetail",
        Description: "Widget",
        Amount: 10,
        LineNum: 1,
        SalesItemLineDetail: { ItemRef: { value: "1", name: longSku }, Qty: 2, UnitPrice: 5 },
      },
    ];
    const rows = buildInvoiceLineRows("inv-1", lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku).toBe("S".repeat(64));
    expect(rows[0]?.sku?.length).toBe(64);
  });

  it("skips non-SalesItemLineDetail lines (subtotals/discounts)", () => {
    const lines: QboInvoiceLine[] = [
      {
        DetailType: "SubTotalLineDetail",
        Amount: 10,
      } as QboInvoiceLine,
      {
        DetailType: "SalesItemLineDetail",
        Description: "Widget",
        Amount: 10,
        LineNum: 1,
        SalesItemLineDetail: { ItemRef: { value: "1", name: "WIDGET-1" }, Qty: 1, UnitPrice: 10 },
      },
    ];
    const rows = buildInvoiceLineRows("inv-1", lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku).toBe("WIDGET-1");
  });
});
