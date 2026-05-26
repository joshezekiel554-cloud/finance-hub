import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, updateCalls } = vi.hoisted(() => {
  type UpdateCall = {
    table: unknown;
    set: Record<string, unknown> | null;
    where: unknown;
  };
  const updateCalls: UpdateCall[] = [];

  const update = (table: unknown) => {
    const call: UpdateCall = { table, set: null, where: null };
    updateCalls.push(call);
    return {
      set: (values: Record<string, unknown>) => {
        call.set = values;
        return {
          where: (cond: unknown) => {
            call.where = cond;
            return Promise.resolve([{ affectedRows: 0 }]);
          },
        };
      },
    };
  };

  return { updateCalls, mockDb: { update } };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

import { autoActionPriorInbounds } from "./auto-action-emails.js";
import { emailLog } from "../../db/schema/crm.js";

beforeEach(() => {
  updateCalls.length = 0;
});

describe("autoActionPriorInbounds", () => {
  it("issues a single UPDATE on email_log with actionedAt=sentAt and actionedByUserId=null", async () => {
    const sentAt = new Date("2026-05-26T10:00:00.000Z");
    await autoActionPriorInbounds({
      customerId: "cust_abc",
      threadId: "thread_xyz",
      sentAt,
    });

    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0]!;
    expect(call.table).toBe(emailLog);
    expect(call.set).toEqual({
      actionedAt: sentAt,
      actionedByUserId: null,
    });
    expect(call.where).toBeDefined();
  });

  it("no-ops (returns 0, no UPDATE) when threadId is null/empty", async () => {
    const n = await autoActionPriorInbounds({
      customerId: "cust_abc",
      threadId: null,
      sentAt: new Date(),
    });
    expect(n).toBe(0);
    expect(updateCalls).toHaveLength(0);

    const n2 = await autoActionPriorInbounds({
      customerId: "cust_abc",
      threadId: "",
      sentAt: new Date(),
    });
    expect(n2).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("no-ops when customerId is null/empty", async () => {
    const n = await autoActionPriorInbounds({
      customerId: null,
      threadId: "thread_xyz",
      sentAt: new Date(),
    });
    expect(n).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });
});
