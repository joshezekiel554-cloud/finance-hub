// Chat-proposal shaping tests: entity derivation, dangerous flagging,
// the proposal row contract (drafted immediately, source chat, scanId
// carries the conversation id).

import { describe, expect, it } from "vitest";
import {
  createChatProposal,
  deriveEntity,
  isDangerousAction,
  summarizeAction,
  validateEntityRefs,
} from "./chat-proposals.js";

describe("deriveEntity", () => {
  it("prefers invoice > task > customer > rma > chat fallback", () => {
    expect(deriveEntity("t", { invoiceId: "i1", customerId: "c1" })).toEqual({
      entityType: "invoice",
      entityId: "i1",
    });
    expect(deriveEntity("t", { taskId: "t1" })).toEqual({
      entityType: "task",
      entityId: "t1",
    });
    expect(deriveEntity("t", { customerId: "c1" })).toEqual({
      entityType: "customer",
      entityId: "c1",
    });
    expect(deriveEntity("create_admin_notification", {})).toEqual({
      entityType: "chat",
      entityId: "create_admin_notification",
    });
  });
});

describe("isDangerousAction", () => {
  it("flags only paid_void dispute transitions", () => {
    expect(
      isDangerousAction("dispute_transition", { action: "paid_void" }),
    ).toBe(true);
    expect(
      isDangerousAction("dispute_transition", { action: "claims_paid" }),
    ).toBe(false);
    expect(isDangerousAction("send_chase_email", {})).toBe(false);
  });
});

describe("createChatProposal", () => {
  it("inserts a drafted, chat-sourced proposal carrying the conversation id", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const fixed = new Date("2026-06-11T12:00:00Z");
    const result = await createChatProposal(
      {
        tool: "create_task",
        args: { title: "Ring Shmuel", customerId: "cust1" },
        userId: "user1",
        conversationId: "conv240000000000000000001",
      },
      { insert: async (row) => void inserted.push(row as never), now: () => fixed },
    );

    expect(result.proposalId).toHaveLength(24);
    expect(result.dangerous).toBe(false);
    const row = inserted[0]!;
    expect(row.category).toBe("chat_action");
    expect(row.source).toBe("chat");
    expect(row.status).toBe("drafted");
    expect(row.scanId).toBe("conv240000000000000000001");
    expect(row.entityType).toBe("customer");
    expect(row.entityId).toBe("cust1");
    expect(row.draftedAction).toEqual({
      tool: "create_task",
      args: { title: "Ring Shmuel", customerId: "cust1" },
    });
    expect((row.expiresAt as Date).getTime()).toBe(
      fixed.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    const summary = row.candidateSummary as Record<string, unknown>;
    expect(summary.tool).toBe("create_task");
    expect(summary.dangerous).toBe(false);
    expect(summary.requestedByUserId).toBe("user1");
  });

  it("marks the void transition dangerous end to end", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const result = await createChatProposal(
      {
        tool: "dispute_transition",
        args: { invoiceId: "inv1", action: "paid_void" },
        userId: "user1",
        conversationId: "conv2",
      },
      { insert: async (row) => void inserted.push(row as never) },
    );
    expect(result.dangerous).toBe(true);
    expect(
      (inserted[0]!.candidateSummary as Record<string, unknown>).dangerous,
    ).toBe(true);
    expect(inserted[0]!.entityType).toBe("invoice");
  });
});

describe("summarizeAction", () => {
  it("builds a compact human line from notable args", () => {
    const s = summarizeAction("set_hold_status", {
      customerId: "c1",
      targetState: "hold",
    });
    expect(s).toContain("set hold status");
    expect(s).toContain("targetState=hold");
  });
});

describe("validateEntityRefs", () => {
  it("rejects an invented customerId with a corrective message", async () => {
    const result = await validateEntityRefs(
      { customerId: "gifts-by-gilda", subject: "x" },
      { customerId: async () => false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"gifts-by-gilda" does not exist');
      expect(result.error).toContain("Never invent or guess ids");
    }
  });

  it("passes when every referenced entity exists", async () => {
    const result = await validateEntityRefs(
      { customerId: "real1", invoiceId: "real2" },
      { customerId: async () => true, invoiceId: async () => true },
    );
    expect(result).toEqual({ ok: true });
  });

  it("ignores args that are not entity refs or not strings", async () => {
    const result = await validateEntityRefs(
      { subject: "hello", attachStatement: true, customerId: 42 as unknown },
      { customerId: async () => false },
    );
    expect(result).toEqual({ ok: true });
  });
});
