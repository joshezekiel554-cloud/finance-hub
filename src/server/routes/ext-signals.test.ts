// GET /api/ext/signals — finance's money nudges for the hub panel. Only
// finance admins (ADMIN_EMAILS) may read them; everyone else gets 403 even
// with a valid hub service token.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const state = vi.hoisted(() => ({
  claims: null as { email: string; ops?: boolean } | null,
  loaderCalls: [] as Array<{ baseUrl: string }>,
  moneyFails: false,
}));

vi.mock("../../lib/env.js", async (orig) => {
  const actual = (await orig()) as { env: Record<string, unknown> };
  return {
    env: { ...actual.env, ADMIN_EMAILS: "josh@x.com,shaya@x.com", PUBLIC_URL: "https://finance.example/" },
  };
});

vi.mock("../lib/hub-service-auth.js", () => ({
  requireHubService: vi.fn((_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!state.claims) {
      reply.code(401).send({ error: "no token" });
      return null;
    }
    return state.claims;
  }),
  financeLinkSecret: vi.fn(() => "secret"),
}));

vi.mock("../../modules/hub-signals/finance-signals.js", () => ({
  loadFinanceSignals: vi.fn(async (ctx: { baseUrl: string }) => {
    state.loaderCalls.push({ baseUrl: ctx.baseUrl });
    return {
      signals: [{ key: "finance.promise-missed.c1.2026-11-14", kind: "promise-missed" }],
      errors: [],
    };
  }),
}));

vi.mock("./dashboard-money.js", () => ({
  getMoneySummaryCached: vi.fn(async () => {
    if (state.moneyFails) throw new Error("db down");
    return {
      currency: "USD",
      total: {
        overdue: { amount: "1234.50", invoices: 3, customers: 2 },
        currentDue: { amount: "0", invoices: 0 },
        dueNext7: { amount: "800", invoices: 1 },
        received30: { amount: "9999.99", payments: 4, unallocated: "0" },
      },
    };
  }),
}));

import { signalsRoute } from "./ext-tools.js";

let app: FastifyInstance;

beforeEach(async () => {
  state.claims = null;
  state.loaderCalls = [];
  state.moneyFails = false;
  app = Fastify();
  await app.register(signalsRoute, { prefix: "/api/ext" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/ext/signals", () => {
  it("401s without a hub token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ext/signals" });
    expect(res.statusCode).toBe(401);
  });

  it("403s for a staff member who isn't a finance admin", async () => {
    state.claims = { email: "sam@x.com", ops: true };
    const res = await app.inject({ method: "GET", url: "/api/ext/signals" });
    expect(res.statusCode).toBe(403);
    expect(state.loaderCalls).toHaveLength(0);
  });

  it("serves signals + the panel money summary to a finance admin", async () => {
    state.claims = { email: "Shaya@x.com" };
    const res = await app.inject({ method: "GET", url: "/api/ext/signals" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { signals: unknown[]; summary: unknown; errors: unknown[]; generatedAt: string };
    expect(body.signals).toHaveLength(1);
    expect(body.summary).toEqual({ overdue: { USD: 1234.5 }, dueThisWeek: { USD: 800 }, cashIn30d: { USD: 9999.99 } });
    expect(body.errors).toEqual([]);
    expect(typeof body.generatedAt).toBe("string");
    expect(state.loaderCalls[0]).toEqual({ baseUrl: "https://finance.example" });
  });

  it("still serves signals when the money summary fails, naming it in errors", async () => {
    state.claims = { email: "josh@x.com" };
    state.moneyFails = true;
    const res = await app.inject({ method: "GET", url: "/api/ext/signals" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summary?: unknown; errors: string[] };
    expect(body.summary).toBeUndefined();
    expect(body.errors).toEqual(["money-summary"]);
  });
});
