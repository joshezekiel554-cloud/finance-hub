// rma-service-phase4.test.ts
// Tests for Phase 4 service additions:
//   - createRmaFromReceipt
//   - dismissExtensivReceipt
//   - confirmExtensivReceipt

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted db mock — must live before any import that loads the db module.
// ---------------------------------------------------------------------------
const {
  mockSelect,
  mockInsert,
  mockUpdate,
  resetMocks,
  setSelectQueue,
  mockTransaction,
} = vi.hoisted(() => {
  let selectQueue: unknown[][] = [];

  const setSelectQueue = (rows: unknown[][]) => {
    selectQueue = rows.slice();
  };
  const resetMocks = () => {
    selectQueue = [];
  };

  type LazyNode = {
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
    catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
    where: (...args: unknown[]) => LazyNode;
    orderBy: (...args: unknown[]) => LazyNode;
    limit: (...args: unknown[]) => LazyNode;
    from: (...args: unknown[]) => LazyNode;
    for: (...args: unknown[]) => LazyNode;
    leftJoin: (...args: unknown[]) => LazyNode;
    innerJoin: (...args: unknown[]) => LazyNode;
  };

  const makeNode = (): LazyNode => ({
    then(resolve, reject) {
      return Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(selectQueue.shift() ?? []).catch(reject);
    },
    where: () => makeNode(),
    orderBy: () => makeNode(),
    limit: () => makeNode(),
    from: () => makeNode(),
    // FOR UPDATE row lock — used by createRmaFromReceipt's claim check
    // and confirmExtensivReceipt. Mock just chains another node so the
    // existing select queue drives it.
    for: () => makeNode(),
    leftJoin: () => makeNode(),
    innerJoin: () => makeNode(),
  });

  const mockSelect = vi.fn(() => makeNode());
  const mockInsert = vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));
  const mockUpdate = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  }));

  // Transactional surface — service code that uses `db.transaction(async tx
  // => ...)` calls these the same way as the bare `db.*` methods. Reuse the
  // same mock fns so the existing select/update queues drive both paths.
  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ select: mockSelect, insert: mockInsert, update: mockUpdate }),
  );

  return { mockSelect, mockInsert, mockUpdate, resetMocks, setSelectQueue, mockTransaction };
});

vi.mock("~/db/index.js", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    transaction: mockTransaction,
  },
}));

vi.mock("~/db/schema/returns.js", () => ({
  rmas: { id: "id", customerId: "customer_id", status: "status" },
  rmaItems: { rmaId: "rma_id", id: "id", position: "position" },
  extensivReceipts: { id: "id", rmaId: "rma_id", matchKind: "match_kind" },
  seasons: {},
}));

vi.mock("~/db/schema/customers.js", () => ({
  customers: { id: "id", displayName: "display_name" },
}));

vi.mock("~/modules/crm/activity-ingester.js", () => ({
  recordActivity: vi.fn().mockResolvedValue("activity-id"),
}));

vi.mock("~/modules/returns/rma-state.js", () => ({
  validateTransition: vi.fn(() => ({ ok: true })),
}));

vi.mock("~/modules/returns/credit-memo-builder.js", () => ({
  buildAndPushCreditMemo: vi.fn(),
}));

vi.mock("~/modules/returns/eligibility.js", () => ({
  runEligibility: vi.fn(),
}));

vi.mock("~/modules/returns/eligibility-pdf.js", () => ({
  generateEligibilityPdf: vi.fn(),
}));

vi.mock("~/modules/returns/extensiv-export.js", () => ({
  buildExtensivExportFile: vi.fn(),
}));

import {
  createRmaFromReceipt,
  dismissExtensivReceipt,
  confirmExtensivReceipt,
} from "./rma-service.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRmaFromReceipt", () => {
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  it("creates an RMA in received state and links the receipt", async () => {
    const newRmaId = "rma-new-123";

    // Select queue:
    //   1. tx.select(extensiv_receipts).where(...).for("update") — claim
    //      check. Returns the receipt with all claim fields null so the
    //      service proceeds.
    //   2. Final tx.select(rmas) at the end.
    // The total is computed inline (no recompute select), so no items
    // query in the queue.
    setSelectQueue([
      [
        {
          id: "receipt-001",
          rmaId: null,
          confirmedAt: null,
          dismissedAt: null,
        },
      ],
      [
        {
          id: newRmaId,
          customerId: "cust-abc",
          status: "received",
          createdViaReceipt: true,
          totalValue: "25.00",
        },
      ],
    ]);

    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: insertValuesMock });
    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    mockUpdate.mockReturnValue({ set: updateSetMock });

    const result = await createRmaFromReceipt({
      receiptId: "receipt-001",
      customerId: "cust-abc",
      qbCustomerId: "qb-abc",
      returnType: "damage",
      items: [
        {
          id: "",
          rmaId: "",
          position: 0,
          qbItemId: "item-1",
          sku: "SKU-A",
          name: "Widget A",
          quantity: "2",
          unitPrice: "12.50",
          lineTotal: "25.00",
          classification: "damage",
          listUnitPrice: null,
          invoiceDiscountPct: null,
          reason: null,
          originalInvoiceDocNumber: null,
          originalInvoiceDate: null,
          receivedQuantity: "2",
          priorSeasonId: null,
          priorSeasonOverrideReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      userId: "user-xyz",
    });

    expect(result).toMatchObject({
      id: newRmaId,
      status: "received",
      createdViaReceipt: true,
    });

    // Two updates fire inside the tx: rmas.totalValue rollup + the
    // receipt link. The receipt link is the load-bearing assertion —
    // confirms the FOR UPDATE claim path actually links.
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ matchKind: "exact_tx_number" }),
    );
  });

  it("refuses to create an RMA when the receipt is already linked to another RMA", async () => {
    // Concurrency guard — operator's tab was stale; another tab already
    // claimed the receipt. Lock + null re-check should reject this with
    // a clear message rather than orphan a duplicate RMA.
    setSelectQueue([
      [
        {
          id: "receipt-001",
          rmaId: "rma-already-claimed",
          confirmedAt: null,
          dismissedAt: null,
        },
      ],
    ]);

    await expect(
      createRmaFromReceipt({
        receiptId: "receipt-001",
        customerId: "cust-abc",
        qbCustomerId: "qb-abc",
        returnType: "damage",
        items: [],
        userId: "user-xyz",
      }),
    ).rejects.toThrow(/already linked|refresh/i);
  });
});

describe("dismissExtensivReceipt", () => {
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  it("sets dismissedAt and dismissedByUserId", async () => {
    setSelectQueue([
      // exists check
      [{ id: "receipt-002" }],
    ]);

    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    mockUpdate.mockReturnValue({ set: updateSetMock });

    await dismissExtensivReceipt({ receiptId: "receipt-002", userId: "user-abc" });

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ dismissedByUserId: "user-abc" }),
    );
  });

  it("throws when receipt not found", async () => {
    setSelectQueue([
      // exists check — empty
      [],
    ]);

    await expect(
      dismissExtensivReceipt({ receiptId: "receipt-not-found", userId: "user-abc" }),
    ).rejects.toThrow("not found");
  });
});

describe("confirmExtensivReceipt", () => {
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  it("sets confirmedAt and returns receipt without advancing RMA when rmaId is null", async () => {
    setSelectQueue([
      // fetch receipt
      [{ id: "receipt-003", rmaId: null, confirmedAt: null }],
      // fetch updated receipt
      [{ id: "receipt-003", rmaId: null, confirmedAt: new Date() }],
    ]);

    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    mockUpdate.mockReturnValue({ set: updateSetMock });

    const result = await confirmExtensivReceipt({ receiptId: "receipt-003", userId: "user-abc" });

    expect(result.receipt).toBeDefined();
    expect(result.rma).toBeUndefined();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedByUserId: "user-abc" }),
    );
  });

  it("advances linked RMA to received when it is in sent_to_warehouse", async () => {
    const now = new Date();
    setSelectQueue([
      // fetch receipt (confirmExtensivReceipt: receiptRows query)
      [{ id: "receipt-004", rmaId: "rma-stw", confirmedAt: null }],
      // fetch updated receipt (after confirmedAt update)
      [{ id: "receipt-004", rmaId: "rma-stw", confirmedAt: now }],
      // fetch RMA for status check (inside confirmExtensivReceipt: rmaRows query)
      [{ id: "rma-stw", status: "sent_to_warehouse", customerId: "cust-stw", returnType: "damage" }],
      // manualMarkReceived: existing rma fetch
      [{ id: "rma-stw", status: "sent_to_warehouse", customerId: "cust-stw", returnType: "damage" }],
      // manualMarkReceived: updated rma select after db.update
      [{ id: "rma-stw", status: "received", customerId: "cust-stw", returnType: "damage" }],
    ]);

    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    mockUpdate.mockReturnValue({ set: updateSetMock });

    const result = await confirmExtensivReceipt({ receiptId: "receipt-004", userId: "user-xyz" });

    expect(result.receipt).toBeDefined();
    expect(result.rma).toBeDefined();
    expect(result.rma?.id).toBe("rma-stw");
  });

  it("throws when receipt not found", async () => {
    setSelectQueue([[]]); // empty

    await expect(
      confirmExtensivReceipt({ receiptId: "receipt-missing", userId: "user-abc" }),
    ).rejects.toThrow("not found");
  });
});
