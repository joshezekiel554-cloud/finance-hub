// Rules apply to customers with an explicit rule, plus (only when switched on
// in Settings) b2b customers without one via the default rule. The detection
// job loads the effective rules first and evaluates/holds only those.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rules: new Map<string, Record<string, unknown>>(),
  // b2b customers with no explicit row (default-rule scope).
  defaultIds: [] as string[],
  settings: {} as Record<string, string>,
  invoiceCalls: [] as string[][],
  orderCalls: [] as string[][],
  updates: [] as Array<Record<string, unknown>>,
  transitions: [] as Array<Record<string, unknown>>,
  sends: [] as Array<Record<string, unknown>>,
  // The DB row's state as the conditional UPDATE sees it: how many claims of
  // "o-new" (hold_state='none') can still succeed.
  claimable: 1,
  promisedPayBy: null as string | null,
}));

vi.mock("../../lib/env.js", () => ({ env: { SHADOW_MODE: false, PUBLIC_URL: "https://finance.example" } }));
vi.mock("../../db/index.js", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (v: unknown) => void) =>
      resolve([{ id: "c-rule", name: "Rule Co", promisedPayBy: h.promisedPayBy }]),
  };
  return {
    db: {
      select: () => chain,
      update: () => ({
        set: (s: Record<string, unknown>) => {
          h.updates.push(s);
          let n = 1;
          if ("holdState" in s) {
            n = h.claimable > 0 ? 1 : 0;
            if (n) h.claimable -= 1;
          }
          // Yield like a real round-trip so concurrent passes interleave.
          return { where: () => new Promise((res) => setTimeout(() => res([{ affectedRows: n }, []]), 0)) };
        },
      }),
    },
  };
});
vi.mock("../statements/settings.js", () => ({
  loadAppSettings: vi.fn(async () => ({
    order_hold_warehouse_recipients: "wh@x.example",
    order_hold_team_recipients: "",
    ...h.settings,
  })),
}));
vi.mock("../orders/hold-alerts.js", () => ({
  recordHoldTransition: vi.fn(async (a: Record<string, unknown>) => {
    h.transitions.push(a);
  }),
}));
vi.mock("../../integrations/gmail/send.js", () => ({
  sendEmail: vi.fn(async (a: Record<string, unknown>) => {
    h.sends.push(a);
    return { threadId: "t", messageId: "m" };
  }),
}));
vi.mock("./rules-store.js", () => ({
  // Real precedence logic over the fake rows: explicit wins, default only when on.
  loadEffectiveRules: vi.fn(async (config: import("./holds-settings.js").HoldsConfig) => {
    const { buildEffectiveRules } = await import("./effective-rules.js");
    return buildEffectiveRules(
      h.rules as unknown as Map<string, import("./presets.js").ResolvedHoldRule>,
      h.defaultIds,
      config,
    );
  }),
  loadOpenInvoices: vi.fn(async (ids: string[]) => {
    h.invoiceCalls.push(ids);
    return new Map([
      ["c-rule", [{ docNumber: "19310", issueDate: "2026-07-01", dueDate: null, balance: "900", status: "overdue", origin: "feldart" }]],
    ]);
  }),
  loadCandidateOrders: vi.fn(async (ids: string[]) => {
    h.orderCalls.push(ids);
    const o = { orderNumber: "#1", shopifyOrderId: "1", total: "10", cancelledAt: null, fulfillmentStatus: null, shipmentStatus: null, orderDate: null };
    return new Map([
      ["c-rule", [{ ...o, orderId: "o-new", customerId: "c-rule", holdState: "none" }, { ...o, orderId: "o-rel", customerId: "c-rule", holdState: "released" }]],
    ]);
  }),
}));

import { runCustomerRuleHolds } from "./detection.js";

const now = new Date("2026-11-24T12:00:00Z");
const vip = { preset: "vip_90_110", termsDays: 90, holdWhenInvoiceDaysOver: 110, minBalance: 50, autoStartLadder: true, autoReleaseOnPayment: true, notifyWarehouse: false, note: null };

beforeEach(() => {
  h.rules = new Map();
  h.invoiceCalls.length = 0;
  h.orderCalls.length = 0;
  h.updates.length = 0;
  h.transitions.length = 0;
  h.sends.length = 0;
  h.claimable = 1;
  h.promisedPayBy = null;
  h.defaultIds = [];
  h.settings = {};
});

describe("runCustomerRuleHolds", () => {
  it("no explicit rules, default rule off → touches nothing", async () => {
    const r = await runCustomerRuleHolds(now);
    expect(r).toEqual({ ruleCustomers: 0, held: 0, alerted: 0 });
    expect(h.invoiceCalls).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("'never' rules are not evaluated", async () => {
    h.rules = new Map([["c-never", { ...vip, preset: "never" }]]);
    await runCustomerRuleHolds(now);
    expect(h.invoiceCalls).toEqual([]);
  });

  it("evaluates only rule customers; holds their never-held open orders with reason customer_rule", async () => {
    h.rules = new Map([["c-rule", vip]]);
    const r = await runCustomerRuleHolds(now);
    expect(h.invoiceCalls).toEqual([["c-rule"]]);
    expect(h.orderCalls).toEqual([["c-rule"]]);
    expect(r.held).toBe(1);
    expect(h.updates[0]).toMatchObject({ holdState: "on_hold", holdReason: "customer_rule", holdLadderEnabled: true });
    expect(String(h.updates[0]?.holdNote)).toMatch(/^Rule: VIP 90\/110 — invoice 19310 at \d+ days$/);
    // notify_warehouse=false → nobody emailed
    expect(h.sends).toEqual([]);
    expect(h.transitions[0]).toMatchObject({ orderId: "o-new", after: { mode: "record_only", via: "customer_rule" } });
  });

  it("notify_warehouse=true → standard warehouse alert", async () => {
    h.rules = new Map([["c-rule", { ...vip, notifyWarehouse: true }]]);
    const r = await runCustomerRuleHolds(now);
    expect(r.alerted).toBe(1);
    expect(h.sends[0]).toMatchObject({ to: "wh@x.example", financeSendType: "hold-alert" });
    // claim first (no thread yet), then the thread stamp after the send
    expect(h.updates[0]).toMatchObject({ holdState: "on_hold", holdAlertThreadId: null });
    expect(h.updates[1]).toMatchObject({ holdAlertThreadId: "t", holdAlertMessageId: "m" });
  });
});

describe("claim-then-send", () => {
  it("two concurrent passes → exactly one warehouse email and one audit row", async () => {
    h.rules = new Map([["c-rule", { ...vip, notifyWarehouse: true }]]);
    const [a, b] = await Promise.all([runCustomerRuleHolds(now), runCustomerRuleHolds(now)]);
    expect(a.held + b.held).toBe(1);
    expect(h.sends).toHaveLength(1);
    expect(h.transitions).toHaveLength(1);
  });

  it("a manual hold/release between load and update → the rule pass does nothing", async () => {
    h.rules = new Map([["c-rule", { ...vip, notifyWarehouse: true }]]);
    h.claimable = 0; // the row is no longer hold_state='none'
    const r = await runCustomerRuleHolds(now);
    expect(r).toMatchObject({ held: 0, alerted: 0 });
    expect(h.sends).toEqual([]);
    expect(h.transitions).toEqual([]);
  });
});

describe("H9 switch (Settings holds_rule_holds_respect_promise): active promise blocks new rule holds", () => {
  it("default off: a promise doesn't stop the rule hold", async () => {
    h.rules = new Map([["c-rule", vip]]);
    h.promisedPayBy = "2099-01-01";
    expect((await runCustomerRuleHolds(now)).held).toBe(1);
  });
  it("explicitly off", async () => {
    h.rules = new Map([["c-rule", vip]]);
    h.promisedPayBy = "2099-01-01";
    h.settings = { holds_rule_holds_respect_promise: "false" };
    expect((await runCustomerRuleHolds(now)).held).toBe(1);
  });
  it("on: customer with an active promise is skipped", async () => {
    h.rules = new Map([["c-rule", vip]]);
    h.promisedPayBy = "2099-01-01";
    h.settings = { holds_rule_holds_respect_promise: "true" };
    expect((await runCustomerRuleHolds(now)).held).toBe(0);
    expect(h.updates).toEqual([]);
  });
});

describe("default b2b rule (Settings)", () => {
  it("off (ships off): a rule-less b2b customer is never evaluated or held", async () => {
    h.defaultIds = ["c-rule"];
    const r = await runCustomerRuleHolds(now);
    expect(r).toEqual({ ruleCustomers: 0, held: 0, alerted: 0 });
    expect(h.invoiceCalls).toEqual([]);
  });

  it("on: the rule-less b2b customer is held as if they had the default preset", async () => {
    h.defaultIds = ["c-rule"];
    h.settings = { holds_default_rule_enabled: "true", holds_default_rule_preset: "standard_30_45" };
    const r = await runCustomerRuleHolds(now);
    expect(r.held).toBe(1);
    expect(String(h.updates[0]?.holdNote)).toMatch(/^Rule: Default b2b rule \(Standard 30\/45\) — invoice 19310 at \d+ days$/);
    // default flags: warehouse emailed, customer ladder off
    expect(h.updates[0]).toMatchObject({ holdLadderEnabled: false });
    expect(h.sends).toHaveLength(1);
  });

  it("an explicit 'never' row wins over the default", async () => {
    h.rules = new Map([["c-rule", { ...vip, preset: "never" }]]);
    h.defaultIds = ["c-rule"];
    h.settings = { holds_default_rule_enabled: "true" };
    const r = await runCustomerRuleHolds(now);
    expect(r.held).toBe(0);
    expect(h.invoiceCalls).toEqual([]);
  });

  it("an explicit preset row wins over the default (its own preset applies)", async () => {
    h.rules = new Map([["c-rule", vip]]);
    h.defaultIds = ["c-rule"];
    h.settings = { holds_default_rule_enabled: "true", holds_default_rule_preset: "strict" };
    await runCustomerRuleHolds(now);
    expect(String(h.updates[0]?.holdNote)).toMatch(/^Rule: VIP 90\/110/);
  });

  it("the default follows edited preset numbers (Standard 30/200 → invoice at 146 days not held)", async () => {
    h.defaultIds = ["c-rule"];
    h.settings = {
      holds_default_rule_enabled: "true",
      holds_preset_overrides: JSON.stringify({ standard_30_45: { termsDays: 30, holdWhenInvoiceDaysOver: 200, minBalance: 50 } }),
    };
    expect((await runCustomerRuleHolds(now)).held).toBe(0);
  });
});

describe("rule lookback window (Settings holds_rule_order_lookback_days)", () => {
  it("passes the configured window to the candidate-order loader", async () => {
    const store = await import("./rules-store.js");
    const spy = vi.mocked(store.loadCandidateOrders);
    spy.mockClear();
    h.rules = new Map([["c-rule", vip]]);
    h.settings = { holds_rule_order_lookback_days: "14" };
    await runCustomerRuleHolds(now);
    expect(spy.mock.calls[0]?.[2]).toBe(14);
  });
});
