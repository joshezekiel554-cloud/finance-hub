// Bulk rule picker: target selection (skip existing unless overwrite),
// one audit row per customer actually changed, preset rows follow the live
// preset table, Shopify ↔ finance email matching.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  customers: [] as Array<{ id: string; name: string }>,
  rules: [] as Array<Record<string, unknown>>,
  ruleInserts: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  selectN: 0,
}));

vi.mock("../../lib/env.js", () => ({ env: { SHADOW_MODE: false, PUBLIC_URL: "https://finance.example" } }));
vi.mock("./detection.js", () => ({ planRuleHolds: vi.fn(async () => ({ ruleCustomers: 0, planned: [], skippedForPromise: 0 })) }));
vi.mock("../../db/index.js", async () => {
  const { auditLog } = await import("../../db/schema/audit.js");
  return {
    db: {
      // resolveBulkTargets: 1st select = customers, 2nd = rule rows.
      select: () => {
        const n = h.selectN++;
        const chain = {
          from: () => chain,
          where: () => Promise.resolve(n % 2 === 0 ? h.customers : h.rules),
        };
        return chain;
      },
      insert: (table: unknown) => ({
        values: (v: Array<Record<string, unknown>>) => {
          if (table === auditLog) {
            h.audits.push(...v);
            return Promise.resolve();
          }
          h.ruleInserts.push(...v);
          return { onDuplicateKeyUpdate: () => Promise.resolve() };
        },
      }),
    },
  };
});

import { applyBulkRule, splitBulkTargets } from "./bulk-rules.js";
import { rowToRule } from "./rules-store.js";
import { splitShopifyMatches } from "../crm/shopify-customer-match.js";
import { parsePresetOverrides } from "./holds-settings.js";
import type { CustomerHoldRule } from "../../db/schema/hold-rules.js";
import type { ResolvedHoldRule } from "./presets.js";

const std: ResolvedHoldRule = {
  preset: "standard_30_45",
  termsDays: 30,
  holdWhenInvoiceDaysOver: 45,
  minBalance: 50,
  autoStartLadder: false,
  autoReleaseOnPayment: true,
  notifyWarehouse: true,
  note: null,
};

function row(customerId: string, over: Partial<CustomerHoldRule> = {}): CustomerHoldRule {
  return {
    customerId,
    preset: "vip_90_110",
    termsDays: 90,
    holdWhenInvoiceDaysOver: 110,
    minBalance: "50.00",
    autoStartLadder: false,
    autoReleaseOnPayment: true,
    notifyWarehouse: true,
    note: null,
    setByUserId: null,
    setAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  h.customers = [];
  h.rules = [];
  h.ruleInserts.length = 0;
  h.audits.length = 0;
  h.selectN = 0;
});

describe("splitBulkTargets", () => {
  it("skips customers that already have a rule unless overwrite; drops unknown ids and dupes", () => {
    const known = new Set(["a", "b", "c"]);
    const existing = new Map([["b", {}]]);
    expect(splitBulkTargets(["a", "b", "x", "a", "c"], known, existing, false)).toEqual({
      targets: ["a", "c"],
      skippedExisting: ["b"],
      unknown: ["x"],
    });
    expect(splitBulkTargets(["a", "b"], known, existing, true).targets).toEqual(["a", "b"]);
  });
});

describe("applyBulkRule", () => {
  it("writes only new/changed customers, one audit row each, no email", async () => {
    h.customers = [
      { id: "new", name: "New Co" },
      { id: "has-vip", name: "VIP Co" },
      { id: "same", name: "Same Co" },
    ];
    h.rules = [row("has-vip"), row("same", { preset: "standard_30_45", termsDays: 30, holdWhenInvoiceDaysOver: 45 })];

    const skip = await applyBulkRule({ ids: ["new", "has-vip", "same", "ghost"], rule: std, overwrite: false, userId: "u", actorEmail: "josh@x" });
    expect(skip).toEqual({ applied: 1, unchanged: 0, skippedExisting: 2, unknown: 1 });
    expect(h.ruleInserts.map((r) => r.customerId)).toEqual(["new"]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: "customer_hold_rule.created",
      entityType: "customer_hold_rule",
      entityId: "new",
      after: { preset: "standard_30_45", actorEmail: "josh@x", via: "bulk" },
    });

    h.selectN = 0;
    h.ruleInserts.length = 0;
    h.audits.length = 0;
    const over = await applyBulkRule({ ids: ["new", "has-vip", "same"], rule: std, overwrite: true, userId: "u", actorEmail: "josh@x" });
    // "same" already has exactly this rule → unchanged, no audit noise.
    expect(over).toEqual({ applied: 2, unchanged: 1, skippedExisting: 0, unknown: 0 });
    expect(h.audits.map((a) => [a.entityId, a.action])).toEqual([
      ["new", "customer_hold_rule.created"],
      ["has-vip", "customer_hold_rule.updated"],
    ]);
    expect(h.audits[1]?.before).toMatchObject({ preset: "vip_90_110", customerName: "VIP Co" });
  });
});

describe("rowToRule: preset rows follow the live preset table", () => {
  it("preset row → live numbers; custom row keeps its own", () => {
    const table = parsePresetOverrides(JSON.stringify({ vip_90_110: { termsDays: 90, holdWhenInvoiceDaysOver: 120, minBalance: 0 } }));
    expect(rowToRule(row("a"), table)).toMatchObject({ holdWhenInvoiceDaysOver: 120, minBalance: 0 });
    expect(rowToRule(row("a"))).toMatchObject({ holdWhenInvoiceDaysOver: 110, minBalance: 50 });
    const custom = row("b", { preset: "custom", termsDays: 45, holdWhenInvoiceDaysOver: 60, minBalance: "200.00" });
    expect(rowToRule(custom, table)).toMatchObject({ termsDays: 45, holdWhenInvoiceDaysOver: 60, minBalance: 200 });
  });
});

describe("splitShopifyMatches", () => {
  it("matches by email case-insensitively; unmatched + no-email listed", () => {
    const r = splitShopifyMatches(
      [
        { id: 1, email: "Buyer@Shop.COM ", first_name: "Ann", last_name: "Lee" },
        { id: 2, email: "nobody@x.com", first_name: "Ghost", last_name: null },
        { id: 3, email: null, first_name: null, last_name: null },
      ],
      [{ id: "c1", displayName: "Shop Co", email: "buyer@shop.com" }],
    );
    expect(r.matched.map((m) => m.id)).toEqual(["c1"]);
    expect(r.unmatched).toEqual([
      { shopifyId: "2", name: "Ghost", email: "nobody@x.com" },
      { shopifyId: "3", name: "(no name)", email: null },
    ]);
  });
});
