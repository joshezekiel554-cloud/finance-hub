import { describe, expect, it } from "vitest";
import { bucketFor, buildAgedDebtors } from "./aged-debtors.js";
import { buildOpenInvoices } from "./open-invoices.js";
import { buildReturnsReport, dateRangeBounds } from "./returns.js";
import { dayOf, daysPastDue, shapeRows, sumKeys } from "./table.js";
import { likePattern } from "./customers.js";

const NOW = new Date("2026-10-15T12:00:00Z");

describe("table helpers", () => {
  it("normalises Date and string DATE values to YYYY-MM-DD", () => {
    expect(dayOf(new Date("2026-03-04T00:00:00Z"))).toBe("2026-03-04");
    expect(dayOf("2026-03-04")).toBe("2026-03-04");
    expect(dayOf(null)).toBeNull();
    expect(dayOf("garbage")).toBeNull();
  });

  it("counts days past due (positive = overdue)", () => {
    expect(daysPastDue("2026-10-14", "2026-10-15")).toBe(1);
    expect(daysPastDue("2026-10-15", "2026-10-15")).toBe(0);
    expect(daysPastDue("2026-11-14", "2026-10-15")).toBe(-30);
    expect(daysPastDue(null, "2026-10-15")).toBeNull();
  });

  it("shapes rows to the declared columns and sums numeric keys", () => {
    const cols = [
      { key: "a", label: "A", type: "text" as const },
      { key: "n", label: "N", type: "number" as const },
    ];
    const rows = shapeRows(cols, [{ a: "x", n: 1.105, extra: 9 }, { n: 2.2 }]);
    expect(rows).toEqual([{ a: "x", n: 1.105 }, { a: null, n: 2.2 }]);
    expect(sumKeys(rows, ["n"])).toEqual({ n: 3.31 });
  });

  it("escapes LIKE wildcards in the customer search", () => {
    expect(likePattern("50%_off")).toBe("%50\\%\\_off%");
  });
});

describe("aged debtors", () => {
  it("buckets by days past due", () => {
    expect(bucketFor(null)).toBe("current");
    expect(bucketFor(0)).toBe("current");
    expect(bucketFor(-5)).toBe("current");
    expect(bucketFor(1)).toBe("d1_30");
    expect(bucketFor(30)).toBe("d1_30");
    expect(bucketFor(31)).toBe("d31_60");
    expect(bucketFor(90)).toBe("d61_90");
    expect(bucketFor(91)).toBe("d90plus");
  });

  const customers = [
    { id: "c1", name: "Acme Judaica", email: "a@x.com", holdStatus: "hold" },
    { id: "c2", name: "Beth Books", email: null, holdStatus: "active" },
  ];

  it("builds one row per customer × book, worst 90+ first, with credits netted", () => {
    const t = buildAgedDebtors({
      invoices: [
        { customerId: "c2", origin: "feldart", issueDate: "2026-09-01", dueDate: "2026-10-01", balance: "100.00" },
        { customerId: "c1", origin: "feldart", issueDate: "2026-05-01", dueDate: "2026-06-01", balance: "250.50" },
        { customerId: "c1", origin: "feldart", issueDate: "2026-10-01", dueDate: "2026-10-31", balance: "50" },
        { customerId: "c1", origin: "tj", issueDate: "2025-01-01", dueDate: "2025-02-01", balance: "10" },
      ],
      credits: [
        { customerId: "c1", origin: "feldart", balance: "20" },
        { customerId: "c9", origin: "feldart", balance: "999" }, // owes nothing → ignored
      ],
      customers,
      books: ["feldart"],
      now: NOW,
      customerUrl: (id) => `https://f/customers/${id}`,
    });
    expect(t.rows).toHaveLength(2); // TJ row excluded by book scope
    expect(t.rows[0]).toMatchObject({
      customer: "Acme Judaica",
      book: "Feldart",
      current: 50,
      d90plus: 250.5,
      total: 300.5,
      credits: -20,
      net: 280.5,
      oldestDue: "2026-06-01",
      invoices: 2,
      hold: "On hold",
      url: "https://f/customers/c1",
    });
    expect(t.rows[1]).toMatchObject({ customer: "Beth Books", d1_30: 100, email: null });
    expect(t.totals).toMatchObject({ total: 400.5, credits: -20, net: 380.5, invoices: 3 });
    expect(t.columns.find((c) => c.key === "net")).toMatchObject({ type: "money", currency: "USD" });
    expect(t.warnings).toEqual([]);
    expect(t.title).toBe("Aged debtors (Feldart) — 2026-10-15");
  });

  it("warns about future-dated (placeholder) invoices", () => {
    const t = buildAgedDebtors({
      invoices: [
        { customerId: "c1", origin: "feldart", issueDate: "2030-01-01", dueDate: "2030-01-31", balance: "5" },
      ],
      credits: [],
      customers,
      books: ["feldart", "tj"],
      now: NOW,
      customerUrl: (id) => id,
    });
    expect(t.rows[0]).toMatchObject({ current: 5 });
    expect(t.warnings[0]).toMatch(/1 open invoice is dated in the future/);
  });
});

describe("open invoices", () => {
  it("lists invoices then unapplied credits per book with a net balance total", () => {
    const t = buildOpenInvoices({
      customerName: "Acme Judaica",
      invoices: [
        { origin: "feldart", docNumber: "1002", issueDate: new Date("2026-09-20T00:00:00Z"), dueDate: new Date("2026-10-20T00:00:00Z"), total: "80", balance: "80", disputeState: null },
        { origin: "feldart", docNumber: "1001", issueDate: "2026-08-01", dueDate: "2026-09-01", total: "100", balance: "60", disputeState: null },
        { origin: "tj", docNumber: "2001", issueDate: "2025-01-01", dueDate: "2025-02-01", total: "40", balance: "40", disputeState: "verifying" },
        { origin: "feldart", docNumber: "1000", issueDate: "2026-01-01", dueDate: "2026-02-01", total: "10", balance: "0", disputeState: null },
      ],
      credits: [{ origin: "feldart", docNumber: "CM-1", txnDate: "2026-09-05", total: "25", balance: "15" }],
      books: ["feldart", "tj"],
      now: NOW,
    });
    expect(t.rows.map((r) => r.docNumber)).toEqual(["1001", "1002", "CM-1", "2001"]);
    expect(t.rows[0]).toMatchObject({ type: "Invoice", daysOverdue: 44, balance: 60, status: "Overdue" });
    expect(t.rows[1]).toMatchObject({ date: "2026-09-20", daysOverdue: 0, status: "Not yet due" });
    expect(t.rows[2]).toMatchObject({ type: "Credit", balance: -15, dueDate: null, daysOverdue: null });
    expect(t.rows[3]).toMatchObject({ book: "Torah Judaica", status: "Verifying payment" });
    expect(t.totals).toEqual({ balance: 165 });
    expect(t.title).toBe("Acme Judaica — open invoices — 2026-10-15");
  });

  it("warns when there is nothing open", () => {
    const t = buildOpenInvoices({ customerName: "X", invoices: [], credits: [], books: ["feldart"], now: NOW });
    expect(t.rows).toEqual([]);
    expect(t.warnings).toEqual(["No open invoices or unapplied credits."]);
  });
});

describe("returns report", () => {
  const rmas = [
    {
      id: "r1abcdefgh",
      rmaNumber: "DC00123",
      customerName: "Acme Judaica",
      status: "completed",
      returnType: "damage",
      resolutionType: "credit",
      totalValue: "45.50",
      creditMemoDocNumber: "CM-9",
      createdAt: new Date("2026-10-01T09:00:00Z"),
      completedAt: new Date("2026-10-05T09:00:00Z"),
    },
    {
      id: "r2abcdefgh",
      rmaNumber: null,
      customerName: "Beth Books",
      status: "approved",
      returnType: "seasonal",
      resolutionType: null,
      totalValue: "0",
      creditMemoDocNumber: null,
      createdAt: new Date("2026-10-02T09:00:00Z"),
      completedAt: null,
    },
  ];
  const lines = [
    { rmaId: "r1abcdefgh", sku: "SK1", name: "Cup", quantity: "2", receivedQuantity: "2", unitPrice: "10", lineTotal: "20", classification: "damage", reason: "cracked", originalInvoiceDocNumber: "1001", originalInvoiceDate: new Date("2026-08-01T00:00:00Z") },
    { rmaId: "r1abcdefgh", sku: "SK2", name: "Plate", quantity: "1", receivedQuantity: null, unitPrice: "25.5", lineTotal: "25.5", classification: "seasonal_prior", reason: null, originalInvoiceDocNumber: null, originalInvoiceDate: null },
  ];

  it("one row per RMA with line counts and value totals", () => {
    const t = buildReturnsReport({
      view: "rmas", from: "2026-10-01", to: "2026-10-31", customerName: null, rmas, lines, now: NOW,
      rmaUrl: (id) => `https://f/returns/${id}`,
    });
    expect(t.rows[0]).toMatchObject({
      rma: "DC00123", created: "2026-10-01", status: "Completed", type: "Damage",
      resolution: "Credit", lines: 2, qty: 3, value: 45.5, creditMemo: "CM-9", completed: "2026-10-05",
    });
    expect(t.rows[1]).toMatchObject({ rma: null, lines: 0, qty: 0, resolution: null });
    expect(t.totals).toEqual({ lines: 2, qty: 3, value: 45.5 });
    expect(t.title).toBe("Returns 2026-10-01 to 2026-10-31");
  });

  it("one row per line in the lines view", () => {
    const t = buildReturnsReport({
      view: "lines", from: "2026-10-01", to: "2026-10-31", customerName: "Acme Judaica", rmas, lines, now: NOW,
      rmaUrl: (id) => id,
    });
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toMatchObject({ sku: "SK1", qty: 2, received: 2, invoiceDate: "2026-08-01", classification: "Damage" });
    expect(t.rows[1]).toMatchObject({ received: null, classification: "Seasonal (prior)" });
    expect(t.totals).toEqual({ qty: 3, received: 2, lineTotal: 45.5 });
    expect(t.title).toBe("Returns 2026-10-01 to 2026-10-31 — Acme Judaica");
  });

  it("treats the `to` date as inclusive", () => {
    const { start, endExclusive } = dateRangeBounds("2026-10-01", "2026-10-31");
    expect(start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(endExclusive.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
