// ext-actions tests — the WRITE side of the finance queue cards. We mock the
// existing action fns + db so we can assert:
//   - dispatch routes (type,action) → the correct existing fn with (id, userId)
//   - actor email → finance userId resolution (found / not-found fallback)
//   - schema: missing actorEmail → 400, disallowed (type,action) → 400/blocked

import { beforeEach, describe, expect, it, vi } from "vitest";

const releaseHold = vi.hoisted(() => vi.fn());
const placeOnHold = vi.hoisted(() => vi.fn());
const cancelHoldOrder = vi.hoisted(() => vi.fn());
const dismissOrderReview = vi.hoisted(() => vi.fn());
const approveProposalAndEnqueue = vi.hoisted(() => vi.fn());
const rejectProposal = vi.hoisted(() => vi.fn());
const userRows = vi.hoisted(() => ({ value: [] as Array<{ id: string }> }));

vi.mock("../../modules/orders/hold-actions.js", () => ({
  releaseHold,
  placeOnHold,
  cancelHoldOrder,
  dismissOrderReview,
}));
vi.mock("../../modules/ai-agent/proposal-store.js", () => ({
  approveProposalAndEnqueue,
  rejectProposal,
}));

// db.select().from().where().limit() → userRows.value (the actor lookup).
vi.mock("../../db/index.js", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(userRows.value));
  return { db: chain };
});

import {
  dispatchTaskCardAction,
  resolveFinanceUserId,
  paramsSchema,
  bodySchema,
  isAllowedAction,
} from "./ext-actions.js";

beforeEach(() => {
  vi.clearAllMocks();
  releaseHold.mockResolvedValue({ ok: true });
  placeOnHold.mockResolvedValue({ ok: true });
  cancelHoldOrder.mockResolvedValue({ ok: true, shopifyCancelled: true, qboVoided: false, note: "" });
  dismissOrderReview.mockResolvedValue({ ok: true });
  approveProposalAndEnqueue.mockResolvedValue({ ok: true });
  rejectProposal.mockResolvedValue({ ok: true });
  userRows.value = [];
});

describe("dispatchTaskCardAction — routing", () => {
  it("hold/good-to-send → releaseHold(id, userId)", async () => {
    const r = await dispatchTaskCardAction("hold", "ord-1", "good-to-send", "user-7");
    expect(releaseHold).toHaveBeenCalledWith("ord-1", "user-7");
    expect(r).toEqual({ status: 200, body: { ok: true } });
  });

  it("hold/cancel → cancelHoldOrder, returns the full result", async () => {
    await dispatchTaskCardAction("hold", "ord-1", "cancel", "user-7");
    expect(cancelHoldOrder).toHaveBeenCalledWith("ord-1", "user-7");
  });

  it("overdue_review/place-on-hold → placeOnHold", async () => {
    await dispatchTaskCardAction("overdue_review", "ord-2", "place-on-hold", null);
    expect(placeOnHold).toHaveBeenCalledWith("ord-2", null);
  });

  it("overdue_review/dismiss → dismissOrderReview", async () => {
    await dispatchTaskCardAction("overdue_review", "ord-2", "dismiss", "u");
    expect(dismissOrderReview).toHaveBeenCalledWith("ord-2", "u");
  });

  it("ai_proposal/approve → approveProposalAndEnqueue", async () => {
    await dispatchTaskCardAction("ai_proposal", "prop-1", "approve", "u");
    expect(approveProposalAndEnqueue).toHaveBeenCalledWith("prop-1", "u");
  });

  it("ai_proposal/reject → rejectProposal (tolerates null actor)", async () => {
    await dispatchTaskCardAction("ai_proposal", "prop-1", "reject", null);
    expect(rejectProposal).toHaveBeenCalledWith("prop-1", null);
  });
});

describe("dispatchTaskCardAction — error mapping", () => {
  it("not_found → 404", async () => {
    releaseHold.mockResolvedValue({ ok: false, reason: "not_found" });
    const r = await dispatchTaskCardAction("hold", "x", "good-to-send", "u");
    expect(r.status).toBe(404);
  });

  it("conflict reason → 409", async () => {
    placeOnHold.mockResolvedValue({ ok: false, reason: "already_on_hold" });
    const r = await dispatchTaskCardAction("overdue_review", "x", "place-on-hold", "u");
    expect(r.status).toBe(409);
  });

  it("shopify_cancel_failed → 502 with a HUMAN error + the machine code", async () => {
    cancelHoldOrder.mockResolvedValue({ ok: false, reason: "shopify_cancel_failed" });
    const r = await dispatchTaskCardAction("hold", "x", "cancel", "u");
    expect(r.status).toBe(502);
    // `error` is now human-readable copy (relayed verbatim by the board); the raw
    // code lives in `code`.
    expect((r.body as { error: string }).error).toMatch(/cancel it manually/i);
    expect((r.body as { code: string }).code).toBe("shopify_cancel_failed");
  });

  it("proposal wrong_status → 409 carries the code + status", async () => {
    approveProposalAndEnqueue.mockResolvedValue({ ok: false, reason: "wrong_status", status: "executed" });
    const r = await dispatchTaskCardAction("ai_proposal", "p", "approve", "u");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "wrong_status", status: "executed" });
    expect((r.body as { error: string }).error).toBeTruthy();
  });
});

describe("resolveFinanceUserId", () => {
  it("returns the finance user id on an email match", async () => {
    userRows.value = [{ id: "user-42" }];
    expect(await resolveFinanceUserId("Boss@Feldart.com")).toBe("user-42");
  });

  it("returns null when no finance user matches", async () => {
    userRows.value = [];
    expect(await resolveFinanceUserId("nobody@example.com")).toBeNull();
  });

  it("returns null for a blank email", async () => {
    expect(await resolveFinanceUserId("   ")).toBeNull();
  });
});

describe("validation schemas + ALLOWED gate", () => {
  it("rejects a body missing actorEmail", () => {
    expect(bodySchema.safeParse({}).success).toBe(false);
    expect(bodySchema.safeParse({ actorTeamMemberId: "tm-1" }).success).toBe(false);
  });

  it("accepts actorEmail with optional teamMemberId", () => {
    expect(bodySchema.safeParse({ actorEmail: "a@b.com" }).success).toBe(true);
    expect(
      bodySchema.safeParse({ actorEmail: "a@b.com", actorTeamMemberId: "tm-1" }).success,
    ).toBe(true);
  });

  it("rejects a link-only card type (chase/rma not in params enum)", () => {
    expect(paramsSchema.safeParse({ type: "chase", id: "c", action: "x" }).success).toBe(false);
    expect(paramsSchema.safeParse({ type: "rma", id: "r", action: "x" }).success).toBe(false);
  });

  it("isAllowedAction gates actions per type", () => {
    expect(isAllowedAction("hold", "good-to-send")).toBe(true);
    expect(isAllowedAction("hold", "dismiss")).toBe(false);
    expect(isAllowedAction("overdue_review", "place-on-hold")).toBe(true);
    expect(isAllowedAction("ai_proposal", "approve")).toBe(true);
    expect(isAllowedAction("ai_proposal", "cancel")).toBe(false);
  });
});
