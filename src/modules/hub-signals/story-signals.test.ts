// Phase-3 signals: pay-slipping, big-order-overdue, reorder-due,
// season-missed, plus the email/tag enrichment every signal gets.

import { describe, expect, it } from "vitest";
import {
  buildBigOrderSignals,
  buildChaseSignals,
  buildPaySlippingSignals,
  buildReorderSignals,
  buildSeasonMissedSignals,
  enrichSignals,
  isUsCustomer,
  signalContractProblems,
  sortSignals,
  type BigOrderFacts,
  type PaySlipFacts,
  type ReorderFacts,
  type Signal,
} from "./finance-signals.js";
import { addDaysYmd, type Money } from "../hub-stories/story.js";

const now = new Date("2026-11-19T14:00:00Z");
const ctx = { now, baseUrl: "https://finance.example" };
const TODAY = "2026-11-19";

const money = (over: Partial<Money> = {}): Money => ({
  balance: 3_000,
  overdue: 2_400,
  oldestOverdueDays: 40,
  oldestOverdueAgeDays: 70,
  book: { feldart: { balance: 3_000, overdue: 2_400 }, tj: { balance: 0, overdue: 0 } },
  ...over,
});

function slip(over: Partial<PaySlipFacts> = {}): PaySlipFacts {
  return {
    customerId: "cust1",
    customerName: "Keter Judaica",
    money: money(),
    pay: { usualDaysToPay: 45, onTimePct: 60, invoicesPaid2y: 8, recentDaysToPay: 50, trend: "slipping" },
    promisedPayBy: null,
    ...over,
  };
}

const ok = (signals: Signal[]) => {
  for (const s of signals) expect(signalContractProblems(s, ctx.baseUrl)).toEqual([]);
  return signals;
};

describe("buildPaySlippingSignals", () => {
  it("nudges when the oldest overdue is > 1.5× usual and ≥ usual + 20 (monthly key)", () => {
    const [s] = ok(buildPaySlippingSignals([slip()], ctx));
    expect(s).toMatchObject({
      key: "finance.pay-slipping.cust1.2026-11",
      kind: "pay-slipping",
      severity: "high",
      title: "Keter Judaica: usually pays in 45 days, oldest invoice now 70 days ($2,400.00 overdue)",
      amount: { value: 2400, currency: "USD" },
      dedupe: "customer:cust1",
    });
    // Crossed the line at day max(68, 65) = 68 → 2 days ago.
    expect(s!.since).toBe(`${addDaysYmd(TODAY, -2)}T00:00:00.000Z`);
  });

  it("medium under $1,000 overdue", () => {
    expect(buildPaySlippingSignals([slip({ money: money({ overdue: 600 }) })], ctx)[0]?.severity).toBe("medium");
  });

  it("quiet: not late enough, < 4 paid, small balance, active promise", () => {
    expect(buildPaySlippingSignals([slip({ money: money({ oldestOverdueAgeDays: 64 }) })], ctx)).toEqual([]); // < 45 + 20
    expect(buildPaySlippingSignals([slip({ pay: { ...slip().pay, invoicesPaid2y: 3 } })], ctx)).toEqual([]);
    expect(buildPaySlippingSignals([slip({ money: money({ balance: 40 }) })], ctx)).toEqual([]);
    expect(buildPaySlippingSignals([slip({ promisedPayBy: "2026-11-25" })], ctx)).toEqual([]);
    expect(buildPaySlippingSignals([slip({ promisedPayBy: "2026-11-01" })], ctx)).toHaveLength(1);
  });
});

function big(over: Partial<BigOrderFacts> = {}): BigOrderFacts {
  return {
    orderId: "ord9",
    orderNumber: "#18926",
    orderDate: new Date("2026-11-17T10:00:00Z"),
    orderTotal: 1_850,
    customerId: "cust1",
    customerName: "Meoros",
    money: money({ overdue: 900, oldestOverdueDays: 45 }),
    ...over,
  };
}

describe("buildBigOrderSignals", () => {
  it("flags a big new order from a customer well overdue", () => {
    const [s] = ok(buildBigOrderSignals([big()], ctx));
    expect(s).toMatchObject({
      key: "finance.big-order-overdue.cust1.ord9",
      kind: "big-order-overdue",
      severity: "high",
      title: "Meoros: new order #18926 for $1,850.00 while $900.00 is overdue (oldest 45 days past due)",
      since: "2026-11-17T10:00:00.000Z",
    });
    expect(s!.links[0]!.url).toBe("https://finance.example/customers/cust1?tab=orders");
  });

  it("quiet for small orders, old orders, small or young overdue", () => {
    expect(buildBigOrderSignals([big({ orderTotal: 999 })], ctx)).toEqual([]);
    expect(buildBigOrderSignals([big({ orderDate: new Date("2026-11-11T10:00:00Z") })], ctx)).toEqual([]);
    expect(buildBigOrderSignals([big({ money: money({ overdue: 499, oldestOverdueDays: 45 }) })], ctx)).toEqual([]);
    expect(buildBigOrderSignals([big({ money: money({ overdue: 900, oldestOverdueDays: 29 }) })], ctx)).toEqual([]);
  });
});

function reorder(over: Partial<ReorderFacts> = {}): ReorderFacts {
  // Every ~42 days, last one 68 days ago.
  const days = [68 + 126, 68 + 84, 68 + 42, 68].map((n) => ({ date: addDaysYmd(TODAY, -n), total: 1_240 }));
  return { customerId: "cust2", customerName: "Keter", country: null, customerType: "b2b", holdStatus: "active", days, ...over };
}

describe("buildReorderSignals", () => {
  it("fires past 1.5× the usual gap", () => {
    const [s] = ok(buildReorderSignals([reorder()], ctx));
    expect(s).toMatchObject({
      key: `finance.reorder-due.cust2.${addDaysYmd(TODAY, -68)}`,
      kind: "reorder-due",
      severity: "info",
      title: "Keter usually orders every ~42 days; it's been 68 (avg order $1,240)",
      amount: { value: 1240, currency: "USD" },
      tags: { group: "sales", usualGapDays: 42, daysSince: 68, orders2y: 4 },
    });
  });

  it("quiet: within rhythm, non-US, B2C, on hold, < 4 orders, lapsed > a year", () => {
    const within = reorder({ days: reorder().days.map((d) => ({ ...d, date: addDaysYmd(d.date, 20) })) }); // 48 days
    expect(buildReorderSignals([within], ctx)).toEqual([]);
    expect(buildReorderSignals([reorder({ country: "United Kingdom" })], ctx)).toEqual([]);
    expect(buildReorderSignals([reorder({ customerType: "b2c" })], ctx)).toEqual([]);
    expect(buildReorderSignals([reorder({ holdStatus: "hold" })], ctx)).toEqual([]);
    expect(buildReorderSignals([reorder({ days: reorder().days.slice(1) })], ctx)).toEqual([]);
    const lapsed = reorder({ days: reorder().days.map((d) => ({ ...d, date: addDaysYmd(d.date, -330) })) });
    expect(buildReorderSignals([lapsed], ctx)).toEqual([]);
  });

  it("the 14-day floor holds for fast reorderers", () => {
    const fast = [30, 25, 20, 15, 10].map((n) => ({ date: addDaysYmd(TODAY, -n), total: 100 })); // gap 5, 10 days since
    expect(buildReorderSignals([reorder({ days: fast })], ctx)).toEqual([]);
  });

  it("isUsCustomer", () => {
    for (const c of [null, "", "US", "U.S.", "USA", "United States"]) expect(isUsCustomer(c)).toBe(true);
    for (const c of ["UK", "Canada", "Israel"]) expect(isUsCustomer(c)).toBe(false);
  });
});

describe("buildSeasonMissedSignals", () => {
  it("one info signal per customer + season + year", () => {
    const [s] = ok(
      buildSeasonMissedSignals(
        [{ customerId: "cust3", customerName: "Judaica Plus", season: "Rosh Hashanah", year: 2027, windowStart: "2027-06-11", windowEnd: "2027-10-10", pastYears: [2026, 2025, 2024], avgSpend: 850 }],
        ctx,
      ),
    );
    expect(s).toMatchObject({
      key: "finance.season-missed.cust3.Rosh_Hashanah.2027",
      severity: "info",
      title: "Judaica Plus: bought Rosh Hashanah stock the last 3 seasons (2024, 2025, 2026); nothing yet for 2027",
      since: "2027-04-30T00:00:00.000Z",
      amount: { value: 850, currency: "USD" },
    });
  });
});

describe("enrichSignals", () => {
  it("adds email to all, pay/promise tags to money signals only, within 8 tags", () => {
    const chase = buildChaseSignals(
      [{ activityId: "a", customerId: "cust1", customerName: "K", chasedAt: new Date("2026-11-05T10:00:00Z"), level: 1, messageId: "m", subject: null, balance: 500, lastInboundAt: null, lastPaymentDate: null }],
      ctx,
    );
    const sales = buildReorderSignals([reorder({ customerId: "cust1" })], ctx);
    const out = enrichSignals([...chase, ...sales], new Map([["cust1", { email: "Ap@Keter.COM", payUsualDays: 41, promiseRecord: "2/3" }]]));
    ok(out);
    expect(out[0]!.customer.email).toBe("ap@keter.com");
    expect(out[0]!.tags).toMatchObject({ payUsualDays: 41, promiseRecord: "2/3" });
    expect(out[1]!.customer.email).toBe("ap@keter.com");
    expect(out[1]!.tags).not.toHaveProperty("payUsualDays");

    const full = { ...chase[0]!, tags: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 } };
    const [e] = enrichSignals([full], new Map([["cust1", { payUsualDays: 41, promiseRecord: "2/3" }]]));
    expect(Object.keys(e!.tags!)).toHaveLength(8);
    expect(e!.tags).toHaveProperty("payUsualDays", 41);
    expect(e!.customer.email).toBeUndefined();
  });

  it("the contract refuses a non-lower-case or malformed email", () => {
    const s = buildReorderSignals([reorder()], ctx)[0]!;
    expect(signalContractProblems({ ...s, customer: { ...s.customer, email: "A@b.com" } }, ctx.baseUrl)).toContain("customer-email");
    expect(signalContractProblems({ ...s, customer: { ...s.customer, email: "nope" } }, ctx.baseUrl)).toContain("customer-email");
    expect(signalContractProblems({ ...s, tags: { season: "x".repeat(61) } }, ctx.baseUrl)).toContain("tag-value");
  });
});

describe("sortSignals (phase 3 kinds)", () => {
  it("money before sales; big orders right after missed promises", () => {
    const sorted = sortSignals([...buildReorderSignals([reorder()], ctx), ...buildPaySlippingSignals([slip()], ctx), ...buildBigOrderSignals([big()], ctx)]);
    expect(sorted.map((s) => s.kind)).toEqual(["big-order-overdue", "pay-slipping", "reorder-due"]);
  });
});
