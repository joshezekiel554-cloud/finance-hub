import { describe, expect, it } from "vitest";
import { buildMoneySummary, type InvoiceAggRow, type PaymentAggRow } from "./money.js";

// The dashboard "Money" section and the hub's Finance panel both read one
// summary: per book (Feldart / TJ / total) → overdue, current due (open but
// not yet past due), due in the next 7 days, received in the last 30 days.
// SQL does the grouping; this shapes it, fills missing books with zeros and
// keeps money as 2-dp strings.

const NOW = new Date("2026-09-14T17:00:00.000Z");

describe("buildMoneySummary", () => {
  it("shapes per-book rows and sums a total row (received total includes unallocated)", () => {
    const invoiceRows: InvoiceAggRow[] = [
      { origin: "feldart", overdueAmount: "312840.10", overdueInvoices: 71, overdueCustomers: 68, currentDueAmount: "148220.55", currentDueInvoices: 124, dueNext7Amount: "38410.00", dueNext7Invoices: 19 },
      { origin: "tj", overdueAmount: "84684.32", overdueInvoices: 21, overdueCustomers: 19, currentDueAmount: "22905.00", currentDueInvoices: 18, dueNext7Amount: "6120.00", dueNext7Invoices: 4 },
    ];
    const paymentRow: PaymentAggRow = { feldart: "96530.40", tj: "11240.00", unallocated: "1000.00", total: "108770.40", count: 121 };

    const s = buildMoneySummary({ invoiceRows, paymentRow, invoicesSyncedAt: new Date("2026-09-14T15:12:00.000Z"), paymentsSyncedAt: null, now: NOW });

    expect(s.feldart.overdue).toEqual({ amount: "312840.10", invoices: 71, customers: 68 });
    expect(s.feldart.currentDue).toEqual({ amount: "148220.55", invoices: 124 });
    expect(s.feldart.dueNext7).toEqual({ amount: "38410.00", invoices: 19 });
    expect(s.feldart.received30).toEqual({ amount: "96530.40" });
    expect(s.tj.received30).toEqual({ amount: "11240.00" });
    expect(s.total.overdue).toEqual({ amount: "397524.42", invoices: 92, customers: 87 });
    expect(s.total.currentDue).toEqual({ amount: "171125.55", invoices: 142 });
    expect(s.total.received30).toEqual({ amount: "108770.40", payments: 121, unallocated: "1000.00" });
    expect(s.syncedAt).toEqual({ invoices: "2026-09-14T15:12:00.000Z", payments: null });
    expect(s.generatedAt).toBe(NOW.toISOString());
    expect(s.windowDays).toBe(30);
  });

  it("fills a missing book with zeros", () => {
    const s = buildMoneySummary({
      invoiceRows: [{ origin: "feldart", overdueAmount: "10.00", overdueInvoices: 1, overdueCustomers: 1, currentDueAmount: "0.00", currentDueInvoices: 0, dueNext7Amount: "0.00", dueNext7Invoices: 0 }],
      paymentRow: null,
      invoicesSyncedAt: null,
      paymentsSyncedAt: null,
      now: NOW,
    });
    expect(s.tj.overdue).toEqual({ amount: "0.00", invoices: 0, customers: 0 });
    expect(s.tj.received30).toEqual({ amount: "0.00" });
    expect(s.total.received30).toEqual({ amount: "0.00", payments: 0, unallocated: "0.00" });
    expect(s.total.overdue.amount).toBe("10.00");
  });
});
