import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock for QboClient — mock findInvoicesForCustomer
// ---------------------------------------------------------------------------
const findInvoicesForCustomerMock = vi.hoisted(() => vi.fn());

vi.mock("../../integrations/qb/client.js", () => ({
  QboClient: vi.fn().mockImplementation(() => ({
    findInvoicesForCustomer: findInvoicesForCustomerMock,
  })),
  configFromEnv: vi.fn().mockReturnValue({
    clientId: "test",
    clientSecret: "test",
    redirectUri: "http://localhost",
    realmId: "123",
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import {
  lookupItemPriceForCustomer,
  findOriginalInvoiceForItem,
} from "./qbo-lookup.js";
import type { QboInvoice, QboInvoiceLine } from "../../integrations/qb/types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Makes a minimal SalesItemLineDetail line for an invoice.
 */
function makeSalesLine(
  itemId: string,
  unitPrice: number,
  qty: number,
): QboInvoiceLine {
  return {
    DetailType: "SalesItemLineDetail",
    Amount: unitPrice * qty,
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      UnitPrice: unitPrice,
      Qty: qty,
    },
  };
}

/**
 * Makes a percent-based DiscountLineDetail line.
 * The Amount is typically the negative discount dollar amount; QBO
 * sometimes sets it as a negative number or as the absolute value.
 * Our implementation uses Math.abs(line.Amount) / subtotal for the flat path,
 * so for percent-based the Amount field is less important.
 */
function makePercentDiscountLine(
  discountPercent: number,
  discountAmount: number,
): QboInvoiceLine {
  return {
    DetailType: "DiscountLineDetail",
    Amount: -Math.abs(discountAmount),
    DiscountLineDetail: {
      PercentBased: true,
      DiscountPercent: discountPercent,
    },
  };
}

/**
 * Makes a flat-dollar DiscountLineDetail line.
 * QBO puts the discount as a negative Amount on this line.
 */
function makeFlatDiscountLine(discountAmount: number): QboInvoiceLine {
  return {
    DetailType: "DiscountLineDetail",
    Amount: -Math.abs(discountAmount),
    DiscountLineDetail: {
      PercentBased: false,
    },
  };
}

/**
 * Assembles a realistic QBO Invoice payload.
 */
function makeInvoice(
  id: string,
  docNumber: string,
  txnDate: string,
  lines: QboInvoiceLine[],
  customerId = "QB-CUST-1",
): QboInvoice {
  const totalAmt = lines.reduce((sum, l) => sum + (l.Amount ?? 0), 0);
  return {
    Id: id,
    DocNumber: docNumber,
    TxnDate: txnDate,
    TotalAmt: totalAmt,
    CustomerRef: { value: customerId },
    Line: lines,
  };
}

// ---------------------------------------------------------------------------
// lookupItemPriceForCustomer
// ---------------------------------------------------------------------------

describe("lookupItemPriceForCustomer", () => {
  beforeEach(() => {
    findInvoicesForCustomerMock.mockReset();
  });

  it("returns null when no invoice found for the customer", async () => {
    findInvoicesForCustomerMock.mockResolvedValue([]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).toBeNull();
  });

  it("returns null when customer has invoices but none contain the item", async () => {
    const invoice = makeInvoice("inv-1", "18001", "2025-03-10", [
      makeSalesLine("ITEM-OTHER", 20, 5),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).toBeNull();
  });

  it("returns unitPrice equal to listUnitPrice when invoice has no discount", async () => {
    const invoice = makeInvoice("inv-1", "18420", "2025-04-12", [
      makeSalesLine("ITEM-1", 25.0, 4),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).not.toBeNull();
    expect(result!.listUnitPrice).toBe("25.0000");
    expect(result!.unitPrice).toBe("25.0000");
    expect(result!.invoiceDiscountPct).toBeNull();
    expect(result!.originalInvoiceDocNumber).toBe("18420");
    expect(result!.originalInvoiceDate).toBe("2025-04-12");
  });

  it("applies 5% percent-based discount: unitPrice = listPrice × 0.95", async () => {
    // Subtotal = 25 × 4 = 100. Discount = 5% → $5 off.
    const invoice = makeInvoice("inv-2", "18421", "2025-05-01", [
      makeSalesLine("ITEM-1", 25.0, 4),
      makePercentDiscountLine(5, 5),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).not.toBeNull();
    expect(result!.listUnitPrice).toBe("25.0000");
    expect(result!.unitPrice).toBe("23.7500"); // 25 × 0.95
    expect(result!.invoiceDiscountPct).toBe("5.0000");
  });

  it("computes effective discount from flat $50 on $1000 subtotal → 5% → unitPrice = list × 0.95", async () => {
    // Two items: ITEM-1 at $50 × 10 = $500, ITEM-2 at $100 × 5 = $500. Total = $1000.
    // Flat discount of $50 → 5% effective.
    const invoice = makeInvoice("inv-3", "18422", "2025-06-01", [
      makeSalesLine("ITEM-1", 50.0, 10),
      makeSalesLine("ITEM-2", 100.0, 5),
      makeFlatDiscountLine(50),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).not.toBeNull();
    expect(result!.listUnitPrice).toBe("50.0000");
    // effective discount = 50/1000 × 100 = 5%
    // unitPrice = 50 × 0.95 = 47.5
    expect(result!.unitPrice).toBe("47.5000");
    expect(result!.invoiceDiscountPct).toBe("5.0000");
  });

  it("returns price for the matching item when invoice has multiple items", async () => {
    const invoice = makeInvoice("inv-4", "18423", "2025-07-15", [
      makeSalesLine("ITEM-1", 30.0, 2),
      makeSalesLine("ITEM-2", 80.0, 1),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-2",
    });
    expect(result).not.toBeNull();
    expect(result!.listUnitPrice).toBe("80.0000");
    expect(result!.unitPrice).toBe("80.0000");
  });

  it("picks the most recent invoice when multiple invoices contain the item", async () => {
    // Older invoice: ITEM-1 at $20
    const older = makeInvoice("inv-old", "17000", "2024-11-01", [
      makeSalesLine("ITEM-1", 20.0, 3),
    ]);
    // Newer invoice: ITEM-1 at $25
    const newer = makeInvoice("inv-new", "18500", "2025-09-10", [
      makeSalesLine("ITEM-1", 25.0, 3),
    ]);
    // findInvoicesForCustomer is expected to return sorted DESC, but our
    // implementation should also handle unsorted input gracefully.
    // Here we pass newer first (DESC order) as the client method promises.
    findInvoicesForCustomerMock.mockResolvedValue([newer, older]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).not.toBeNull();
    expect(result!.listUnitPrice).toBe("25.0000");
    expect(result!.originalInvoiceDocNumber).toBe("18500");
  });

  it("returns all required fields with correct string format", async () => {
    const invoice = makeInvoice("inv-5", "18424", "2026-01-20", [
      makeSalesLine("ITEM-1", 12.5, 8),
      makePercentDiscountLine(10, 10),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).not.toBeNull();
    // All numeric outputs should be 4-decimal strings
    expect(result!.listUnitPrice).toMatch(/^\d+\.\d{4}$/);
    expect(result!.unitPrice).toMatch(/^\d+\.\d{4}$/);
    expect(result!.invoiceDiscountPct).toMatch(/^\d+\.\d{4}$/);
    // Date must be YYYY-MM-DD
    expect(result!.originalInvoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles invoice with subtotal of zero gracefully (no discount computed)", async () => {
    // Zero-amount invoice — subtotal is 0, flat discount path would divide by 0.
    // In this case we treat discount as null (no discount info available).
    const invoice = makeInvoice("inv-zero", "18425", "2026-02-01", [
      makeSalesLine("ITEM-1", 0.0, 1),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).not.toBeNull();
    expect(result!.unitPrice).toBe("0.0000");
    expect(result!.invoiceDiscountPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findOriginalInvoiceForItem
// ---------------------------------------------------------------------------

describe("findOriginalInvoiceForItem", () => {
  beforeEach(() => {
    findInvoicesForCustomerMock.mockReset();
  });

  it("returns null when no invoice found", async () => {
    findInvoicesForCustomerMock.mockResolvedValue([]);
    const result = await findOriginalInvoiceForItem({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).toBeNull();
  });

  it("returns null when customer has invoices but none contain the item", async () => {
    const invoice = makeInvoice("inv-1", "18001", "2025-03-10", [
      makeSalesLine("ITEM-OTHER", 10, 2),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await findOriginalInvoiceForItem({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).toBeNull();
  });

  it("returns qboInvoiceId, docNumber, and txnDate for matching invoice", async () => {
    const invoice = makeInvoice("inv-ref-1", "18420", "2025-04-12", [
      makeSalesLine("ITEM-1", 25.0, 3),
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([invoice]);
    const result = await findOriginalInvoiceForItem({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result).not.toBeNull();
    expect(result!.qboInvoiceId).toBe("inv-ref-1");
    expect(result!.docNumber).toBe("18420");
    expect(result!.txnDate).toBe("2025-04-12");
  });

  it("returns the most recent matching invoice when multiple match", async () => {
    const older = makeInvoice("inv-old", "17000", "2024-06-01", [
      makeSalesLine("ITEM-1", 20.0, 1),
    ]);
    const newer = makeInvoice("inv-new", "18500", "2025-09-10", [
      makeSalesLine("ITEM-1", 25.0, 1),
    ]);
    // DESC order from client
    findInvoicesForCustomerMock.mockResolvedValue([newer, older]);
    const result = await findOriginalInvoiceForItem({
      qboCustomerId: "QB-CUST-1",
      qbItemId: "ITEM-1",
    });
    expect(result!.qboInvoiceId).toBe("inv-new");
    expect(result!.docNumber).toBe("18500");
  });
});
