import { beforeEach, describe, expect, it, vi } from "vitest";

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
    driveFolderId: null,
    createdViaReceipt: false,
    originalEmail: null,
    parsedConfidence: null,
    notes: null,
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

  it("sets DocNumber to rmaNumber for damage RMAs", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "DC-20260504-120000", returnType: "damage" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect(payload.DocNumber).toBe("DC-20260504-120000");
  });

  it("omits DocNumber for non-damage RMAs (let QBO autogen)", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ returnType: "seasonal" }),
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

  it("sets CustomerMemo to 'RMA {rmaNumber}'", async () => {
    await buildAndPushCreditMemo({
      rma: makeRma({ rmaNumber: "DC-20260504-120000" }),
      items: [makeItem()],
      shippingDeduction: null,
      restockingFee: null,
    });
    const payload = getLastPayload();
    expect((payload.CustomerMemo as { value: string }).value).toBe(
      "RMA DC-20260504-120000",
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
});
