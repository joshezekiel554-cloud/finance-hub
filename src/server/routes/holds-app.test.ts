// Hold Orders API role gate: HOLDORDERS_EMAILS (sales@) can use /api/holds/*
// actions but gets 403 on every rules write; ADMIN_EMAILS can edit rules;
// finance staff on neither list and signed-out callers are refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string | null; image: string | null } | null,
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  shopifyDown: false,
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
  loadDefaultRuleCustomerIds: vi.fn(async () => ["c-b2b-1", "c-b2b-2"]),
}));
vi.mock("../../modules/hold-orders/settings-store.js", async () => {
  const { HOLDS_CONFIG_DEFAULTS } = await import("../../modules/hold-orders/holds-settings.js");
  return {
    loadHoldsConfig: vi.fn(async () => HOLDS_CONFIG_DEFAULTS),
    loadHoldsConfigWithTemplateCheck: vi.fn(async () => ({ config: HOLDS_CONFIG_DEFAULTS, ladderTemplateLiterals: ["hold_warning"] })),
    loadLastChanged: vi.fn(async () => null),
    saveHoldsConfig: vi.fn(async (a: unknown) => {
      h.calls.push({ fn: "saveHoldsConfig", args: [a] });
      return { changed: [{ key: "order_hold_warn_days", before: "7", after: "5" }] };
    }),
  };
});
vi.mock("../../modules/hold-orders/settings-preview.js", () => ({
  dryRunHoldsConfig: vi.fn(async (cfg: unknown) => {
    h.calls.push({ fn: "dryRunHoldsConfig", args: [cfg] });
    return { hold: { count: 0, orders: [] }, flag: { count: 0, orders: [] } };
  }),
}));
vi.mock("../../modules/hold-orders/exclusions.js", () => ({ loadExclusions: vi.fn(async () => []) }));
vi.mock("../../modules/hold-orders/bulk-rules.js", () => ({
  BULK_MAX_IDS: 1000,
  CANDIDATE_SOURCES: ["shopify_b2b", "finance_b2b", "no_rule", "preset"],
  candidateWhere: vi.fn(() => undefined),
  loadCandidateRows: vi.fn(async () => [{ id: "c1" }]),
  loadCandidateRowsByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id }))),
  previewBulkRule: vi.fn(async (a: unknown) => {
    h.calls.push({ fn: "previewBulkRule", args: [a] });
    return { targets: 1, skippedExisting: 0, unknown: 0, orderCount: 0, customersHit: 0, orders: [] };
  }),
  applyBulkRule: vi.fn(async (a: unknown) => {
    h.calls.push({ fn: "applyBulkRule", args: [a] });
    return { applied: 1, unchanged: 0, skippedExisting: 0, unknown: 0 };
  }),
}));
vi.mock("../../integrations/shopify/client.js", () => ({ ShopifyClient: class {} }));
vi.mock("../../integrations/shopify/customers.js", () => ({
  listCustomersByTag: vi.fn(async () => {
    if (h.shopifyDown) throw new Error("shopify 503");
    return [{ id: 1, email: "a@x.com" }];
  }),
}));
vi.mock("../../modules/crm/shopify-customer-match.js", () => ({
  matchShopifyCustomers: vi.fn(async () => ({
    matched: [{ id: "c-shop", displayName: "Shop Co", email: "a@x.com" }],
    unmatched: [{ shopifyId: "2", name: "Ghost", email: "g@x.com" }],
  })),
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
  h.shopifyDown = false;
});

const as = (email: string | null) => {
  h.user = email ? { id: `u-${email}`, email, name: null, image: null } : null;
};
const vipRule = { preset: "relaxed", autoStartLadder: false, autoReleaseOnPayment: true, notifyWarehouse: true };

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

  it("preview hides finance customer links for the holds role (admins see them)", async () => {
    const { previewAction } = await import("../../modules/hold-orders/actions.js");
    const mocked = vi.mocked(previewAction);
    mocked.mockClear();
    await app.inject({ method: "GET", url: "/api/holds/o1/preview?action=release&mode=notify" });
    expect(mocked.mock.calls[0]?.[2]).toEqual({ hideFinanceLinks: true });
    as("josh@feldart.com");
    await app.inject({ method: "GET", url: "/api/holds/o1/preview?action=release&mode=notify" });
    expect(mocked.mock.calls[1]?.[2]).toEqual({ hideFinanceLinks: false });
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
      rule: { preset: "relaxed", graceDays: 30, minOverdue: 50 },
      actorEmail: "josh@feldart.com",
    });
  });

  it("invalid custom rule → 400", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/holds/rules/c1",
      payload: { ...vipRule, preset: "custom", graceDays: -3 },
    });
    expect(put.statusCode).toBe(400);
  });
});

describe("Settings (operator decision B: sales@ read-only, writes admin-only)", () => {
  it("holds role: GET /settings 200 with canEdit=false; exclusions readable", async () => {
    as("sales@feldart.com");
    const res = await app.inject({ method: "GET", url: "/api/holds/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      canEdit: false,
      values: { defaultRuleEnabled: false, warnDays: 7, autoReleaseEmailsWarehouse: true, ruleHoldsRespectPromise: false },
      defaultRuleScopeCount: 2,
    });
    const ex = await app.inject({ method: "GET", url: "/api/holds/settings/exclusions" });
    expect(ex.statusCode).toBe(200);
    expect(ex.json().financeUrl).toBeNull();
  });

  it("holds role: PATCH and preview → 403, nothing saved or dry-run", async () => {
    as("sales@feldart.com");
    const patch = await app.inject({ method: "PATCH", url: "/api/holds/settings", payload: { warnDays: 5 } });
    const prev = await app.inject({ method: "POST", url: "/api/holds/settings/preview", payload: { draft: { warnDays: 5 } } });
    expect([patch.statusCode, prev.statusCode]).toEqual([403, 403]);
    expect(h.calls.filter((c) => c.fn === "saveHoldsConfig" || c.fn === "dryRunHoldsConfig")).toEqual([]);
  });

  it("holds role: bulk rule endpoints → 403", async () => {
    as("sales@feldart.com");
    const body = { customerIds: ["c1"], rule: vipRule, overwrite: false };
    const cand = await app.inject({ method: "POST", url: "/api/holds/rules/candidates", payload: { source: "finance_b2b" } });
    const prev = await app.inject({ method: "POST", url: "/api/holds/rules/bulk-preview", payload: body });
    const apply = await app.inject({ method: "POST", url: "/api/holds/rules/bulk-apply", payload: body });
    expect([cand.statusCode, prev.statusCode, apply.statusCode]).toEqual([403, 403, 403]);
    expect(h.calls.filter((c) => c.fn === "applyBulkRule")).toEqual([]);
  });

  it("admin: GET canEdit=true; PATCH saves the merged config with the actor", async () => {
    as("josh@feldart.com");
    expect((await app.inject({ method: "GET", url: "/api/holds/settings" })).json().canEdit).toBe(true);
    const res = await app.inject({ method: "PATCH", url: "/api/holds/settings", payload: { warnDays: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toEqual(["order_hold_warn_days"]);
    const call = h.calls.find((c) => c.fn === "saveHoldsConfig");
    expect(call?.args[0]).toMatchObject({ next: { warnDays: 5, cancelDays: 10 }, userId: "u-josh@feldart.com", actorEmail: "josh@feldart.com" });
  });

  it("admin: invalid values → 400 with field errors (warn must be before cancel; bounds)", async () => {
    as("josh@feldart.com");
    const order = await app.inject({ method: "PATCH", url: "/api/holds/settings", payload: { warnDays: 12 } });
    expect(order.statusCode).toBe(400);
    expect(order.json().errors[0]).toMatchObject({ field: "warnDays" });
    const bounds = await app.inject({ method: "PATCH", url: "/api/holds/settings", payload: { holdAlertLookbackDays: 0 } });
    expect(bounds.statusCode).toBe(400);
    const unknown = await app.inject({ method: "PATCH", url: "/api/holds/settings", payload: { bogus: 1 } });
    expect(unknown.statusCode).toBe(400);
    expect(h.calls.filter((c) => c.fn === "saveHoldsConfig")).toEqual([]);
  });

  it("admin: preview dry-runs the draft AND today's config, never saves", async () => {
    as("josh@feldart.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/holds/settings/preview",
      payload: { draft: { defaultRuleEnabled: true } },
    });
    expect(res.statusCode).toBe(200);
    const runs = h.calls.filter((c) => c.fn === "dryRunHoldsConfig").map((c) => c.args[0] as { defaultRuleEnabled: boolean });
    expect(runs.map((r) => r.defaultRuleEnabled).sort()).toEqual([false, true]);
    expect(h.calls.filter((c) => c.fn === "saveHoldsConfig")).toEqual([]);
  });
});

describe("bulk rule picker (admin)", () => {
  beforeEach(() => as("josh@feldart.com"));

  it("Shopify source: matched rows + unmatched list + fetchedAt", async () => {
    const res = await app.inject({ method: "POST", url: "/api/holds/rules/candidates", payload: { source: "shopify_b2b" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rows: [{ id: "c-shop" }], unmatched: [{ name: "Ghost" }], unmatchedCount: 1 });
    expect(typeof res.json().fetchedAt).toBe("string");
  });

  it("Shopify down → 502 with a friendly message", async () => {
    h.shopifyDown = true;
    const res = await app.inject({ method: "POST", url: "/api/holds/rules/candidates", payload: { source: "shopify_b2b" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Shopify/);
  });

  it("bulk apply resolves the preset and passes overwrite + actor through", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/holds/rules/bulk-apply",
      payload: { customerIds: ["c1", "c2"], rule: vipRule, overwrite: true },
    });
    expect(res.statusCode).toBe(200);
    const call = h.calls.find((c) => c.fn === "applyBulkRule");
    expect(call?.args[0]).toMatchObject({
      ids: ["c1", "c2"],
      overwrite: true,
      rule: { preset: "relaxed", graceDays: 30, minOverdue: 50 },
      actorEmail: "josh@feldart.com",
    });
  });

  it("more than 1000 ids → 400", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `c${i}`);
    const res = await app.inject({ method: "POST", url: "/api/holds/rules/bulk-preview", payload: { customerIds: ids, rule: vipRule } });
    expect(res.statusCode).toBe(400);
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
