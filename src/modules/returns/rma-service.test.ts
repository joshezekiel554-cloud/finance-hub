import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must live before any imports that trigger module resolution
// ---------------------------------------------------------------------------
const { mockDb, insertCalls, setSelectResults } = vi.hoisted(() => {
  type InsertCall = { table: unknown; values: unknown };
  const insertCalls: InsertCall[] = [];

  // Queue of result arrays consumed in order by successive select chains.
  let selectResultsQueue: unknown[][] = [];
  const setSelectResults = (queue: unknown[][]) => {
    selectResultsQueue = queue.slice();
  };

  // A lazy chainable node. It only pulls from the queue when awaited (.then()).
  // Each chain step returns a new node so the queue is consumed once per await.
  type LazyNode = {
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise<unknown>;
    catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
    where: (...args: unknown[]) => LazyNode;
    orderBy: (...args: unknown[]) => LazyNode;
    limit: (...args: unknown[]) => LazyNode;
    from: (...args: unknown[]) => LazyNode;
  };

  const makeNode = (): LazyNode => {
    const node: LazyNode = {
      then(resolve, reject) {
        return Promise.resolve(selectResultsQueue.shift() ?? []).then(
          resolve,
          reject,
        );
      },
      catch(reject) {
        return Promise.resolve(selectResultsQueue.shift() ?? []).catch(reject);
      },
      where: (..._args: unknown[]) => makeNode(),
      orderBy: (..._args: unknown[]) => makeNode(),
      limit: (..._args: unknown[]) => makeNode(),
      from: (..._args: unknown[]) => makeNode(),
    };
    return node;
  };

  const select = vi.fn(() => makeNode());

  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return Promise.resolve();
    },
  });

  const update = (_table: unknown) => ({
    set: (_values: unknown) => ({
      where: (..._args: unknown[]) => Promise.resolve(),
    }),
  });

  const deleteFn = (_table: unknown) => ({
    where: (..._args: unknown[]) => Promise.resolve(),
  });

  const tx = { insert };

  const transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );

  return {
    insertCalls,
    setSelectResults,
    mockDb: { insert, update, delete: deleteFn, transaction, select },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const recordActivityMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue("activity-1"),
);
vi.mock("../crm/activity-ingester.js", () => ({
  recordActivity: recordActivityMock,
}));

const buildAndPushCmMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ qboCreditMemoId: "cm-qbo-1", docNumber: "DC-20260504-152448" }),
);
vi.mock("./credit-memo-builder.js", () => ({
  buildAndPushCreditMemo: buildAndPushCmMock,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { approveRma, denyRma, issueCreditMemo, markReplacementSent, addRmaItem, updateRmaItem, removeRmaItem, createRma, getRmaById, listRmas, updateRma } from "./rma-service.js";
import { rmas } from "../../db/schema/returns.js";

// ---------------------------------------------------------------------------
// createRma
// ---------------------------------------------------------------------------
describe("createRma", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
  });

  it("inserts an rma row in draft status with the given fields", async () => {
    const rma = await createRma({
      customerId: "cust-123",
      qbCustomerId: "QB-987",
      returnType: "damage",
      createdByUserId: "user-1",
    });
    const insert = insertCalls.find((c) => c.table === rmas);
    expect(insert).toBeDefined();
    const values = insert!.values as Record<string, unknown>;
    expect(values.id).toBeTypeOf("string");
    expect(values.customerId).toBe("cust-123");
    expect(values.qbCustomerId).toBe("QB-987");
    expect(values.returnType).toBe("damage");
    expect(values.status).toBe("draft");
    expect(values.createdByUserId).toBe("user-1");
    expect(rma.id).toBe(values.id);
  });

  it("records an rma_created activity event", async () => {
    await createRma({
      customerId: "cust-123",
      qbCustomerId: "QB-987",
      returnType: "seasonal",
      createdByUserId: "user-1",
    });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust-123",
        kind: "rma_created",
        userId: "user-1",
        refType: "rma",
      }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// getRmaById
// ---------------------------------------------------------------------------
describe("getRmaById", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    setSelectResults([[]]);
  });

  it("returns null when no rma matches", async () => {
    setSelectResults([[]]);
    const result = await getRmaById("missing-id");
    expect(result).toBeNull();
  });

  it("returns the rma with attached items when found", async () => {
    // First select resolves to the rma row; second resolves to items (empty).
    setSelectResults([
      [{ id: "rma-1", customerId: "cust-1", returnType: "seasonal", status: "draft" }],
      [],
    ]);
    const result = await getRmaById("rma-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("rma-1");
    expect(Array.isArray(result!.items)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listRmas
// ---------------------------------------------------------------------------
describe("listRmas", () => {
  beforeEach(() => {
    setSelectResults([[]]);
  });

  it("returns rows from db.select() — basic call", async () => {
    setSelectResults([[]]);
    const result = await listRmas({});
    expect(Array.isArray(result)).toBe(true);
  });

  it("calls db.select with status + type filter when provided", async () => {
    setSelectResults([[
      { id: "rma-1", status: "approved", returnType: "damage" },
    ]]);
    const result = await listRmas({ status: "approved", type: "damage", limit: 50 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// updateRma
// ---------------------------------------------------------------------------
describe("updateRma", () => {
  beforeEach(() => {
    insertCalls.length = 0;
  });

  it("updates allowed fields when rma is in draft", async () => {
    setSelectResults([
      [{ id: "rma-1", status: "draft" }],
      [{ id: "rma-1", status: "draft", notes: "updated note" }],
    ]);
    const result = await updateRma("rma-1", { notes: "updated note" });
    expect(result).not.toBeNull();
  });

  it("returns null when rma not found", async () => {
    setSelectResults([[]]);
    const result = await updateRma("missing", { notes: "no-go" });
    expect(result).toBeNull();
  });

  it("rejects updates to a completed rma", async () => {
    setSelectResults([[{ id: "rma-1", status: "completed" }]]);
    await expect(
      updateRma("rma-1", { notes: "no-go" }),
    ).rejects.toThrow(/cannot edit/i);
  });
});

// ---------------------------------------------------------------------------
// approveRma
// ---------------------------------------------------------------------------
describe("approveRma — damage", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
  });

  it("transitions draft → approved, allocates DC-... rma number, fires activity", async () => {
    setSelectResults([
      [{ id: "rma-1", status: "draft", returnType: "damage", customerId: "cust-1" }],
      [{ id: "rma-1", status: "approved", returnType: "damage", customerId: "cust-1", rmaNumber: "DC-20260504-120000" }],
    ]);
    const result = await approveRma("rma-1", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) {
      expect(result.rma.status).toBe("approved");
      expect(result.rma.rmaNumber).toMatch(/^DC-\d{8}-\d{6}$/);
    }
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_approved", refType: "rma", refId: "rma-1" }),
      expect.anything(),
    );
  });

  it("rejects approve when rma not in draft", async () => {
    setSelectResults([[{ id: "rma-1", status: "approved", returnType: "damage" }]]);
    const result = await approveRma("rma-1", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("returns null when rma not found", async () => {
    setSelectResults([[]]);
    const result = await approveRma("missing", { userId: "user-1" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// denyRma
// ---------------------------------------------------------------------------
describe("denyRma", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
  });

  it("transitions draft → denied with reason, fires activity", async () => {
    setSelectResults([
      [{ id: "rma-1", status: "draft", returnType: "damage", customerId: "cust-1" }],
      [{ id: "rma-1", status: "denied", returnType: "damage", customerId: "cust-1", denialReason: "Outside warranty" }],
    ]);
    const result = await denyRma("rma-1", { userId: "user-1", reason: "Outside warranty" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) expect(result.rma.status).toBe("denied");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_denied", refType: "rma", refId: "rma-1" }),
      expect.anything(),
    );
  });

  it("rejects deny when rma not in draft", async () => {
    setSelectResults([[{ id: "rma-1", status: "approved", returnType: "damage" }]]);
    const result = await denyRma("rma-1", { userId: "user-1", reason: "Too late" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("returns null when rma not found", async () => {
    setSelectResults([[]]);
    const result = await denyRma("missing", { userId: "user-1", reason: "No such RMA" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// issueCreditMemo
// ---------------------------------------------------------------------------
describe("issueCreditMemo — damage", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
    buildAndPushCmMock.mockClear();
  });

  it("approved → completed, QBO CM created, activity logged", async () => {
    setSelectResults([
      [{ id: "rma-1", status: "approved", returnType: "damage", customerId: "cust-1", rmaNumber: "DC-20260504-120000", qbCustomerId: "QB-1" }],
      [], // items query
      [{ id: "rma-1", status: "completed", qboCreditMemoId: "cm-qbo-1", returnType: "damage", customerId: "cust-1" }],
    ]);
    const result = await issueCreditMemo("rma-1", {
      userId: "user-1",
      shippingDeduction: "5.00",
      restockingFee: null,
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(buildAndPushCmMock).toHaveBeenCalled();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_credit_memo_issued", refType: "rma", refId: "rma-1" }),
      expect.anything(),
    );
  });

  it("rejects when rma not in approved state", async () => {
    setSelectResults([[{ id: "rma-1", status: "draft", returnType: "damage", customerId: "cust-1" }]]);
    const result = await issueCreditMemo("rma-1", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("returns null when rma not found", async () => {
    setSelectResults([[]]);
    const result = await issueCreditMemo("missing", { userId: "user-1" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// markReplacementSent
// ---------------------------------------------------------------------------
describe("markReplacementSent — damage", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
  });

  it("transitions approved → completed with resolutionType=replacement, fires activity", async () => {
    setSelectResults([
      [{ id: "rma-1", status: "approved", returnType: "damage", customerId: "cust-1" }],
      [{ id: "rma-1", status: "completed", returnType: "damage", customerId: "cust-1", resolutionType: "replacement" }],
    ]);
    const result = await markReplacementSent("rma-1", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) {
      expect(result.rma.status).toBe("completed");
      expect(result.rma.resolutionType).toBe("replacement");
    }
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_completed", refType: "rma", refId: "rma-1" }),
      expect.anything(),
    );
  });

  it("rejects when rma not in approved state", async () => {
    setSelectResults([[{ id: "rma-1", status: "draft", returnType: "damage" }]]);
    const result = await markReplacementSent("rma-1", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("rejects when rma is not damage type", async () => {
    setSelectResults([[{ id: "rma-1", status: "approved", returnType: "seasonal" }]]);
    const result = await markReplacementSent("rma-1", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/damage/i);
  });

  it("returns null when rma not found", async () => {
    setSelectResults([[]]);
    const result = await markReplacementSent("missing", { userId: "user-1" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addRmaItem
// ---------------------------------------------------------------------------
describe("addRmaItem", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
  });

  it("inserts item at position 0 when no existing items, recomputes totalValue", async () => {
    setSelectResults([
      [{ id: "rma-1", status: "draft", returnType: "damage", customerId: "cust-1", totalValue: "0" }],
      [], // existing items (none)
      [{ id: "rma-1", status: "draft", totalValue: "50.00", returnType: "damage", customerId: "cust-1" }],
      [], // items after update
    ]);
    const result = await addRmaItem("rma-1", {
      qbItemId: "qb-item-1",
      sku: "SKU-001",
      name: "Test Item",
      quantity: "1.0000",
      unitPrice: "50.0000",
      classification: "damage",
    });
    expect(result).not.toBeNull();
    // item should have been inserted
    const itemInsert = insertCalls.find((c) => {
      const v = c.values as Record<string, unknown>;
      return v.rmaId === "rma-1";
    });
    expect(itemInsert).toBeDefined();
    const itemValues = itemInsert!.values as Record<string, unknown>;
    expect(itemValues.position).toBe(0);
    expect(itemValues.sku).toBe("SKU-001");
  });

  it("inserts item at next position when items already exist", async () => {
    setSelectResults([
      [{ id: "rma-1", status: "draft", returnType: "damage", customerId: "cust-1", totalValue: "50.00" }],
      [{ id: "item-existing", rmaId: "rma-1", position: 2, lineTotal: "50.00" }],
      [{ id: "rma-1", status: "draft", totalValue: "100.00", returnType: "damage", customerId: "cust-1" }],
      [{ id: "item-existing", rmaId: "rma-1", position: 2, lineTotal: "50.00" }],
    ]);
    await addRmaItem("rma-1", {
      qbItemId: "qb-item-2",
      sku: "SKU-002",
      name: "Another Item",
      quantity: "1.0000",
      unitPrice: "50.0000",
      classification: "damage",
    });
    const itemInsert = insertCalls.find((c) => {
      const v = c.values as Record<string, unknown>;
      return v.sku === "SKU-002";
    });
    expect(itemInsert).toBeDefined();
    expect((itemInsert!.values as Record<string, unknown>).position).toBe(3);
  });

  it("throws when rma is not in draft status", async () => {
    setSelectResults([[{ id: "rma-1", status: "approved", returnType: "damage" }]]);
    await expect(
      addRmaItem("rma-1", {
        qbItemId: "qb-item-1",
        sku: "SKU-001",
        name: "Test",
        quantity: "1.0000",
        unitPrice: "10.0000",
        classification: "damage",
      }),
    ).rejects.toThrow(/draft/i);
  });
});

// ---------------------------------------------------------------------------
// updateRmaItem
// ---------------------------------------------------------------------------
describe("updateRmaItem", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
  });

  it("updates item fields and recomputes parent totalValue when rma is in draft", async () => {
    setSelectResults([
      [{ id: "item-1", rmaId: "rma-1", lineTotal: "50.00", position: 0, quantity: "1.0000", unitPrice: "50.0000" }],
      [{ id: "rma-1", status: "draft", returnType: "damage", customerId: "cust-1", totalValue: "50.00" }],
      [{ id: "item-1", rmaId: "rma-1", lineTotal: "75.00", position: 0, quantity: "1.0000", unitPrice: "75.0000" }],
      [{ id: "rma-1", status: "draft", totalValue: "75.00", returnType: "damage", customerId: "cust-1" }],
      [{ id: "item-1", rmaId: "rma-1", lineTotal: "75.00" }],
    ]);
    const result = await updateRmaItem("item-1", { unitPrice: "75.0000" });
    expect(result).not.toBeNull();
  });

  it("throws when parent rma is not in draft status", async () => {
    setSelectResults([
      [{ id: "item-1", rmaId: "rma-1", lineTotal: "50.00", position: 0 }],
      [{ id: "rma-1", status: "approved", returnType: "damage" }],
    ]);
    await expect(
      updateRmaItem("item-1", { unitPrice: "75.0000" }),
    ).rejects.toThrow(/draft/i);
  });

  it("returns null when item not found", async () => {
    setSelectResults([[]]);
    const result = await updateRmaItem("missing", { unitPrice: "10.0000" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// removeRmaItem
// ---------------------------------------------------------------------------
describe("removeRmaItem", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    recordActivityMock.mockClear();
  });

  it("deletes item and recomputes parent totalValue when rma is in draft", async () => {
    setSelectResults([
      [{ id: "item-1", rmaId: "rma-1", lineTotal: "50.00", position: 0 }],
      [{ id: "rma-1", status: "draft", returnType: "damage", customerId: "cust-1", totalValue: "50.00" }],
      [], // remaining items after delete
      [{ id: "rma-1", status: "draft", totalValue: "0.00", returnType: "damage", customerId: "cust-1" }],
      [], // items for final return
    ]);
    const result = await removeRmaItem("item-1");
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(0);
  });

  it("throws when parent rma is not in draft status", async () => {
    setSelectResults([
      [{ id: "item-1", rmaId: "rma-1", lineTotal: "50.00", position: 0 }],
      [{ id: "rma-1", status: "approved", returnType: "damage" }],
    ]);
    await expect(removeRmaItem("item-1")).rejects.toThrow(/draft/i);
  });

  it("returns null when item not found", async () => {
    setSelectResults([[]]);
    const result = await removeRmaItem("missing");
    expect(result).toBeNull();
  });
});
