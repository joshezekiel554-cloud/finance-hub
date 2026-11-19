// /api/ext/signals — finance's money nudges for the hub panel. Only finance
// admins (ADMIN_EMAILS) see signals; everyone else gets an empty feed, and
// the promise/note writes are 403 for them.

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

const writes = vi.hoisted(() => ({
  promiseCalls: [] as Array<Record<string, unknown>>,
  promiseResult: null as unknown,
  noteCalls: [] as Array<Record<string, unknown>>,
  noteResult: null as unknown,
}));

vi.mock("../../modules/promises/promises.js", () => ({
  PROMISE_NOTE_MAX: 300,
  setPromise: vi.fn(async (input: Record<string, unknown>) => {
    writes.promiseCalls.push(input);
    return writes.promiseResult;
  }),
}));

vi.mock("../../modules/promises/hub-notes.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    addHubNote: vi.fn(async (input: Record<string, unknown>) => {
      writes.noteCalls.push(input);
      return writes.noteResult;
    }),
  };
});

const queueAdds = vi.hoisted(() => [] as Array<{ name: string; data: unknown; opts: { jobId?: string } }>);
vi.mock("../../jobs/queues.js", () => ({
  GMAIL_POLL_JOB: "gmail-poll",
  getQueues: () => ({
    gmail: {
      add: vi.fn(async (name: string, data: unknown, opts: { jobId?: string }) => {
        queueAdds.push({ name, data, opts });
      }),
    },
  }),
}));

import { createRefreshGate, signalsRoute } from "./ext-tools.js";

let app: FastifyInstance;

beforeEach(async () => {
  state.claims = null;
  state.loaderCalls = [];
  state.moneyFails = false;
  writes.promiseCalls = [];
  writes.noteCalls = [];
  writes.promiseResult = {
    ok: true,
    changed: true,
    promise: { customerId: "cust1", promisedBy: "2030-01-10", note: "wire Friday", setBy: "josh@x.com" },
  };
  writes.noteResult = { ok: true, changed: true, customerId: "cust1", activityId: "a1" };
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

  it("gives a staff member who isn't a finance admin an empty feed (no summary)", async () => {
    state.claims = { email: "sam@x.com", ops: true };
    const res = await app.inject({ method: "GET", url: "/api/ext/signals" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as Record<string, unknown>;
    expect(body.signals).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.summary).toBeUndefined();
    expect(typeof body.generatedAt).toBe("string");
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

describe("POST /api/ext/signals/promise", () => {
  const post = (payload: object) => app.inject({ method: "POST", url: "/api/ext/signals/promise", payload });

  it("403s for a non-admin and never writes", async () => {
    state.claims = { email: "sam@x.com", ops: true };
    const res = await post({ customerId: "cust1", date: "2030-01-10" });
    expect(res.statusCode).toBe(403);
    expect(writes.promiseCalls).toHaveLength(0);
  });

  it("saves a promise as the token's person and returns it", async () => {
    state.claims = { email: "josh@x.com" };
    const res = await post({ customerId: "cust1", date: "2030-01-10", note: "  wire Friday " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      promise: { customerId: "cust1", promisedBy: "2030-01-10", note: "wire Friday", setBy: "josh@x.com" },
    });
    expect(writes.promiseCalls[0]).toEqual({
      customerId: "cust1",
      date: "2030-01-10",
      note: "wire Friday",
      actorEmail: "josh@x.com",
      source: "hub",
    });
  });

  it("400s a malformed body or an over-long note", async () => {
    state.claims = { email: "josh@x.com" };
    expect((await post({ date: "2030-01-10" })).statusCode).toBe(400);
    expect((await post({ customerId: "cust1", date: "2030-01-10", note: "x".repeat(301) })).statusCode).toBe(400);
    expect(writes.promiseCalls).toHaveLength(0);
  });

  it("400s a past date or unknown customer with the module's error", async () => {
    state.claims = { email: "josh@x.com" };
    writes.promiseResult = { ok: false, reason: "bad_date", error: "date is in the past" };
    const res = await post({ customerId: "cust1", date: "2020-01-01" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "date is in the past" });
    writes.promiseResult = { ok: false, reason: "not_found", error: "unknown customer" };
    expect((await post({ customerId: "nope", date: "2030-01-10" })).statusCode).toBe(400);
  });
});

describe("POST /api/ext/signals/note", () => {
  const post = (payload: object) => app.inject({ method: "POST", url: "/api/ext/signals/note", payload });

  it("403s for a non-admin", async () => {
    state.claims = { email: "sam@x.com" };
    expect((await post({ key: "finance.chase-no-reply.cust1.m1", note: "hi" })).statusCode).toBe(403);
    expect(writes.noteCalls).toHaveLength(0);
  });

  it("derives the customer from the signal key and records the trimmed note", async () => {
    state.claims = { email: "shaya@x.com" };
    const res = await post({ key: "finance.promise-suggested.cust1.gm-9", note: "  Spoke to Dovid, cheque Monday  " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, customerId: "cust1" });
    expect(writes.noteCalls[0]).toEqual({
      customerId: "cust1",
      note: "Spoke to Dovid, cheque Monday",
      actorEmail: "shaya@x.com",
      signalKey: "finance.promise-suggested.cust1.gm-9",
    });
  });

  it("404s a key that isn't finance's, or a customer finance doesn't know", async () => {
    state.claims = { email: "josh@x.com" };
    expect((await post({ key: "inbox.thread.abc", note: "x" })).statusCode).toBe(404);
    expect((await post({ key: "finance", note: "x" })).statusCode).toBe(404);
    writes.noteResult = { ok: false, reason: "not_found", error: "unknown customer" };
    expect((await post({ key: "finance.chase-no-reply.gone.m1", note: "x" })).statusCode).toBe(404);
  });

  it("400s an empty or over-long note", async () => {
    state.claims = { email: "josh@x.com" };
    expect((await post({ key: "finance.chase-no-reply.cust1.m1", note: "   " })).statusCode).toBe(400);
    expect((await post({ key: "finance.chase-no-reply.cust1.m1", note: "x".repeat(1001) })).statusCode).toBe(400);
    expect(writes.noteCalls).toHaveLength(0);
  });
});

describe("POST /api/ext/signals/refresh", () => {
  it("403s for a non-admin and queues nothing", async () => {
    state.claims = { email: "sam@x.com", ops: true };
    queueAdds.length = 0;
    const res = await app.inject({ method: "POST", url: "/api/ext/signals/refresh" });
    expect(res.statusCode).toBe(403);
    await new Promise((r) => setTimeout(r, 10));
    expect(queueAdds).toHaveLength(0);
  });

  it("202s for an admin and queues one manual Gmail poll, debounced", async () => {
    state.claims = { email: "josh@x.com" };
    queueAdds.length = 0;
    const a = await app.inject({ method: "POST", url: "/api/ext/signals/refresh" });
    const b = await app.inject({ method: "POST", url: "/api/ext/signals/refresh" });
    expect(a.statusCode).toBe(202);
    expect(a.json()).toEqual({ ok: true, queued: true });
    expect(b.statusCode).toBe(202);
    expect(b.json()).toEqual({ ok: true, queued: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(queueAdds).toHaveLength(1);
    expect(queueAdds[0]).toMatchObject({ name: "gmail-poll", data: { trigger: "manual" } });
  });
});

describe("createRefreshGate", () => {
  it("lets one through per window", () => {
    const g = createRefreshGate(30_000);
    expect(g.tryAcquire(0)).toBe(true);
    expect(g.tryAcquire(29_999)).toBe(false);
    expect(g.tryAcquire(30_000)).toBe(true);
  });
});
