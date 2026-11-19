// /api/ext/customers/story(ies) — finance admins only (ADMIN_EMAILS), 403
// for anyone else, always no-store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const state = vi.hoisted(() => ({
  claims: null as { email: string } | null,
  emailIndex: new Map<string, string>(),
  known: new Set<string>(["cust1", "cust2", "cust3"]),
  changed: ["cust1", "cust2", "cust3"],
  changedCalls: [] as Array<{ since: Date; afterId: string | null; limit: number }>,
}));

vi.mock("../../lib/env.js", async (orig) => {
  const actual = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...actual.env, ADMIN_EMAILS: "josh@x.com,shaya@x.com", PUBLIC_URL: "https://finance.example/" } };
});

vi.mock("../lib/hub-service-auth.js", () => ({
  requireHubService: vi.fn((_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!state.claims) {
      reply.code(401).send({ error: "no token" });
      return null;
    }
    return state.claims;
  }),
}));

vi.mock("../../modules/hub-stories/load.js", () => ({
  findCustomerIdByEmail: vi.fn(async (email: string) => state.emailIndex.get(email.trim().toLowerCase()) ?? null),
  loadStories: vi.fn(async (ids: string[], ctx: { baseUrl: string }) =>
    ids.filter((id) => state.known.has(id)).map((id) => ({ customer: { id, name: `Name ${id}`, emails: [] }, baseUrl: ctx.baseUrl })),
  ),
  changedCustomerIds: vi.fn(async (opts: { since: Date; afterId: string | null; limit: number }) => {
    state.changedCalls.push(opts);
    return state.changed.filter((id) => opts.afterId === null || id > opts.afterId).slice(0, opts.limit);
  }),
}));

import { decodeCursor, effectiveSince, encodeCursor, storiesRoute } from "./ext-stories.js";

let app: FastifyInstance;

beforeEach(async () => {
  state.claims = null;
  state.emailIndex = new Map([["ap@keter.com", "cust2"]]);
  state.changedCalls = [];
  app = Fastify();
  await app.register(storiesRoute, { prefix: "/api/ext" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: "GET", url });

describe("GET /api/ext/customers/story", () => {
  it("401 without a token, 403 for a non-admin", async () => {
    expect((await get("/api/ext/customers/story?id=cust1")).statusCode).toBe(401);
    state.claims = { email: "sam@x.com" };
    const res = await get("/api/ext/customers/story?id=cust1");
    expect(res.statusCode).toBe(403);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("serves by id or by email (case-insensitive)", async () => {
    state.claims = { email: "Josh@x.com" };
    const a = await get("/api/ext/customers/story?id=cust1");
    expect(a.statusCode).toBe(200);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.json()).toMatchObject({ customer: { id: "cust1" }, baseUrl: "https://finance.example" });
    const b = await get("/api/ext/customers/story?email=AP%40Keter.com");
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ customer: { id: "cust2" } });
  });

  it("400 with neither, 404 for unknown", async () => {
    state.claims = { email: "josh@x.com" };
    expect((await get("/api/ext/customers/story")).statusCode).toBe(400);
    expect((await get("/api/ext/customers/story?email=nobody@x.com")).statusCode).toBe(404);
    expect((await get("/api/ext/customers/story?id=gone")).statusCode).toBe(404);
    expect((await get("/api/ext/customers/story?id=bad%20id%27")).statusCode).toBe(404);
  });
});

describe("GET /api/ext/customers/stories", () => {
  it("403 for a non-admin", async () => {
    state.claims = { email: "sam@x.com" };
    expect((await get("/api/ext/customers/stories")).statusCode).toBe(403);
    expect(state.changedCalls).toHaveLength(0);
  });

  it("pages by id with a stable cursor", async () => {
    state.claims = { email: "shaya@x.com" };
    const p1 = await get("/api/ext/customers/stories?changedSince=2026-11-18T00:00:00Z&limit=2");
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json() as { stories: Array<{ customer: { id: string } }>; nextCursor: string | null };
    expect(b1.stories.map((s) => s.customer.id)).toEqual(["cust1", "cust2"]);
    expect(b1.nextCursor).not.toBeNull();
    expect(state.changedCalls[0]).toMatchObject({ afterId: null, limit: 3 });
    expect(state.changedCalls[0]!.since.toISOString()).toBe("2026-11-18T00:00:00.000Z");

    const p2 = await get(`/api/ext/customers/stories?limit=2&cursor=${b1.nextCursor}`);
    const b2 = p2.json() as { stories: Array<{ customer: { id: string } }>; nextCursor: string | null };
    expect(b2.stories.map((s) => s.customer.id)).toEqual(["cust3"]);
    expect(b2.nextCursor).toBeNull();
    // The cursor keeps the original changedSince.
    expect(state.changedCalls[1]).toMatchObject({ afterId: "cust2" });
    expect(state.changedCalls[1]!.since.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });

  it("caps limit at 50, defaults to 25, and 400s bad input", async () => {
    state.claims = { email: "josh@x.com" };
    await get("/api/ext/customers/stories?limit=500");
    expect(state.changedCalls[0]!.limit).toBe(51);
    await get("/api/ext/customers/stories");
    expect(state.changedCalls[1]!.limit).toBe(26);
    expect((await get("/api/ext/customers/stories?limit=0")).statusCode).toBe(400);
    expect((await get("/api/ext/customers/stories?changedSince=yesterday")).statusCode).toBe(400);
    expect((await get("/api/ext/customers/stories?cursor=garbage")).statusCode).toBe(400);
  });
});

describe("helpers", () => {
  it("caps changedSince at 2 years back", () => {
    const now = new Date("2026-11-19T00:00:00Z");
    expect(effectiveSince("2001-01-01T00:00:00Z", now)!.toISOString()).toBe("2024-11-19T00:00:00.000Z");
    expect(effectiveSince(undefined, now)!.toISOString()).toBe("2024-11-19T00:00:00.000Z");
    expect(effectiveSince("nope", now)).toBeNull();
  });

  it("round-trips a cursor and refuses junk", () => {
    const c = { after: "abc_DEF-1", since: "2026-11-18T00:00:00.000Z" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ after: "x' OR 1", since: c.since }))).toBeNull();
    expect(decodeCursor("%%%")).toBeNull();
  });
});
