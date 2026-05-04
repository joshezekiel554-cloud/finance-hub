import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, insertCalls } = vi.hoisted(() => {
  type InsertCall = { table: unknown; values: unknown };
  const insertCalls: InsertCall[] = [];

  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return Promise.resolve();
    },
  });

  const tx = { insert };

  const transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
  const select = vi.fn();

  return {
    insertCalls,
    mockDb: { insert, transaction, select },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const recordActivityMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue("activity-1"),
);
vi.mock("../crm/activity-ingester.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createRma } from "./rma-service.js";
import { rmas } from "../../db/schema/returns.js";

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
