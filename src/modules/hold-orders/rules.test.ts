import { describe, expect, it } from "vitest";
import { PRESET_NUMBERS, describeRule, resolveHoldRule, type HoldRuleInput } from "./presets.js";
import { evaluateCustomerRule, invoiceAgeDays, ordersRuleWouldHold, type RuleInvoice, type RuleOrder } from "./rule-engine.js";
import { shouldAutoRelease } from "./auto-release.js";

const flags = { autoStartLadder: false, autoReleaseOnPayment: true, notifyWarehouse: true };
const now = new Date("2026-11-24T12:00:00Z");

function rule(input: Partial<HoldRuleInput> & Pick<HoldRuleInput, "preset">) {
  const r = resolveHoldRule({ ...flags, ...input });
  if (!r.ok) throw new Error(r.error);
  return r.rule;
}

function inv(daysOld: number, balance = 500, extra: Partial<RuleInvoice> = {}): RuleInvoice {
  const d = new Date(now.getTime() - daysOld * 86_400_000).toISOString().slice(0, 10);
  return { docNumber: `19${daysOld}`, issueDate: d, dueDate: null, balance, status: "overdue", origin: "feldart", ...extra };
}

describe("presets map to concrete numbers", () => {
  it("fixed presets", () => {
    expect(PRESET_NUMBERS.standard_30_45).toEqual({ termsDays: 30, holdWhenInvoiceDaysOver: 45, minBalance: 50 });
    expect(PRESET_NUMBERS.extended_60_75).toEqual({ termsDays: 60, holdWhenInvoiceDaysOver: 75, minBalance: 50 });
    expect(PRESET_NUMBERS.vip_90_110).toEqual({ termsDays: 90, holdWhenInvoiceDaysOver: 110, minBalance: 50 });
    expect(PRESET_NUMBERS.strict).toEqual({ termsDays: 30, holdWhenInvoiceDaysOver: 30, minBalance: 0 });
  });

  it("a preset ignores user numbers", () => {
    expect(rule({ preset: "vip_90_110", termsDays: 1, holdWhenInvoiceDaysOver: 2 })).toMatchObject({
      termsDays: 90,
      holdWhenInvoiceDaysOver: 110,
    });
  });

  it("custom validates", () => {
    expect(resolveHoldRule({ ...flags, preset: "custom", termsDays: 45, holdWhenInvoiceDaysOver: 30 }).ok).toBe(false);
    expect(resolveHoldRule({ ...flags, preset: "custom", termsDays: null, holdWhenInvoiceDaysOver: 30 }).ok).toBe(false);
    expect(rule({ preset: "custom", termsDays: 45, holdWhenInvoiceDaysOver: 60, minBalance: 200 })).toMatchObject({
      termsDays: 45,
      holdWhenInvoiceDaysOver: 60,
      minBalance: 200,
    });
  });

  it("describes rules", () => {
    expect(describeRule(rule({ preset: "vip_90_110" }))).toBe("VIP 90/110");
    expect(describeRule(rule({ preset: "custom", termsDays: 45, holdWhenInvoiceDaysOver: 60, minBalance: 200 }))).toBe(
      "Custom 45/60 (min $200)",
    );
  });
});

describe("rule engine", () => {
  const vip = rule({ preset: "vip_90_110" });

  it("operator example: terms 90, unpaid over 110 → hold", () => {
    const ev = evaluateCustomerRule(vip, [inv(112, 800), inv(20, 100)], now);
    expect(ev.wouldHold).toBe(true);
    expect(ev.why).toBe("Rule: VIP 90/110 — invoice 19112 at 112 days");
    expect(ev.openBalance).toBe(900);
  });

  it("exactly 110 days is not over the line", () => {
    expect(evaluateCustomerRule(vip, [inv(110)], now).wouldHold).toBe(false);
  });

  it("ignores 2030 placeholders, TJ book, void/paid, disputes, zero balances", () => {
    const ev = evaluateCustomerRule(
      vip,
      [
        { ...inv(200), issueDate: "2030-01-01" },
        inv(200, 500, { origin: "tj" }),
        inv(200, 500, { status: "void" }),
        inv(200, 500, { status: "paid" }),
        inv(200, 500, { disputeState: "verifying" }),
        inv(200, 0),
      ],
      now,
    );
    expect(ev.wouldHold).toBe(false);
    expect(ev.hits).toEqual([]);
  });

  it("min balance gates the hold", () => {
    expect(evaluateCustomerRule(rule({ preset: "standard_30_45" }), [inv(60, 20)], now).wouldHold).toBe(false);
    expect(evaluateCustomerRule(rule({ preset: "strict" }), [inv(31, 1)], now).wouldHold).toBe(true);
  });

  it("never holds nothing", () => {
    expect(evaluateCustomerRule(rule({ preset: "never" }), [inv(400, 9999)], now).wouldHold).toBe(false);
  });

  it("age falls back to due date minus terms", () => {
    const due = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    expect(invoiceAgeDays({ issueDate: null, dueDate: due }, 90, now)).toBe(120);
  });

  it("only never-held, open orders are newly held (released orders stay released)", () => {
    const ev = evaluateCustomerRule(vip, [inv(120)], now);
    const base: RuleOrder = {
      orderId: "a",
      orderNumber: "#1",
      total: "1",
      holdState: "none",
      cancelledAt: null,
      fulfillmentStatus: "unfulfilled",
      shipmentStatus: null,
    };
    const list: RuleOrder[] = [
      base,
      { ...base, orderId: "released", holdState: "released" },
      { ...base, orderId: "held", holdState: "on_hold" },
      { ...base, orderId: "shipped", fulfillmentStatus: "fulfilled" },
      { ...base, orderId: "cancelled", cancelledAt: now },
      { ...base, orderId: "delivered", shipmentStatus: "delivered" },
    ];
    expect(ordersRuleWouldHold(ev, list).map((o) => o.orderId)).toEqual(["a"]);
    expect(ordersRuleWouldHold(evaluateCustomerRule(vip, [inv(10)], now), list)).toEqual([]);
  });
});

describe("auto-release with rules", () => {
  const on = { preset: "vip_90_110", autoReleaseOnPayment: true };
  const off = { preset: "vip_90_110", autoReleaseOnPayment: false };

  it("no rule → unchanged standard behaviour", () => {
    expect(shouldAutoRelease({ reason: "overdue_non_communicating", rule: null, standardStillApplies: false, ruleStillHolds: true })).toBe(true);
    expect(shouldAutoRelease({ reason: "manual", rule: null, standardStillApplies: true, ruleStillHolds: true })).toBe(false);
  });

  it("customer_rule releases once the rule no longer holds them", () => {
    expect(shouldAutoRelease({ reason: "customer_rule", rule: on, standardStillApplies: true, ruleStillHolds: false })).toBe(true);
    expect(shouldAutoRelease({ reason: "customer_rule", rule: on, standardStillApplies: true, ruleStillHolds: true })).toBe(false);
  });

  it("switch off → payment-driven holds never auto-release", () => {
    expect(shouldAutoRelease({ reason: "customer_rule", rule: off, standardStillApplies: false, ruleStillHolds: false })).toBe(false);
    expect(shouldAutoRelease({ reason: "overdue_non_communicating", rule: off, standardStillApplies: false, ruleStillHolds: false })).toBe(false);
    expect(shouldAutoRelease({ reason: "payment_upfront_unpaid", rule: off, standardStillApplies: false, ruleStillHolds: false })).toBe(false);
    // Taking the account off hold is a human decision — still clears.
    expect(shouldAutoRelease({ reason: "customer_on_hold", rule: off, standardStillApplies: false, ruleStillHolds: false })).toBe(true);
  });

  it("rule deleted / set to never → a customer_rule hold waits for a person", () => {
    expect(shouldAutoRelease({ reason: "customer_rule", rule: null, standardStillApplies: true, ruleStillHolds: false })).toBe(false);
    expect(
      shouldAutoRelease({ reason: "customer_rule", rule: { preset: "never", autoReleaseOnPayment: true }, standardStillApplies: true, ruleStillHolds: false }),
    ).toBe(false);
  });
});
