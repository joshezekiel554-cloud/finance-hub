// Pins the most dangerous path for Feldart AI (hub) proposals: the in-app
// approve endpoint must refuse a via:"hub" row and must NOT enqueue it —
// only the hub Confirm card (by the member who asked) may run it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: 0,
  enqueued: 0,
}));

vi.mock("../lib/auth.js", () => ({
  requireAuth: vi.fn(async () => ({ id: "u-shaya", email: "info@feldartcollection.co.uk" })),
}));

vi.mock("../../db/index.js", () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const k of ["from", "where", "orderBy", "innerJoin", "leftJoin", "groupBy"]) c[k] = () => c;
    c.limit = async () => (state.row ? [state.row] : []);
    c.then = (resolve: (v: unknown) => unknown) => resolve(state.row ? [state.row] : []);
    return c;
  };
  return {
    db: {
      select: () => chain(),
      update: () => ({ set: () => ({ where: async () => { state.updates += 1; return [{ affectedRows: 1 }]; } }) }),
      insert: () => ({ values: async () => undefined }),
      delete: () => ({ where: async () => undefined }),
      transaction: async (fn: (tx: unknown) => unknown) => fn({ update: () => ({ set: () => ({ where: async () => { state.updates += 1; } }) }), insert: () => ({ values: async () => undefined }) }),
    },
  };
});

vi.mock("../../jobs/queues.js", () => ({
  AUTOPILOT_EXECUTE_JOB: "autopilot-execute",
  AUTOPILOT_SCAN_JOB: "autopilot-scan",
  getQueues: () => ({
    autopilotExecute: { add: async () => { state.enqueued += 1; } },
    autopilotScan: { add: async () => ({ id: "j" }) },
  }),
}));

import autopilotRoute from "./autopilot.js";

async function app() {
  const a = Fastify();
  await a.register(autopilotRoute, { prefix: "/api/autopilot" });
  await a.ready();
  return a;
}

const hubRow = {
  id: "p_hub_1",
  category: "chat_action",
  status: "drafted",
  entityType: "customer",
  entityId: "c1",
  candidateSummary: { via: "hub", hubActor: "joshezekiel554@gmail.com", summary: "send chase email" },
  draftedAction: { tool: "send_chase_email", args: { customerId: "c1", tier: "HIGH", subject: "s", body: "b" } },
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
};

describe("autopilot routes refuse hub proposals", () => {
  beforeEach(() => {
    state.row = hubRow;
    state.updates = 0;
    state.enqueued = 0;
  });

  it("approve → 403 and nothing enqueued or updated (even with edited args)", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/autopilot/proposals/p_hub_1/approve",
      payload: { editedArgs: { customerId: "c1", tier: "HIGH", subject: "s", body: "rewritten" } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/Confirm card in Feldart AI/);
    expect(state.enqueued).toBe(0);
    expect(state.updates).toBe(0);
  });

  it("mark-executed, dismiss and snooze → 403 without writing", async () => {
    const a = await app();
    for (const [url, payload] of [
      ["/api/autopilot/proposals/p_hub_1/mark-executed", {}],
      ["/api/autopilot/proposals/p_hub_1/dismiss", {}],
      ["/api/autopilot/proposals/p_hub_1/snooze", { hours: 2 }],
    ] as const) {
      const res = await a.inject({ method: "POST", url, payload });
      expect(res.statusCode, url).toBe(403);
    }
    expect(state.updates).toBe(0);
    expect(state.enqueued).toBe(0);
  });

  it("a normal (non-hub) proposal still approves and enqueues", async () => {
    state.row = { ...hubRow, id: "p_scan", candidateSummary: { summary: "x" } };
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/api/autopilot/proposals/p_scan/approve", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(state.enqueued).toBe(1);
  });
});
