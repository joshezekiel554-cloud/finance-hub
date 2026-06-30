// Route tests for the Time Clock surface. Boot a real Fastify instance with the
// plugin registered, drive via `inject`, mock the auth gate + the service. We
// exercise the clock-enabled gate (403), status enabled:false for non-allow-list
// users, the happy path, and the 409s (already_open / not_open).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const currentUser = vi.hoisted(() => ({
  value: null as { id: string; email: string } | null,
}));

vi.mock("../lib/auth.js", () => ({
  requireAuth: vi.fn(async () => {
    if (!currentUser.value) {
      const err = new Error("Unauthorized") as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    }
    return currentUser.value;
  }),
}));

// Service mock — drives gating + clock outcomes per-test.
const svc = vi.hoisted(() => ({
  enabled: new Set<string>(),
  clockInResult: null as unknown,
  clockOutResult: null as unknown,
  status: null as unknown,
}));

vi.mock("../../modules/time-clock/service.js", () => ({
  isClockEnabled: vi.fn(async (userId: string) => svc.enabled.has(userId)),
  clockIn: vi.fn(async () => svc.clockInResult),
  clockOut: vi.fn(async () => svc.clockOutResult),
  getStatus: vi.fn(async (userId: string) =>
    svc.status ?? {
      enabled: svc.enabled.has(userId),
      open: null,
      stale: false,
      todayMinutes: 0,
      weekMinutes: 0,
    },
  ),
}));

import timeClockRoute from "./time-clock.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });
  await app.register(timeClockRoute, { prefix: "/api" });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  currentUser.value = null;
  svc.enabled = new Set();
  svc.clockInResult = null;
  svc.clockOutResult = null;
  svc.status = null;
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe("auth + gating", () => {
  it("401s in/out/status when unauthenticated", async () => {
    for (const [method, url] of [
      ["POST", "/api/time-clock/in"],
      ["POST", "/api/time-clock/out"],
      ["GET", "/api/time-clock/status"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("403s clock in/out for a non-allow-list user", async () => {
    currentUser.value = { id: "u-rando", email: "rando@feldart.com" };
    const inRes = await app.inject({ method: "POST", url: "/api/time-clock/in" });
    expect(inRes.statusCode).toBe(403);
    const outRes = await app.inject({ method: "POST", url: "/api/time-clock/out" });
    expect(outRes.statusCode).toBe(403);
  });

  it("status returns enabled:false for a non-allow-list user (200)", async () => {
    currentUser.value = { id: "u-rando", email: "rando@feldart.com" };
    const res = await app.inject({ method: "GET", url: "/api/time-clock/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    expect(res.json().open).toBeNull();
  });
});

describe("clock in/out (allow-listed user)", () => {
  const HILLEL = { id: "u-hillel", email: "hillel@feldart.com" };

  beforeEach(() => {
    svc.enabled.add(HILLEL.id);
    currentUser.value = HILLEL;
  });

  it("clock in happy path returns the status payload", async () => {
    svc.clockInResult = { ok: true, session: { id: "s1" } };
    svc.status = { enabled: true, open: { clockInAt: "2026-06-30T09:00:00.000Z" }, stale: false, todayMinutes: 0, weekMinutes: 0 };
    const res = await app.inject({ method: "POST", url: "/api/time-clock/in" });
    expect(res.statusCode).toBe(200);
    expect(res.json().open.clockInAt).toBe("2026-06-30T09:00:00.000Z");
  });

  it("409s clock in when already open", async () => {
    svc.clockInResult = { ok: false, reason: "already_open" };
    const res = await app.inject({ method: "POST", url: "/api/time-clock/in" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_open");
  });

  it("clock out happy path returns the status payload", async () => {
    svc.clockOutResult = { ok: true, session: { id: "s1" } };
    svc.status = { enabled: true, open: null, stale: false, todayMinutes: 120, weekMinutes: 300 };
    const res = await app.inject({ method: "POST", url: "/api/time-clock/out" });
    expect(res.statusCode).toBe(200);
    expect(res.json().open).toBeNull();
    expect(res.json().weekMinutes).toBe(300);
  });

  it("409s clock out when nothing is open", async () => {
    svc.clockOutResult = { ok: false, reason: "not_open" };
    const res = await app.inject({ method: "POST", url: "/api/time-clock/out" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_open");
  });
});
