import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock for app_settings loader — the CM builder reads
// rma_shipping_fee_item_id + rma_restocking_fee_item_id from settings
// at issue time. Test-only ids; the QBO mock doesn't validate them.
// ---------------------------------------------------------------------------
vi.mock("../statements/settings.js", () => ({
  loadAppSettings: vi.fn().mockResolvedValue({
    rma_shipping_fee_item_id: "test-shipping-item",
    rma_restocking_fee_item_id: "test-restocking-item",
  }),
}));

// ---------------------------------------------------------------------------
// Hoisted mock for QboClient — mock just the createCreditMemo method
// ---------------------------------------------------------------------------
const createCreditMemoMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    Id: "qbo-cm-42",
    DocNumber: "DC-20260504-120000",
  }),
);

vi.mock("../../integrations/qb/client.js", () => ({
  QboClient: vi.fn().mockImplementation(() => ({
    createCreditMemo: createCreditMemoMock,
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
  buildCreditMemoLineDescription,
  buildAndPushCreditMemo,
} from "./credit-memo-builder.js";
import type { RmaItem, Rma } from "../../db/schema/returns.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<RmaItem> = {}): RmaItem {
  return {
    id: "item-1",
    rmaId: "rma-1",
    position: 0,
    qbItemId: "qb-item-1",
    sku: "FELT-CAND-12",
    name: "Felt candle holder",
    quantity: "2.0000",
    listUnitPrice: "25.0000",
    unitPrice: "25.0000",
    invoiceDiscountPct: null,
    lineTotal: "50.00",
    classification: "damage",
    priorSeasonId: null,
    priorSeasonOverrideReason: null,
    reason: null,
    originalInvoiceDocNumber: null,
    originalInvoiceDate: null,
    receivedQuantity: null,
    createdAt: new Date("2026-05-01T10:00:00Z"),
    updatedAt: new Date("2026-05-01T10:00:00Z"),
    ...overrides,
  };
}

function makeRma(overrides: Partial<Rma> = {}): Rma {
  return {
    id: "rma-1",
    rmaNumber: "DC-20260504-120000",
    customerId: "cust-1",
    qbCustomerId: "QB-999",
    returnType: "damage",
    status: "approved",
    seasonId: null,
    totalValue: "50.00",
    eligibleAmount: null,
    returnPercentage: null,
    eligibilityDetails: null,
    thresholdOverridden: false,
    overrideReason: null,
    overrideByUserId: null,
    denialReason: null,
    denialPdfDriveId: null,
    qboCreditMemoId: null,
    creditMemoDocNumber: null,
    shippingDeductionAmount: null,
    restockingFeeAmount: null,
    extensivRef: null,
    extensivTxNumber: null,
    extensivExportGeneratedAt: null,
    trackingNumber: null,
    trackingCarrier: null,
    trackingSavedAt: null,
    driveFolderId: null,
    createdViaReceipt: false,
    originalEmail: null,
    parsedConfidence: null,
    notes: null,
    damagesNote: null,
    resolutionType: null,
    createdByUserId: "user-1",
    approvedByUserId: "user-1",
    approvedAt: new Date("2026-05-04T12:00:00Z"),
    sentToWarehouseAt: null,
    receivedAtWarehouseAt: null,
    completedAt: null,
    deniedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-05-04T10:00:00Z"),
    updatedAt: new Date("2026-05-04T12:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCreditMemoLineDescription
// ---------------------------------------------------------------------------

describe("buildCreditMemoLineDescription", () => {
  it("returns bare SKU — name when no invoice ref", () => {
    const desc = buildCreditMemoLineDescription(makeItem());
    expect(desc).toBe("FELT-CAND-12 — Felt candle holder");
  });

  it("appends invoice ref when originalInvoiceDocNumber present, no discount", () => {
    const desc = buildCreditMemoLineDescription(
      makeItem({
        originalInvoiceDocNumber: "18420",
        // Drizzle date() in MySQL infers as Date; use a real Date object
        originalInvoiceDate: new Date("2025-04-12T00:00:00Z"),
        invoiceDiscountPct: null,
      }),
    );
    expect(desc).toBe(
      "FELT-CAND-12 — Felt candle holder (orig. inv. 18420, 2025-04-12)",
    );
  });

  it("appends discount note when invoiceDiscountPct is non-zero", () => {
    const desc = buildCreditMemoLineDescription(
      makeItem({
        originalInvoiceDocNumber: "18420",
        originalInvoiceDate: new Date("2025-04-12T00:00:00Z"),
        invoiceDiscountPct: "5.0000",
      }),
    );
    expect(desc).toBe(
      "FELT-CAND-12 — Felt candle holder (orig. inv. 18420, 2025-04-12; 5% inv discount applied)",
    );
  });

  it("does NOT append discount note when invoiceDiscountPct is '0.0000'", () => {
    const desc = buildCreditMemoLineDescription(
      makeItem({
        originalInvoiceDocNumber: "18420",
        originalInvoiceDate: new Date("2025-04-12T00:00:00Z"),
        invoiceDiscountPct: "0.0000",
      }),
    );
    expect(desc).toBe(
      "FELT-CAND-12 — Felt candle holder (orig. inv. 18420, 2025-04-12)",
    );
  });

  it("formats Date object as yyyy-MM-dd for originalInvoiceDate", () => {
    // Drizzle date() infers as Date; this test exercises the Date → string path
    const desc = buildCreditMemoLineDescription(
      makeItem({
        originalInvoiceDocNumber: "18420",
        originalInvoiceDate: new Date("2025-04-12T00:00:00Z"),
        invoiceDiscountPct: null,
      }),
    );
    expect(desc).toBe(
      "FELT-CAND-12 — Felt candle holder (orig. inv. 18420, 2025-04-12)",
    );
  });

  it("omits invoice date from parens when originalInvoiceDate is null but doc number present", () => {
    const desc = buildCreditMemoLineDescription(
      makeItem({
        originalInvoiceDocNumber: "18420",
        originalInvoiceDate: null,
        invoiceDiscountPct: null,
      }),
    );
    expect(desc).toBe("FELT-CAND-12 — Felt candle holder (orig. inv. 18420)");
  });

  it("falls back to bare SKU — name when invoiceDocNumber is null", () => {
    const desc = buildCreditMemoLineDescription(
      makeItem({
        originalInvoiceDocNumber: null,
        originalInvoiceDate: new Date("2025-04-12T00:00:00Z"),
        invoiceDiscountPct: "5.0000",
      }),
    );
    // no invoice ref → no parens, even if date/discount data exists
    expect(desc).toBe("FELT-CAND-12 — Felt candle holder");
  });
});

// ---------------------------------------------------------------------------
// buildAndPushCreditMemo
// ---------------------------------------------------------------------------

describe("buildAndPushCreditMemo", () => {
  beforeEach(() => {
    createCreditMemoMock.mockClear();
    createCreditMemoMock.mockResolvedValue({
      Id: "qbo-cm-42",
      DocNumber: "DC-20260504-120000",
    });
  });

  it("returns qboCreditMemoId and docNumber from QBO response", async () => {
    const result = await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    expect(result.qboCreditMemoId).toBe("qbo-cm-42");
    expect(result.docNumber).toBe("DC-20260504-120000");
  });

  // Helper: extracts the payload passed to createCreditMemo after a call
  function getLastPayload<T = Record<string, unknown>>(): T {
    return createCreditMemoMock.mock.calls[createCreditMemoMock.mock.calls.length - 1]![0] as T;
  }

  it("sets DocNumber to rmaNumber for damage RMAs (DC#####)", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "DC38771", returnType: "damage" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect(payload.DocNumber).toBe("DC38771");
  });

  it("appends 'CR' to rmaNumber for seasonal RMAs", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "18743", returnType: "seasonal" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect(payload.DocNumber).toBe("18743CR");
  });

  it("appends 'CR' to rmaNumber for non-seasonal RMAs", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "WH-12345", returnType: "non_seasonal" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect(payload.DocNumber).toBe("WH-12345CR");
  });

  it("omits DocNumber when seasonal/non_seasonal rmaNumber is missing", async () => {
    // Defence-in-depth: if rmaNumber is somehow null on a non-damage
    // RMA, fall back to QBO autogen rather than producing the literal
    // string "nullCR" as the DocNumber.
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: null, returnType: "seasonal" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect(payload.DocNumber).toBeUndefined();
  });

  it("sets CustomerRef.value from rma.qbCustomerId", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ qbCustomerId: "QB-999" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect((payload.CustomerRef as { value: string }).value).toBe("QB-999");
  });

  it("sets CustomerMemo to 'damaged items' for damage RMAs", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "DC38771", returnType: "damage" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect((payload.CustomerMemo as { value: string }).value).toBe(
      "damaged items",
    );
  });

  it("sets CustomerMemo to 'seasonal returns' for seasonal RMAs", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "18743", returnType: "seasonal" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect((payload.CustomerMemo as { value: string }).value).toBe(
      "seasonal returns",
    );
  });

  it("sets CustomerMemo to 'returns' for non-seasonal RMAs", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "WH-99", returnType: "non_seasonal" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect((payload.CustomerMemo as { value: string }).value).toBe(
      "returns",
    );
  });

  it("builds one SalesItemLineDetail line per item", async () => {
    const items = [
      makeItem({ id: "item-1", sku: "A", lineTotal: "10.00", unitPrice: "10.0000", quantity: "1.0000" }),
      makeItem({ id: "item-2", sku: "B", lineTotal: "20.00", unitPrice: "10.0000", quantity: "2.0000" }),
    ];
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items,
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload<{ Line: unknown[] }>();
    expect(payload.Line).toHaveLength(2);
  });

  it("uses receivedQuantity over quantity when present", async () => {
    const item = makeItem({
      quantity: "3.0000",
      receivedQuantity: "2.0000",
      unitPrice: "25.0000",
      lineTotal: "50.00",
    });
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [item],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload<{
      Line: Array<{ SalesItemLineDetail: { Qty: number } }>;
    }>();
    expect(payload.Line[0]!.SalesItemLineDetail.Qty).toBe(2);
  });

  it("recomputes Amount as Qty * UnitPrice when receivedQuantity overrides", async () => {
    // Original line: qty 3 @ $25 = $75 stored in lineTotal.
    // Warehouse received only 2 → credit must be 2 * $25 = $50, not $75.
    const item = makeItem({
      quantity: "3.0000",
      receivedQuantity: "2.0000",
      unitPrice: "25.0000",
      lineTotal: "75.00", // <-- stale post-discount total for original qty
    });
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [item],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload<{
      Line: Array<{
        Amount: number;
        SalesItemLineDetail: { Qty: number; UnitPrice: number };
      }>;
    }>();
    const line = payload.Line[0]!;
    expect(line.SalesItemLineDetail.Qty).toBe(2);
    expect(line.SalesItemLineDetail.UnitPrice).toBe(25);
    expect(line.Amount).toBe(50);
    // The invariant QBO will check: Amount === Qty * UnitPrice
    expect(line.Amount).toBe(
      line.SalesItemLineDetail.Qty * line.SalesItemLineDetail.UnitPrice,
    );
  });

  it("rounds Amount to 2dp when qty * unitPrice produces a long fraction", async () => {
    // 3 * 0.3333 = 0.9999 → rounds to 1.00.
    const item = makeItem({
      quantity: "3.0000",
      receivedQuantity: null,
      unitPrice: "0.3333",
      lineTotal: "0.9999",
    });
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [item],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload<{
      Line: Array<{ Amount: number }>;
    }>();
    expect(payload.Line[0]!.Amount).toBe(1);
  });

  it("adds a negative shipping line when shippingDeduction > 0", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: "8.50",
      restockingFee: null,
    });
    const payload = getLastPayload<{
      Line: Array<{ Amount: number; Description: string }>;
    }>();
    // 1 item line + 1 shipping line
    expect(payload.Line).toHaveLength(2);
    const shippingLine = payload.Line.find(
      (l) => l.Description === "Return shipping costs deducted",
    );
    expect(shippingLine).toBeDefined();
    expect(shippingLine!.Amount).toBe(-8.5);
  });

  it("adds a negative restocking-fee line when restockingFee > 0", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: "15.00",
    });
    const payload = getLastPayload<{
      Line: Array<{ Amount: number; Description: string }>;
    }>();
    expect(payload.Line).toHaveLength(2);
    const feeLineItem = payload.Line.find((l) => l.Description === "Restocking fee");
    expect(feeLineItem).toBeDefined();
    expect(feeLineItem!.Amount).toBe(-15);
  });

  it("adds both deduction lines when both are present", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: "5.00",
      restockingFee: "10.00",
    });
    const payload = getLastPayload<{ Line: unknown[] }>();
    // 1 item + 2 deductions
    expect(payload.Line).toHaveLength(3);
  });

  it("does NOT add deduction lines when values are '0' or null", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: "0.00",
      restockingFee: null,
    });
    const payload = getLastPayload<{ Line: unknown[] }>();
    expect(payload.Line).toHaveLength(1);
  });

  it("item lines have correct Amount, DetailType, and ItemRef", async () => {
    const item = makeItem({
      qbItemId: "qb-item-5",
      lineTotal: "75.00",
      unitPrice: "25.0000",
      quantity: "3.0000",
      receivedQuantity: null,
    });
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [item],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload<{
      Line: Array<{
        DetailType: string;
        Amount: number;
        SalesItemLineDetail: { ItemRef: { value: string }; Qty: number; UnitPrice: number };
      }>;
    }>();
    const line = payload.Line[0]!;
    expect(line.DetailType).toBe("SalesItemLineDetail");
    expect(line.Amount).toBe(75);
    expect(line.SalesItemLineDetail.ItemRef.value).toBe("qb-item-5");
    expect(line.SalesItemLineDetail.Qty).toBe(3);
    expect(line.SalesItemLineDetail.UnitPrice).toBe(25);
  });

  // -------------------------------------------------------------------------
  // Sales-tax behavior. In Feldart's QBO realm (US Automated Sales Tax) a
  // line with NO explicit TaxCodeRef defaults to taxable — omitting the
  // txn-level TxnTaxDetail is NOT enough to make a CM non-taxable. Each line
  // must carry TaxCodeRef = "TAX"/"NON" explicitly, mirroring the /process-
  // return path and the b2b sender.
  // -------------------------------------------------------------------------
  type TaxLine = {
    Description: string;
    SalesItemLineDetail: { TaxCodeRef?: { value: string } };
  };

  it("marks every line NON when applyTax is false", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: "5.00",
      restockingFee: "10.00",
      applyTax: false,
      taxCodeRef: null,
    });
    const payload = getLastPayload<{
      Line: TaxLine[];
      TxnTaxDetail?: unknown;
    }>();
    for (const line of payload.Line) {
      expect(line.SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
    }
    expect(payload.TxnTaxDetail).toBeUndefined();
  });

  it("defaults to NON lines when applyTax is omitted", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload<{
      Line: TaxLine[];
      TxnTaxDetail?: unknown;
    }>();
    expect(payload.Line[0]!.SalesItemLineDetail.TaxCodeRef).toEqual({
      value: "NON",
    });
    expect(payload.TxnTaxDetail).toBeUndefined();
  });

  it("marks every line TAX and sets TxnTaxCodeRef when applyTax is true", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma(),
      items: [makeItem()],
      shippingDeduction: "5.00",
      restockingFee: "10.00",
      applyTax: true,
      taxCodeRef: "qb-tax-7",
    });
    const payload = getLastPayload<{
      Line: TaxLine[];
      TxnTaxDetail?: { TxnTaxCodeRef: { value: string } };
    }>();
    for (const line of payload.Line) {
      expect(line.SalesItemLineDetail.TaxCodeRef).toEqual({ value: "TAX" });
    }
    expect(payload.TxnTaxDetail).toEqual({
      TxnTaxCodeRef: { value: "qb-tax-7" },
    });
  });
});
