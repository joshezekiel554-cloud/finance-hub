import { describe, expect, it } from "vitest";
import {
  buildChaseSignals,
  buildPromiseSignals,
  sortSignals,
  type ChaseFacts,
  type PromiseFacts,
} from "./finance-signals.js";

const now = new Date("2026-11-19T14:00:00Z");
const ctx = { now, baseUrl: "https://finance.example" };
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function chase(over: Partial<ChaseFacts> = {}): ChaseFacts {
  return {
    activityId: "act1",
    customerId: "cust1",
    customerName: "Keter Judaica",
    chasedAt: daysAgo(9),
    level: 2,
    messageId: "msg1",
    subject: "Feldart - follow-up on overdue balance ($2,400.00)",
    balance: 2400,
    lastInboundAt: null,
    lastPaymentDate: null,
    ...over,
  };
}

describe("buildChaseSignals", () => {
  it("nudges a quiet chase in the hub's pinned format", () => {
    const [s] = buildChaseSignals([chase()], ctx);
    expect(s).toEqual({
      key: "finance.chase-no-reply.cust1.msg1",
      kind: "chase-no-reply",
      severity: "high",
      title: "Keter Judaica: level 2 chase sent 2026-11-10, no reply and no payment ($2,400.00 open)",
      detail: 'Chase email: "Feldart - follow-up on overdue balance ($2,400.00)"',
      since: "2026-11-10T14:00:00.000Z",
      customer: { id: "cust1", name: "Keter Judaica" },
      amount: { value: 2400, currency: "USD" },
      links: [
        { label: "Keter Judaica in finance ($2,400.00 open)", url: "https://finance.example/customers/cust1" },
        { label: "Chase queue", url: "https://finance.example/chase" },
      ],
      dedupe: "customer:cust1",
    });
  });

  it("sends candidates from 5 calendar days (the hub applies 7 working days)", () => {
    expect(buildChaseSignals([chase({ chasedAt: daysAgo(4) })], ctx)).toHaveLength(0);
    expect(buildChaseSignals([chase({ chasedAt: daysAgo(5) })], ctx)).toHaveLength(1);
  });

  it("keeps keys within the contract's charset and length", () => {
    const [s] = buildChaseSignals([chase({ customerId: "a b/c", messageId: "x".repeat(300) })], ctx);
    expect(s!.key).toMatch(/^[A-Za-z0-9._:-]{1,200}$/);
  });

  it("stays quiet once the customer replied after the chase", () => {
    expect(buildChaseSignals([chase({ lastInboundAt: daysAgo(3) })], ctx)).toHaveLength(0);
    // a reply from BEFORE the chase doesn't count
    expect(buildChaseSignals([chase({ lastInboundAt: daysAgo(20) })], ctx)).toHaveLength(1);
  });

  it("stays quiet once a payment landed on or after the chase date", () => {
    expect(buildChaseSignals([chase({ lastPaymentDate: daysAgo(9) })], ctx)).toHaveLength(0);
    expect(buildChaseSignals([chase({ lastPaymentDate: daysAgo(2) })], ctx)).toHaveLength(0);
    expect(buildChaseSignals([chase({ lastPaymentDate: daysAgo(15) })], ctx)).toHaveLength(1);
  });

  it("ignores balances under $50", () => {
    expect(buildChaseSignals([chase({ balance: 49.99 })], ctx)).toHaveLength(0);
    expect(buildChaseSignals([chase({ balance: 50 })], ctx)).toHaveLength(1);
  });

  it("marks a level 1 reminder medium and falls back to the activity id", () => {
    const [s] = buildChaseSignals([chase({ level: null, messageId: null, subject: null })], ctx);
    expect(s!.severity).toBe("medium");
    expect(s!.title).toContain("level 1 chase");
    expect(s!.key).toBe("finance.chase-no-reply.cust1.act1");
    expect(s!.detail).toBeUndefined();
  });
});

function promise(over: Partial<PromiseFacts> = {}): PromiseFacts {
  return {
    orderId: "o1",
    orderNumber: "18926",
    customerId: "cust2",
    customerName: "Meoros Judaica",
    promisedBy: daysAgo(5),
    note: "paying Friday",
    balance: 1240,
    ...over,
  };
}

describe("buildPromiseSignals", () => {
  it("nudges a passed promise date on a held order", () => {
    const [s] = buildPromiseSignals([promise()], ctx);
    expect(s).toEqual({
      key: "finance.promise-missed.cust2.2026-11-14",
      kind: "promise-missed",
      severity: "high",
      title: "Meoros Judaica: promised payment by 2026-11-14, still unpaid ($1,240.00 open)",
      detail: 'Order 18926 is on hold; promise note: "paying Friday"',
      since: "2026-11-14T14:00:00.000Z",
      customer: { id: "cust2", name: "Meoros Judaica" },
      amount: { value: 1240, currency: "USD" },
      links: [{ label: "Meoros Judaica in finance (order 18926 on hold)", url: "https://finance.example/customers/cust2" }],
      dedupe: "customer:cust2",
    });
  });

  it("ignores promises still in the future and small balances", () => {
    expect(buildPromiseSignals([promise({ promisedBy: new Date(now.getTime() + 86_400_000) })], ctx)).toHaveLength(0);
    expect(buildPromiseSignals([promise({ balance: 10 })], ctx)).toHaveLength(0);
  });

  it("collapses several held orders with the same promise into one signal", () => {
    expect(buildPromiseSignals([promise(), promise({ orderId: "o2", orderNumber: "18927" })], ctx)).toHaveLength(1);
  });
});

describe("sortSignals", () => {
  it("puts high first, promises before chases, then bigger amounts", () => {
    const sorted = sortSignals([
      ...buildChaseSignals([chase({ customerId: "a", activityId: "a", level: 1, balance: 9000 })], ctx),
      ...buildChaseSignals([chase({ customerId: "b", activityId: "b", balance: 500 })], ctx),
      ...buildChaseSignals([chase({ customerId: "c", activityId: "c", balance: 5000 })], ctx),
      ...buildPromiseSignals([promise({ balance: 100 })], ctx),
    ]);
    expect(sorted.map((s) => s.key)).toEqual([
      "finance.promise-missed.cust2.2026-11-14",
      "finance.chase-no-reply.c.msg1",
      "finance.chase-no-reply.b.msg1",
      "finance.chase-no-reply.a.msg1",
    ]);
  });
});
