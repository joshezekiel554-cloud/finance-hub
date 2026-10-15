import { describe, expect, it } from "vitest";
import { buildSeasonSales, isPlaceholderCustomer, salesWindow, type SalesLineRow } from "./sales.js";
import {
  customerHistoryQuerySchema,
  seasonSalesQuerySchema,
} from "../../server/routes/ext-reports.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const GROSS = "Gross invoiced sales: returns and credit memos are not deducted (see the Returns report).";

const line = (over: Partial<SalesLineRow>): SalesLineRow => ({
  sku: "STBN01",
  itemName: "Blush Nectar Simanim Tray",
  description: "STBN01",
  qty: "2",
  unitPrice: "10",
  lineTotal: "20",
  issueDate: "2026-08-01",
  origin: "feldart",
  skuSource: "description",
  customerId: "c1",
  qbItemId: "7",
  ...over,
});

const base = {
  seasonName: "Rosh Hashanah 2026",
  from: "2026-04-01",
  to: "2026-09-30",
  books: ["feldart", "tj"] as Array<"feldart" | "tj">,
  productNames: new Map([["STBN01", "Simanim Tray - Blush Nectar"]]),
  customers: new Map([
    ["c1", { name: "Acme Judaica", email: "a@x.com" }],
    ["c2", { name: "Beth Books", email: null }],
  ]),
  now: NOW,
  customerUrl: (id: string) => `https://f/customers/${id}`,
};

const lines = [
  line({}),
  line({ customerId: "c2", qty: "5", lineTotal: "50", issueDate: "2026-09-01" }),
  line({ sku: "SLPBN01", itemName: "Leather Pouch Simanim", qty: "1", lineTotal: "30", customerId: "c2" }),
  line({ sku: "Legacy Title", skuSource: null, lineTotal: "999" }), // pre-fix row: excluded + warned
];

describe("season sales", () => {
  it("skus view: one row per SKU, season product names, store counts, biggest first", () => {
    const t = buildSeasonSales({ ...base, view: "skus", lines });
    expect(t.rows).toEqual([
      { sku: "STBN01", product: "Simanim Tray - Blush Nectar", qty: 7, value: 70, customers: 2, lines: 2 },
      { sku: "SLPBN01", product: "Leather Pouch Simanim", qty: 1, value: 30, customers: 1, lines: 1 },
    ]);
    expect(t.totals).toEqual({ qty: 8, value: 100, lines: 3 });
    expect(t.warnings).toEqual([
      "1 of 4 invoice lines predate the SKU rebuild (invoices deleted in QuickBooks) and are left out.",
      GROSS,
    ]);
    expect(t.title).toBe("Rosh Hashanah 2026 sales 2026-04-01 to 2026-09-30");
    expect(t.columns.find((c) => c.key === "value")).toMatchObject({ type: "money", currency: "USD" });
  });

  it("customers view: one row per store with distinct season SKUs", () => {
    const t = buildSeasonSales({ ...base, view: "customers", lines });
    expect(t.rows).toEqual([
      { customer: "Beth Books", email: null, qty: 6, value: 80, skus: 2, url: "https://f/customers/c2" },
      { customer: "Acme Judaica", email: "a@x.com", qty: 2, value: 20, skus: 1, url: "https://f/customers/c1" },
    ]);
    expect(t.totals).toEqual({ qty: 8, value: 100 });
  });

  it("lines view: SKU × store, sorted by store, with last bought date", () => {
    const t = buildSeasonSales({ ...base, view: "lines", lines, books: ["tj"] });
    expect(t.rows.map((r) => [r.customer, r.sku, r.lastBought])).toEqual([
      ["Acme Judaica", "STBN01", "2026-08-01"],
      ["Beth Books", "STBN01", "2026-09-01"],
      ["Beth Books", "SLPBN01", "2026-08-01"],
    ]);
    expect(t.title).toBe("Rosh Hashanah 2026 sales 2026-04-01 to 2026-09-30 (Torah Judaica)");
  });

  it("says so when nothing sold", () => {
    const t = buildSeasonSales({ ...base, view: "skus", lines: [] });
    expect(t.rows).toEqual([]);
    expect(t.warnings).toEqual(["No sales of this season's products in that window.", GROSS]);
  });
});

describe("season sales exclusions", () => {
  it("leaves out $0 lines and test/placeholder accounts, and says so", () => {
    const t = buildSeasonSales({
      ...base,
      view: "skus",
      customers: new Map([...base.customers, ["c9", { name: "PLEASE CHECK ITEMS 111", email: null }]]),
      lines: [
        line({}),
        line({ qty: "4", lineTotal: "0" }),
        line({ customerId: "c9", qty: "3", lineTotal: "45" }),
      ],
    });
    expect(t.totals).toEqual({ qty: 2, value: 20, lines: 1 });
    expect(t.warnings).toEqual([
      "1 $0 line (unfulfilled pre-orders / no-charge) left out.",
      "Test/placeholder accounts left out (PLEASE CHECK ITEMS 111): 1 lines, $45.00.",
      GROSS,
    ]);
  });

  it("recognises the prod placeholder/test accounts but not real stores", () => {
    for (const n of ["PLEASE CHECK ITEMS 111", "test order", "test123", "Joshua dropshipping test", "ZZ TEST — Inbox Integration"]) {
      expect(isPlaceholderCustomer(n)).toBe(true);
    }
    for (const n of ["Bais Hasforim", "Testament Books", "Contest Judaica", "Lazzaro Gifts"]) {
      expect(isPlaceholderCustomer(n)).toBe(false);
    }
  });
});

describe("salesWindow", () => {
  it("never reaches past today (future-dated invoices are QBO placeholders)", () => {
    expect(salesWindow("2026-04-01", "2030-01-01", NOW)).toEqual({ from: "2026-04-01", to: "2026-10-15" });
    expect(salesWindow(null, null, NOW)).toEqual({ from: null, to: "2026-10-15" });
    expect(salesWindow("2026-04-01", "2026-09-30", NOW)).toEqual({ from: "2026-04-01", to: "2026-09-30" });
  });
});

describe("season-sales / customer-history query schemas", () => {
  it("season-sales: needs a season, defaults view skus + both books, checks range", () => {
    expect(seasonSalesQuerySchema.safeParse({}).success).toBe(false);
    const ok = seasonSalesQuerySchema.safeParse({ seasonId: "s1" });
    expect(ok.success && [ok.data.view, ok.data.book]).toEqual(["skus", "both"]);
    expect(seasonSalesQuerySchema.safeParse({ seasonId: "s1", view: "pivot" }).success).toBe(false);
    expect(seasonSalesQuerySchema.safeParse({ seasonId: "s1", from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
  });

  it("customer-history: needs a customer, optional real dates", () => {
    expect(customerHistoryQuerySchema.safeParse({}).success).toBe(false);
    expect(customerHistoryQuerySchema.safeParse({ customerId: "c1" }).success).toBe(true);
    expect(customerHistoryQuerySchema.safeParse({ customerId: "c1", from: "2026-02-31" }).success).toBe(false);
  });
});
