// GET /api/ext/signals — finance's money nudges for the hub panel. Only
// finance admins (ADMIN_EMAILS) may read them; everyone else gets 403 even
// with a valid hub service token.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const state = vi.hoisted(() => ({
  claims: null as { email: string; ops?: boolean } | null,
  loaderCalls: [] as Array<{ audience: string[]; baseUrl: string }>,
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
  loadFinanceSignals: vi.fn(async (ctx: { audience: string[]; baseUrl: string }) => {
    state.loaderCalls.push({ audience: ctx.audience, baseUrl: ctx.baseUrl });
    return {
      signals: [{ key: "finance.promise-missed.c1.2026-11-14", kind: "promise-missed" }],
      errors: [],
    };
  }),
}));

vi.mock("./dashboard-money.js", () => ({
  getMoneySummaryCached: vi.fn(async () => ({ currency: "USD", total: { overdue: "10.00" } })),
}));

import { signalsRoute } from "./ext-tools.js";

let app: FastifyInstance;

beforeEach(async () => {
  state.claims = null;
  state.loaderCalls = [];
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

  it("serves signals + money summary to a finance admin, audience = admins", async () => {
    state.claims = { email: "Shaya@x.com" };
    const res = await app.inject({ method: "GET", url: "/api/ext/signals" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { signals: unknown[]; summary: unknown; errors: unknown[]; generatedAt: string };
    expect(body.signals).toHaveLength(1);
    expect(body.summary).toMatchObject({ currency: "USD" });
    expect(body.errors).toEqual([]);
    expect(typeof body.generatedAt).toBe("string");
    expect(state.loaderCalls[0]).toEqual({ audience: ["josh@x.com", "shaya@x.com"], baseUrl: "https://finance.example" });
  });
});
