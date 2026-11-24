// Hold Orders API role gate: HOLDORDERS_EMAILS (sales@) can use /api/holds/*
// actions but gets 403 on every rules write; ADMIN_EMAILS can edit rules;
// finance staff on neither list and signed-out callers are refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string | null; image: string | null } | null,
  calls: [] as Array<{ fn: string; args: unknown[] }>,
}));

vi.mock("../../lib/env.js", () => ({
  env: {
    ADMIN_EMAILS: "josh@feldart.com,info@feldartcollection.co.uk",
    HOLDORDERS_EMAILS: "sales@feldart.com",
    ALLOWED_EMAILS: "josh@feldart.com,info@feldartcollection.co.uk,hillel@feldart.com",
    HUB_PARENT_ORIGIN: "https://hub.feldart.com",
    PUBLIC_URL: "https://finance.feldart.com",
    SHADOW_MODE: false,
  },
}));
vi.mock("../lib/auth.js", () => ({
  getCurrentUser: vi.fn(async () => h.user),
}));
vi.mock("../../db/index.js", () => ({ db: {} }));
vi.mock("../../modules/hold-orders/board.js", () => ({
  loadHoldBoard: vi.fn(async (opts: unknown) => {
    h.calls.push({ fn: "loadHoldBoard", args: [opts] });
    return {
      rows: [
        { orderId: "o1", orderNumber: "#1", customerName: "A", tabs: ["held"] },
        { orderId: "o2", orderNumber: "#2", customerName: "B", tabs: ["released"] },
      ],
      counts: { held: 1, chasing: 0, at_risk: 0, shipped_while_held: 0, released: 1 },
      generatedAt: "now",
    };
  }),
}));
vi.mock("../../modules/hold-orders/timeline.js", () => ({ getHoldTimeline: vi.fn(async () => []) }));
const { record } = vi.hoisted(() => ({
  record:
    (fn: string) =>
    async (...args: unknown[]) => {
      h.calls.push({ fn, args });
      return { ok: true, emailed: [] };
    },
}));
vi.mock("../../modules/hold-orders/actions.js", () => ({
  holdOrder: record("holdOrder"),
  releaseOrder: record("releaseOrder"),
  pauseOrder: record("pauseOrder"),
  addHoldNote: record("addHoldNote"),
  previewAction: vi.fn(async () => ({ emails: [], shadowMode: false })),
}));
vi.mock("../../modules/hold-orders/rules-store.js", () => ({
  listRules: vi.fn(async () => []),
  getRule: vi.fn(async () => null),
  upsertRule: record("upsertRule"),
  deleteRule: record("deleteRule"),
  previewRule: vi.fn(async () => ({ evaluation: { wouldHold: false }, orders: [] })),
}));

import holdsAppRoute from "./holds-app.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(holdsAppRoute, { prefix: "/api/holds" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.calls.length = 0;
});

const as = (email: string | null) => {
  h.user = email ? { id: `u-${email}`, email, name: null, image: null } : null;
};
const vipRule = { preset: "vip_90_110", autoStartLadder: false, autoReleaseOnPayment: true, notifyWarehouse: true };

describe("HOLDORDERS_EMAILS (sales@) role", () => {
  beforeEach(() => as("sales@feldart.com"));

  it("sees the board, with balances (option b) and no finance links", async () => {
    const res = await app.inject({ method: "GET", url: "/api/holds?status=held" });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { orderId: string }) => r.orderId)).toEqual(["o1"]);
    expect(h.calls[0]?.args[0]).toMatchObject({ seeBalances: true, financeLinks: false });
  });

  it("can hold / release (incl. record-only + paid outside QBO) / pause / note", async () => {
    const hold = await app.inject({ method: "POST", url: "/api/holds/o1/hold", payload: { reason: "manual", startLadder: false, mode: "notify" } });
    expect(hold.statusCode).toBe(200);
    const rel = await app.inject({
      method: "POST",
      url: "/api/holds/o1/release",
      payload: { mode: "record_only", paidOutsideQbo: { method: "cheque", note: "chq 12" } },
    });
    expect(rel.statusCode).toBe(200);
    const pause = await app.inject({ method: "POST", url: "/api/holds/o1/pause", payload: { until: "2099-01-01" } });
    expect(pause.statusCode).toBe(200);
    const note = await app.inject({ method: "POST", url: "/api/holds/o1/note", payload: { note: "called them" } });
    expect(note.statusCode).toBe(200);
    expect(h.calls.map((c) => c.fn)).toEqual(["holdOrder", "releaseOrder", "pauseOrder", "addHoldNote"]);
    expect(h.calls[0]?.args[1]).toEqual({ userId: "u-sales@feldart.com", email: "sales@feldart.com" });
  });

  it("gets 403 on every rules write / editor endpoint", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/holds/rules/c1", payload: vipRule });
    const del = await app.inject({ method: "DELETE", url: "/api/holds/rules/c1" });
    const prev = await app.inject({ method: "POST", url: "/api/holds/rules/preview", payload: { customerId: "c1", rule: vipRule } });
    const search = await app.inject({ method: "GET", url: "/api/holds/rules/customers?q=meo" });
    expect([put.statusCode, del.statusCode, prev.statusCode, search.statusCode]).toEqual([403, 403, 403, 403]);
    expect(h.calls.filter((c) => c.fn === "upsertRule" || c.fn === "deleteRule")).toEqual([]);
  });

  it("can read rules (view only)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/holds/rules" });
    expect(res.statusCode).toBe(200);
    expect(res.json().canEdit).toBe(false);
  });

  it("/me reports the holds role", async () => {
    const res = await app.inject({ method: "GET", url: "/api/holds/me" });
    expect(res.json()).toMatchObject({ role: "holds", financeUrl: null, permissions: { editRules: false, release: true } });
  });
});

describe("ADMIN_EMAILS role", () => {
  beforeEach(() => as("josh@feldart.com"));

  it("can edit rules", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/holds/rules/c1", payload: vipRule });
    expect(put.statusCode).toBe(200);
    const call = h.calls.find((c) => c.fn === "upsertRule");
    expect(call?.args[0]).toMatchObject({
      customerId: "c1",
      rule: { preset: "vip_90_110", termsDays: 90, holdWhenInvoiceDaysOver: 110 },
      actorEmail: "josh@feldart.com",
    });
  });

  it("invalid custom rule → 400", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/holds/rules/c1",
      payload: { ...vipRule, preset: "custom", termsDays: 60, holdWhenInvoiceDaysOver: 30 },
    });
    expect(put.statusCode).toBe(400);
  });
});

describe("everyone else", () => {
  it("finance staff on neither list → 403", async () => {
    as("hillel@feldart.com");
    expect((await app.inject({ method: "GET", url: "/api/holds" })).statusCode).toBe(403);
  });
  it("signed out → 401 on the API, 200 user:null on /me", async () => {
    as(null);
    expect((await app.inject({ method: "GET", url: "/api/holds" })).statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/api/holds/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: null, role: null, hubUrl: "https://hub.feldart.com" });
  });
});
