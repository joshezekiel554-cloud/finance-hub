// Default-rule scope = b2b AND hold_status 'active'. On-hold / prepay
// accounts are the standard pass's job (otherwise a new order could be held
// as customer_rule with the wrong reason). An explicit row can still opt
// them in. Same scope in SQL (detection + dry run) and in the picker label.
import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({ where: null as unknown }));

vi.mock("../../lib/env.js", () => ({ env: { SHADOW_MODE: false, PUBLIC_URL: "https://finance.example" } }));
vi.mock("./detection.js", () => ({ planRuleHolds: vi.fn() }));
vi.mock("../../db/index.js", () => {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: (w: unknown) => {
      h.where = w;
      return chain;
    },
    limit: () => Promise.resolve([{ id: "c1" }]),
  };
  return { db: { select: () => chain } };
});

import { loadDefaultRuleCustomerIds } from "./rules-store.js";
import { candidateWhere } from "./bulk-rules.js";
import { buildEffectiveRules, inDefaultRuleScope } from "./effective-rules.js";
import { HOLDS_CONFIG_DEFAULTS } from "./holds-settings.js";
import { currentRuleLabel } from "../../web/holds/lib/bulk-picker.js";

const dialect = new MySqlDialect();
const render = (w: unknown) => dialect.sqlToQuery(w as SQL);

describe("default-rule scope", () => {
  it("pure predicate: b2b + active only", () => {
    expect(inDefaultRuleScope({ customerType: "b2b", holdStatus: "active" })).toBe(true);
    expect(inDefaultRuleScope({ customerType: "b2b", holdStatus: "hold" })).toBe(false);
    expect(inDefaultRuleScope({ customerType: "b2b", holdStatus: "payment_upfront" })).toBe(false);
    expect(inDefaultRuleScope({ customerType: "b2c", holdStatus: "active" })).toBe(false);
    expect(inDefaultRuleScope({ customerType: null, holdStatus: "active" })).toBe(false);
  });

  it("SQL (detection, auto-release, dry run): b2b, hold_status active, no explicit row", async () => {
    await loadDefaultRuleCustomerIds();
    const q = render(h.where);
    expect(q.sql).toMatch(/`customer_type` = \?/);
    expect(q.sql).toMatch(/`hold_status` = \?/);
    expect(q.sql).toMatch(/`customer_hold_rules`\.`customer_id` is null/);
    expect(q.params).toEqual(expect.arrayContaining(["b2b", "active"]));
  });

  it("an explicit row still opts an on-hold / prepay account in", () => {
    const explicit = new Map([
      ["c-hold", { preset: "strict" as const, termsDays: 30, holdWhenInvoiceDaysOver: 30, minBalance: 0, autoStartLadder: false, autoReleaseOnPayment: true, notifyWarehouse: true, note: null }],
    ]);
    // c-hold is not a default candidate (filtered by SQL) but keeps its own rule.
    const m = buildEffectiveRules(explicit, [], { ...HOLDS_CONFIG_DEFAULTS, defaultRuleEnabled: true });
    expect(m.get("c-hold")).toMatchObject({ preset: "strict", source: "explicit" });
  });

  it("picker label: out-of-scope accounts are never shown as on the default rule", () => {
    expect(currentRuleLabel({ rule: null, defaultScope: false, holdStatus: "hold" }, true)).toBe("None (account on hold)");
    expect(currentRuleLabel({ rule: null, defaultScope: false, holdStatus: "payment_upfront" }, true)).toBe("None (payment upfront)");
    expect(currentRuleLabel({ rule: null, defaultScope: true, holdStatus: "active" }, true)).toBe("Default rule");
  });
});

describe('"Has no rule yet" source', () => {
  it("defaults to b2b only; allTypes drops the type filter", () => {
    const b2b = render(candidateWhere("no_rule"));
    expect(b2b.sql).toMatch(/`customer_type` = \?/);
    expect(b2b.params).toContain("b2b");
    const all = render(candidateWhere("no_rule", undefined, true));
    expect(all.sql).not.toMatch(/customer_type/);
    expect(all.sql).toMatch(/is null/);
  });
});
