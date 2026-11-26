import { describe, expect, it } from "vitest";
import { PRESET_NUMBERS, describeRule, normalisePreset, resolveHoldRule, type HoldRuleInput } from "./presets.js";
import {
  customerBalances,
  evaluateCustomerRule,
  invoiceDaysOverdue,
  ordersRuleWouldHold,
  type RuleInvoice,
  type RuleOrder,
} from "./rule-engine.js";
import { parseTermsDays, termsLine } from "./terms.js";
import { shouldAutoRelease } from "./auto-release.js";

const flags = { autoStartLadder: false, autoReleaseOnPayment: true, notifyWarehouse: true };
const now = new Date("2026-11-24T12:00:00Z");
const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);

function rule(input: Partial<HoldRuleInput> & Pick<HoldRuleInput, "preset">) {
  const r = resolveHoldRule({ ...flags, ...input });
  if (!r.ok) throw new Error(r.error);
  return r.rule;
}

/** An invoice `overdue` days past its due date (negative = not yet due). */
function inv(overdue: number, balance = 500, extra: Partial<RuleInvoice> = {}): RuleInvoice {
  return {
    docNumber: `19${Math.abs(overdue)}`,
    issueDate: day(overdue + 30),
    dueDate: day(overdue),
    balance,
    status: "overdue",
    origin: "feldart",
    ...extra,
  };
}

describe("presets are grace periods (days past due)", () => {
  it("built-in numbers", () => {
    expect(PRESET_NUMBERS.strict).toEqual({ graceDays: 0, minOverdue: 50 });
    expect(PRESET_NUMBERS.standard).toEqual({ graceDays: 15, minOverdue: 50 });
    expect(PRESET_NUMBERS.relaxed).toEqual({ graceDays: 30, minOverdue: 50 });
  });

  it("a preset ignores user numbers", () => {
    expect(rule({ preset: "relaxed", graceDays: 1, minOverdue: 2 })).toMatchObject({ graceDays: 30, minOverdue: 50 });
  });

  it("custom validates", () => {
    expect(resolveHoldRule({ ...flags, preset: "custom", graceDays: null }).ok).toBe(false);
    expect(resolveHoldRule({ ...flags, preset: "custom", graceDays: -1 }).ok).toBe(false);
    expect(resolveHoldRule({ ...flags, preset: "custom", graceDays: 366 }).ok).toBe(false);
    expect(resolveHoldRule({ ...flags, preset: "custom", graceDays: 20, minOverdue: -5 }).ok).toBe(false);
    expect(rule({ preset: "custom", graceDays: 20, minOverdue: 200 })).toMatchObject({ graceDays: 20, minOverdue: 200 });
    // Blank minimum → the default.
    expect(rule({ preset: "custom", graceDays: 20 })).toMatchObject({ minOverdue: 50 });
  });

  it("describes rules", () => {
    expect(describeRule(rule({ preset: "standard" }))).toBe("Standard — 15 days overdue");
    expect(describeRule(rule({ preset: "strict" }))).toBe("Strict — hold as soon as overdue");
    expect(describeRule(rule({ preset: "custom", graceDays: 20, minOverdue: 200 }))).toBe("Custom — 20 days overdue (min $200)");
    expect(describeRule({ ...rule({ preset: "standard" }), source: "default" })).toBe(
      "Default b2b rule (Standard — 15 days overdue)",
    );
  });

  it("legacy preset names map to the new ones", () => {
    expect(normalisePreset("standard_30_45")).toBe("standard");
    expect(normalisePreset("extended_60_75")).toBe("standard");
    expect(normalisePreset("relaxed")).toBe("relaxed");
    expect(normalisePreset("bogus")).toBeNull();
    expect(normalisePreset("")).toBeNull();
  });
});

describe("terms (read-only, from the finance customer record)", () => {
  it("parses", () => {
    expect(parseTermsDays("Net 60")).toBe(60);
    expect(parseTermsDays(" net30 ")).toBe(30);
    expect(parseTermsDays("Due on Receipt")).toBe(0);
    expect(parseTermsDays(null)).toBeNull();
    expect(parseTermsDays("Weekly")).toBeNull();
  });

  it("the operator's line: Net 60 → holds at day 75 (15 days overdue)", () => {
    expect(termsLine("Net 60", { preset: "standard", graceDays: 15 })).toEqual({
      known: true,
      text: "Net 60 · holds at day 75 (15 days overdue)",
    });
    expect(termsLine("Net 30", { preset: "strict", graceDays: 0 }).text).toBe("Net 30 · holds at day 30 (as soon as overdue)");
    expect(termsLine("Net 90", { preset: "never", graceDays: 0 }).text).toBe("Net 90 · never held automatically");
    expect(termsLine("Net 45", null).text).toBe("Net 45");
  });

  it("missing terms are flagged", () => {
    expect(termsLine(null, null)).toEqual({ known: false, text: "Terms not set" });
    expect(termsLine("", { preset: "standard", graceDays: 15 })).toEqual({
      known: false,
      text: "Terms not set · holds 15 days overdue",
    });
  });
});

describe("rule engine (overdue-based)", () => {
  const standard = rule({ preset: "standard" });

  it("holds once an invoice is more than the grace days past due", () => {
    const ev = evaluateCustomerRule(standard, [inv(22, 800), inv(-5, 100)], now, { days: 30, label: "Net 30" });
    expect(ev.wouldHold).toBe(true);
    expect(ev.why).toBe("Rule: Standard — 15 days overdue — invoice 1922 is 22 days overdue (Net 30)");
    expect(ev.openBalance).toBe(900);
    expect(ev.overdueBalance).toBe(800);
  });

  it("exactly at the grace line is not over it", () => {
    expect(evaluateCustomerRule(standard, [inv(15)], now).wouldHold).toBe(false);
    expect(evaluateCustomerRule(standard, [inv(16)], now).wouldHold).toBe(true);
  });

  it("counts from the DUE date, not the invoice date: 70 days old on Net 60 = 10 days overdue", () => {
    const i: RuleInvoice = { docNumber: "1", issueDate: day(70), dueDate: day(10), balance: 500, status: "open", origin: "feldart" };
    expect(evaluateCustomerRule(standard, [i], now).wouldHold).toBe(false);
    expect(evaluateCustomerRule(rule({ preset: "custom", graceDays: 5 }), [i], now).wouldHold).toBe(true);
  });

  it("the minimum is on the OVERDUE amount, not the total", () => {
    // $40 overdue + $5,000 not yet due → under the $50 minimum.
    const ev = evaluateCustomerRule(standard, [inv(40, 40), inv(-10, 5000)], now);
    expect(ev.overdueBalance).toBe(40);
    expect(ev.wouldHold).toBe(false);
    expect(evaluateCustomerRule(rule({ preset: "custom", graceDays: 15, minOverdue: 0 }), [inv(40, 40)], now).wouldHold).toBe(true);
  });

  it("ignores 2030 placeholders, TJ book, void/paid, disputes, zero balances", () => {
    const ev = evaluateCustomerRule(
      standard,
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

  it("never holds nothing (but still reports balances)", () => {
    const ev = evaluateCustomerRule(rule({ preset: "never" }), [inv(400, 9999)], now);
    expect(ev.wouldHold).toBe(false);
    expect(ev.overdueBalance).toBe(9999);
  });

  it("no due date → issue date + the customer's terms; no terms either → not overdue", () => {
    expect(invoiceDaysOverdue({ issueDate: day(100), dueDate: null }, 60, now)).toBe(40);
    expect(invoiceDaysOverdue({ issueDate: day(100), dueDate: null }, null, now)).toBeNull();
    expect(customerBalances([{ ...inv(0), issueDate: day(100), dueDate: null }], null, now)).toEqual({
      openBalance: 500,
      overdueBalance: 0,
    });
  });

  it("only never-held, open orders are newly held (released orders stay released)", () => {
    const ev = evaluateCustomerRule(standard, [inv(40)], now);
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
    expect(ordersRuleWouldHold(evaluateCustomerRule(standard, [inv(3)], now), list)).toEqual([]);
  });
});

describe("auto-release with rules", () => {
  const on = { preset: "relaxed", autoReleaseOnPayment: true };
  const off = { preset: "relaxed", autoReleaseOnPayment: false };

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
