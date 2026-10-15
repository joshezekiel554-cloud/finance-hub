import { describe, expect, it } from "vitest";
import {
  buildCustomerHistory,
  FINANCE_TOOLS,
  fitRows,
  toolByName,
  toolManifest,
  ToolInputError,
} from "./finance-tools.js";

describe("finance tool manifest", () => {
  it("lists every tool in Anthropic tool format with strict object schemas", () => {
    const { tools } = toolManifest();
    expect(tools.map((t) => t.name)).toEqual([
      "find_customer",
      "customer_summary",
      "open_invoices",
      "aged_debtors",
      "returns",
      "customer_history",
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]{1,40}$/);
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      // Every required key must be a declared property.
      const props = Object.keys((t.input_schema as { properties: object }).properties);
      for (const r of ((t.input_schema as { required?: string[] }).required ?? [])) {
        expect(props).toContain(r);
      }
    }
  });

  it("looks tools up by name", () => {
    expect(toolByName("aged_debtors")?.name).toBe("aged_debtors");
    expect(toolByName("nope")).toBeUndefined();
  });
});

describe("tool input validation (rejected before any DB access)", () => {
  const ctx = { now: new Date("2026-10-15T12:00:00Z"), baseUrl: "https://f" };
  const run = (name: string, input: unknown) => toolByName(name)!.run(input, ctx);

  it("explains bad input to the model as a ToolInputError", async () => {
    await expect(run("find_customer", { query: "a" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(run("customer_summary", {})).rejects.toThrow(/customerId/);
    await expect(run("returns", { from: "2026-02-31", to: "2026-03-01" })).rejects.toThrow(/from: not a real date/);
    await expect(run("returns", { from: "2026-10-02", to: "2026-10-01" })).rejects.toThrow(/on or before/);
    await expect(run("aged_debtors", { top: 0 })).rejects.toBeInstanceOf(ToolInputError);
    await expect(run("customer_history", { customerId: "c1", from: "15/10/2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("every tool is registered once", () => {
    expect(new Set(FINANCE_TOOLS.map((t) => t.name)).size).toBe(FINANCE_TOOLS.length);
  });
});

describe("fitRows", () => {
  it("keeps everything under budget", () => {
    expect(fitRows([{ a: 1 }, { a: 2 }], 1000)).toEqual({ rows: [{ a: 1 }, { a: 2 }], note: null });
  });

  it("trims and says so when over budget", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(50) }));
    const r = fitRows(rows, 1000);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThan(100);
    expect(JSON.stringify(r.rows).length).toBeLessThanOrEqual(1000);
    expect(r.note).toMatch(new RegExp(`Showing ${r.rows.length} of 100 rows`));
  });
});

describe("buildCustomerHistory", () => {
  it("groups by SKU, biggest value first, with last date and last unit price", () => {
    const items = buildCustomerHistory([
      { sku: "OJL03G", itemName: "Oil Jug - Gold", description: "OJL03G", qty: "2", unitPrice: "10", lineTotal: "20", issueDate: new Date("2026-08-01T00:00:00Z"), origin: "feldart" },
      { sku: "OJL03G", itemName: "Oil Jug - Gold", description: "OJL03G", qty: "3", unitPrice: "9.5", lineTotal: "28.5", issueDate: "2026-09-01", origin: "feldart" },
      { sku: "AHC01GS", itemName: "Al Hamichya", description: "AHC01GS", qty: "10", unitPrice: "6", lineTotal: "60", issueDate: "2025-01-01", origin: "tj" },
      { sku: null, itemName: "Shipping per item", description: "Shipping per item", qty: "1", unitPrice: "5", lineTotal: "5", issueDate: "2026-09-01", origin: "feldart" },
    ]);
    expect(items).toEqual([
      { sku: "AHC01GS", product: "Al Hamichya", qty: 10, value: 60, lines: 1, lastBought: "2025-01-01", lastUnitPrice: 6, books: "tj" },
      { sku: "OJL03G", product: "Oil Jug - Gold", qty: 5, value: 48.5, lines: 2, lastBought: "2026-09-01", lastUnitPrice: 9.5, books: "feldart" },
      { sku: null, product: "Shipping per item", qty: 1, value: 5, lines: 1, lastBought: "2026-09-01", lastUnitPrice: 5, books: "feldart" },
    ]);
  });
});
