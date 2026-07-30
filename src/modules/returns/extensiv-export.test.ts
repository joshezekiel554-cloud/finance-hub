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
    const { content } = buildExtensivExportFile(
      makeInput({ generatedAt: new Date("2026-07-30T12:00:00Z") }),
    );
    const cols = content.split("\t");
    expect(cols[0]).toBe("Acme Corp Returns - Seasonal - 07-30-26"); // ref
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

  // --- Ref matches the filename when extensivRef is null ---
  it("builds the ref in the same format as the filename", () => {
    const { content, filename } = buildExtensivExportFile(
      makeInput({
        rma: { rmaNumber: "R", extensivRef: null, returnType: "non_seasonal" },
        customer: { name: "Merkaz Monsey", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-07-30T12:00:00Z"),
      }),
    );
    const cols = content.split("\t");
    expect(cols[0]).toBe("Merkaz Monsey Returns - Non Seasonal - 07-30-26");
    // Column A and the filename are read together by the warehouse — they
    // must never drift apart.
    expect(filename).toBe(`${cols[0]}.txt`);
  });

  it("keeps a legacy stored ref on re-download rather than restyling it", () => {
    // An RMA already sitting in the warehouse under the old ref must keep it:
    // Extensiv echoes back the ref it was given, and receipts are matched by
    // exact equality against the stored value.
    const { content } = buildExtensivExportFile(
      makeInput({
        rma: {
          rmaNumber: "R",
          extensivRef: "Acme Corp Pesach 2026 returns",
          returnType: "seasonal",
        },
        generatedAt: new Date("2026-07-30T12:00:00Z"),
      }),
    );
    expect(content.split("\t")[0]).toBe("Acme Corp Pesach 2026 returns");
  });

  // --- Filename: "{Store} Returns - {Type} - MM-DD-YY.txt" (operator spec) ---
  it("names the file store + type + US date", () => {
    const { filename } = buildExtensivExportFile(
      makeInput({
        rma: {
          rmaNumber: "RMA-1",
          extensivRef: null,
          returnType: "seasonal",
        },
        customer: { name: "Merkaz Monsey", qbCustomerId: "QB-123" },
        generatedAt: new Date("2026-07-30T12:00:00Z"),
      }),
    );
    expect(filename).toBe("Merkaz Monsey Returns - Seasonal - 07-30-26.txt");
  });

  it("labels non-seasonal and damage returns distinctly", () => {
    const nonSeasonal = buildExtensivExportFile(
      makeInput({
        rma: { rmaNumber: "R", extensivRef: null, returnType: "non_seasonal" },
        customer: { name: "Eichlers", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-01-05T09:00:00Z"),
      }),
    ).filename;
    expect(nonSeasonal).toBe("Eichlers Returns - Non Seasonal - 01-05-26.txt");

    const damage = buildExtensivExportFile(
      makeInput({
        rma: { rmaNumber: "R", extensivRef: null, returnType: "damage" },
        customer: { name: "Eichlers", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-01-05T09:00:00Z"),
      }),
    ).filename;
    expect(damage).toBe("Eichlers Returns - Damage - 01-05-26.txt");
  });

  it("keeps the store's own capitalisation and spacing", () => {
    const { filename } = buildExtensivExportFile(
      makeInput({
        rma: { rmaNumber: "R", extensivRef: null, returnType: "seasonal" },
        customer: { name: "Feldart & Sons, LLC.", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-11-02T12:00:00Z"),
      }),
    );
    expect(filename).toBe(
      "Feldart & Sons, LLC. Returns - Seasonal - 11-02-26.txt",
    );
  });

  it("strips characters a filesystem rejects from the store name", () => {
    const { filename } = buildExtensivExportFile(
      makeInput({
        rma: { rmaNumber: "R", extensivRef: null, returnType: "seasonal" },
        customer: { name: 'Acme / Beta: "Gold"?', qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-11-02T12:00:00Z"),
      }),
    );
    expect(filename).toBe("Acme Beta Gold Returns - Seasonal - 11-02-26.txt");
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("reads the date on the team's day, not the server's UTC day", () => {
    // 23:30 in London on 30 Jul is still 30 Jul, even though a naive UTC
    // read at BST would be fine — the reverse case is the one that bites:
    // 00:30 BST on 31 Jul is 23:30 UTC on the 30th.
    const { filename } = buildExtensivExportFile(
      makeInput({
        rma: { rmaNumber: "R", extensivRef: null, returnType: "seasonal" },
        customer: { name: "Acme", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-07-30T23:30:00Z"),
      }),
    );
    expect(filename).toBe("Acme Returns - Seasonal - 07-31-26.txt");
  });

  it("falls back to Seasonal when the return type is missing", () => {
    const { filename } = buildExtensivExportFile(
      makeInput({ generatedAt: new Date("2026-03-09T12:00:00Z") }),
    );
    expect(filename).toBe("Acme Corp Returns - Seasonal - 03-09-26.txt");
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

  // --- Sanitize: embedded tabs/newlines in column values must not break the row ---
  it("strips embedded newlines from customer name in notes and ref", () => {
    // Some QBO-imported customer names carry stray \n or \r (Excel-paste artefacts).
    // The exported row must remain exactly 15 tab-separated columns and the
    // newline-bearing value must collapse to a single space.
    const { content } = buildExtensivExportFile(
      makeInput({
        customer: { name: "Acme\nCorp", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-07-30T12:00:00Z"),
      }),
    );
    const rows = content.split("\n");
    expect(rows).toHaveLength(1); // <-- if newline weren't stripped this would be 2
    const cols = rows[0]!.split("\t");
    expect(cols).toHaveLength(15);
    expect(cols[0]).toBe("Acme Corp Returns - Seasonal - 07-30-26");
    expect(cols[3]).toBe("Customer: Acme Corp");
  });

  it("strips embedded tabs from any column value", () => {
    const { content } = buildExtensivExportFile(
      makeInput({
        customer: { name: "Acme\tInc", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-07-30T12:00:00Z"),
        items: [{ sku: "SKU\tA", name: "Item", quantity: "1\t" }],
      }),
    );
    const rows = content.split("\n");
    expect(rows).toHaveLength(1);
    const cols = rows[0]!.split("\t");
    expect(cols).toHaveLength(15);
    expect(cols[0]).toBe("Acme Inc Returns - Seasonal - 07-30-26");
    expect(cols[3]).toBe("Customer: Acme Inc");
    expect(cols[4]).toBe("SKU A");
    expect(cols[5]).toBe("1");
  });

  it("strips carriage returns from values", () => {
    const { content } = buildExtensivExportFile(
      makeInput({
        customer: { name: "Acme\r\nCorp", qbCustomerId: "QB-1" },
        generatedAt: new Date("2026-07-30T12:00:00Z"),
      }),
    );
    const rows = content.split("\n");
    expect(rows).toHaveLength(1);
    const cols = rows[0]!.split("\t");
    expect(cols).toHaveLength(15);
    expect(cols[3]).toBe("Customer: Acme Corp");
  });
});
