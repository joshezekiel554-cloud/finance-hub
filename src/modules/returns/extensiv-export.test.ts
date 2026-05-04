// Tests for the Extensiv 15-column export file builder.
//
// The format is authoritative from excel_generator.py:
//   col 0 = ref# (customer season returns)
//   col 3 = notes
//   col 4 = sku
//   col 5 = quantity
//   cols 1,2,6..14 = empty
// No header row. Tab-delimited, newline between rows.

import { describe, expect, it } from "vitest";
import { buildExtensivExportFile } from "./extensiv-export.js";
import type { ExtensivExportInput } from "./extensiv-export.js";

function makeInput(overrides: Partial<ExtensivExportInput> = {}): ExtensivExportInput {
  return {
    rma: { rmaNumber: "RMA-2026-001", extensivRef: null },
    customer: {
      name: "Acme Corp",
      qbCustomerId: "QB-123",
    },
    season: { name: "Pesach 2026" },
    items: [
      { sku: "MUG-GOLD", name: "Gold Passover Mug", quantity: "2" },
    ],
    ...overrides,
  };
}

describe("buildExtensivExportFile", () => {
  // --- Column count ---
  it("produces exactly 15 tab-separated columns per row", () => {
    const { content } = buildExtensivExportFile(makeInput());
    const rows = content.split("\n");
    expect(rows).toHaveLength(1);
    const cols = rows[0]!.split("\t");
    expect(cols).toHaveLength(15);
  });

  // --- Single-item RMA produces 1 row (no header) ---
  it("produces 1 row for a single-item RMA", () => {
    const { content } = buildExtensivExportFile(makeInput());
    const lines = content.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
  });

  // --- Multi-item RMA produces N rows ---
  it("produces 3 rows for a 3-item RMA", () => {
    const { content } = buildExtensivExportFile(
      makeInput({
        items: [
          { sku: "SKU-A", name: "Item A", quantity: "1" },
          { sku: "SKU-B", name: "Item B", quantity: "2" },
          { sku: "SKU-C", name: "Item C", quantity: "5" },
        ],
      }),
    );
    const lines = content.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3);
  });

  // --- Correct column positions ---
  it("places ref in col 0, sku in col 4, quantity in col 5", () => {
    const { content } = buildExtensivExportFile(makeInput());
    const cols = content.split("\t");
    expect(cols[0]).toBe("Acme Corp Pesach 2026 returns"); // ref
    expect(cols[1]).toBe(""); // empty
    expect(cols[2]).toBe(""); // empty
    expect(cols[3]).toContain("Acme Corp"); // notes contain customer name
    expect(cols[4]).toBe("MUG-GOLD"); // sku
    expect(cols[5]).toBe("2"); // quantity
    // cols 6-14 should all be empty
    for (let i = 6; i < 15; i++) {
      expect(cols[i]).toBe("");
    }
  });

  // --- Ref uses extensivRef if already set ---
  it("uses rma.extensivRef when it is set", () => {
    const { content } = buildExtensivExportFile(
      makeInput({
        rma: { rmaNumber: "RMA-001", extensivRef: "Custom Ref Override" },
      }),
    );
    const cols = content.split("\t");
    expect(cols[0]).toBe("Custom Ref Override");
  });

  // --- Ref built as "{customer} {season} returns" when extensivRef is null ---
  it("builds ref as 'customer season returns' when extensivRef is null", () => {
    const { content } = buildExtensivExportFile(makeInput());
    const cols = content.split("\t");
    expect(cols[0]).toBe("Acme Corp Pesach 2026 returns");
  });

  // --- Filename slugging ---
  it("slugifies customer and season names for the filename", () => {
    const { filename } = buildExtensivExportFile(
      makeInput({
        customer: { name: "Acme Corp", qbCustomerId: "QB-123" },
        season: { name: "Pesach 2026" },
      }),
    );
    expect(filename).toBe("acme-corp_pesach-2026_returns.txt");
  });

  it("handles special chars and spaces in names for filename", () => {
    const { filename } = buildExtensivExportFile(
      makeInput({
        customer: { name: "Feldart & Sons, LLC.", qbCustomerId: "QB-1" },
        season: { name: "Rosh Hashana 5787" },
      }),
    );
    // Special chars become hyphens, consecutive hyphens collapsed
    expect(filename).toMatch(/^[a-z0-9-]+_[a-z0-9-]+_returns\.txt$/);
    expect(filename).toBe("feldart-sons-llc_rosh-hashana-5787_returns.txt");
  });

  // --- Multi-item: each row has correct SKU + qty ---
  it("each row carries the correct item sku and quantity", () => {
    const items = [
      { sku: "ALPHA", name: "Alpha Item", quantity: "10" },
      { sku: "BETA", name: "Beta Item", quantity: "5" },
    ];
    const { content } = buildExtensivExportFile(makeInput({ items }));
    const rows = content.split("\n");
    expect(rows).toHaveLength(2);
    const row0Cols = rows[0]!.split("\t");
    const row1Cols = rows[1]!.split("\t");
    expect(row0Cols[4]).toBe("ALPHA");
    expect(row0Cols[5]).toBe("10");
    expect(row1Cols[4]).toBe("BETA");
    expect(row1Cols[5]).toBe("5");
  });
});
