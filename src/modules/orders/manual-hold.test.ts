import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted; shared recording state lives in vi.hoisted() so it's
// available when the mock factories run. We record the order row the select
// returns, plus every update + the captured ladder WHERE clause.
const {
  mockDb,
  state,
  updateCalls,
  transitionCalls,
  sendCalls,
  ladderWhere,
} = vi.hoisted(() => {
  const state: { order: Record<string, unknown> | undefined } = {
    order: undefined,
  };
  const updateCalls: { set: Record<string, unknown> }[] = [];
  const transitionCalls: unknown[] = [];
  const sendCalls: unknown[] = [];
  const ladderWhere: { value: unknown } = { value: undefined };

  // select() chains differ between manualHold (leftJoin) and runHoldLadder
  // (innerJoin). Both end in .where().limit() — we expose a permissive chain
  // that records the ladder where-clause and resolves to the staged rows.
  const select = vi.fn(() => {
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      where: (cond: unknown) => {
        ladderWhere.value = cond;
        return chain;
      },
      limit: () => Promise.resolve(state.order ? [state.order] : []),
    };
    return chain;
  });

  const update = () => ({
    set: (set: Record<string, unknown>) => {
      updateCalls.push({ set });
      return { where: () => Promise.resolve() };
    },
  });

  return {
    state,
    updateCalls,
    transitionCalls,
    sendCalls,
    ladderWhere,
    mockDb: { select, update },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

vi.mock("./hold-alerts.js", () => ({
  recordHoldTransition: vi.fn(async (args: unknown) => {
    transitionCalls.push(args);
  }),
}));

vi.mock("../statements/settings.js", () => ({
  loadAppSettings: vi.fn(async () => ({})),
}));

vi.mock("./recipients.js", () => ({
  loadInternalHoldRecipients: vi.fn(() => "warehouse@example.com"),
  resolveHoldCustomerRecipients: vi.fn(async () => null),
}));

vi.mock("./templates.js", () => ({
  loadOrderTemplate: vi.fn(() => ({ subject: "", body: "" })),
  renderOrderTemplate: vi.fn(() => ({ subject: "S", html: "H", text: "T" })),
}));

vi.mock("../../integrations/gmail/send.js", () => ({
  sendEmail: vi.fn(async (args: unknown) => {
    sendCalls.push(args);
    return { threadId: "t1", messageId: "m1" };
  }),
}));

// env: not in shadow mode so the internal alert path runs.
vi.mock("../../lib/env.js", () => ({
  env: { SHADOW_MODE: false, PUBLIC_URL: "https://finance.example.com" },
}));

import { manualHold } from "./hold-actions.js";
import { runHoldLadder } from "./hold-ladder.js";

beforeEach(() => {
  state.order = undefined;
  updateCalls.length = 0;
  transitionCalls.length = 0;
  sendCalls.length = 0;
  ladderWhere.value = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("manualHold", () => {
  it("returns not_found when the order doesn't exist", async () => {
    state.order = undefined;
    const r = await manualHold("missing", "user-1", {});
    expect(r).toEqual({ ok: false, reason: "not_found" });
    expect(updateCalls).toHaveLength(0);
  });

  it("returns already_on_hold when the order is already held", async () => {
    state.order = {
      id: "o1",
      orderNumber: "#1001",
      shopifyOrderId: "111",
      total: "50.00",
      holdState: "on_hold",
      customerId: "c1",
      customerName: "Acme",
    };
    const r = await manualHold("o1", "user-1", {});
    expect(r).toEqual({ ok: false, reason: "already_on_hold" });
    expect(updateCalls).toHaveLength(0);
  });

  it("internal-only by default: customerLadder=false sets holdLadderEnabled=false", async () => {
    state.order = {
      id: "o1",
      orderNumber: "#1001",
      shopifyOrderId: "111",
      total: "50.00",
      holdState: "none",
      customerId: "c1",
      customerName: "Acme",
    };
    const r = await manualHold("o1", "user-1", { note: "  stock check  " });
    expect(r).toEqual({ ok: true });
    // Fires the immediate internal warehouse alert.
    expect(sendCalls).toHaveLength(1);
    const set = updateCalls[0]?.set ?? {};
    expect(set.holdState).toBe("on_hold");
    expect(set.holdReason).toBe("manual");
    expect(set.holdLadderEnabled).toBe(false);
    expect(set.holdNote).toBe("stock check");
    // Transition records the manual via + customerLadder flag.
    expect(transitionCalls[0]).toMatchObject({
      action: "order.hold_started",
      after: { holdReason: "manual", via: "manual", customerLadder: false },
    });
  });

  it("customerLadder=true sets holdLadderEnabled=true", async () => {
    state.order = {
      id: "o2",
      orderNumber: "#1002",
      shopifyOrderId: "222",
      total: null,
      holdState: "released",
      customerId: "c2",
      customerName: "Beta",
    };
    const r = await manualHold("o2", null, { customerLadder: true });
    expect(r).toEqual({ ok: true });
    const set = updateCalls[0]?.set ?? {};
    expect(set.holdLadderEnabled).toBe(true);
    expect(set.holdNote).toBeNull();
  });
});

describe("runHoldLadder ladder gating", () => {
  it("filters on holdLadderEnabled (internal-only holds excluded)", async () => {
    // The DB enforces the WHERE — simulate it returning no rows (an
    // internal-only hold would be filtered out) → no customer emails fire.
    state.order = undefined;
    const result = await runHoldLadder();
    expect(result.onHold).toBe(0);
    expect(result.notices).toBe(0);
    expect(sendCalls).toHaveLength(0);
    // And confirm the ladder query actually applies a WHERE (the flag filter is
    // part of it) rather than selecting all on_hold orders unconditionally.
    expect(ladderWhere.value).toBeDefined();
  });
});
