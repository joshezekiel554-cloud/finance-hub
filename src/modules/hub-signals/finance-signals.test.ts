import { describe, expect, it } from "vitest";
import {
  buildChaseSignals,
  buildPromiseSignals,
  sortSignals,
  type ChaseFacts,
  type PromiseFacts,
} from "./finance-signals.js";

const now = new Date("2026-11-19T14:00:00Z");
const ctx = { now, baseUrl: "https://finance.example", audience: ["josh@x.com", "shaya@x.com"] };
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function chase(over: Partial<ChaseFacts> = {}): ChaseFacts {
  return {
    activityId: "act1",
    customerId: "cust1",
    customerName: "Keter Judaica",
    chasedAt: daysAgo(9),
    level: 2,
    threadId: "thr1",
    subject: "Feldart - follow-up on overdue balance ($2,400.00)",
    balance: 2400,
    lastInboundAt: null,
    lastPaymentDate: null,
    ...over,
  };
}

describe("buildChaseSignals", () => {
  it("nudges a chase that's 7+ days old with no reply and no payment", () => {
    const [s] = buildChaseSignals([chase()], ctx);
    expect(s).toMatchObject({
      key: "finance.chase-no-response.cust1.act1",
      kind: "chase-no-response",
      severity: "high",
      since: "2026-11-10",
      customer: { name: "Keter Judaica", id: "cust1" },
      amount: { value: 2400, currency: "USD" },
      actions: ["open", "draft-follow-up"],
      audience: ["josh@x.com", "shaya@x.com"],
    });
    expect(s!.title).toBe("Keter Judaica: level 2 chase sent 9 days ago, no reply and no payment ($2,400.00 open)");
    expect(s!.evidence[0]!.link).toBe("https://mail.google.com/mail/u/0/#all/thr1");
    expect(s!.evidence[1]!.link).toBe("https://finance.example/customers/cust1");
  });

  it("waits until 7 days have passed", () => {
    expect(buildChaseSignals([chase({ chasedAt: daysAgo(6) })], ctx)).toHaveLength(0);
    expect(buildChaseSignals([chase({ chasedAt: daysAgo(7) })], ctx)).toHaveLength(1);
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

  it("marks a level 1 reminder medium and copes with missing thread/level", () => {
    const [s] = buildChaseSignals([chase({ level: null, threadId: null })], ctx);
    expect(s!.severity).toBe("medium");
    expect(s!.title).toContain("level 1 chase");
    expect(s!.evidence[0]!.link).toBeUndefined();
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
    expect(s).toMatchObject({
      key: "finance.promise-missed.cust2.2026-11-14",
      kind: "promise-missed",
      severity: "high",
      since: "2026-11-14",
      amount: { value: 1240, currency: "USD" },
    });
    expect(s!.title).toBe('Meoros Judaica promised payment by 2026-11-14 ("paying Friday"); still unpaid ($1,240.00 open)');
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
      "finance.chase-no-response.c.c",
      "finance.chase-no-response.b.b",
      "finance.chase-no-response.a.a",
    ]);
  });
});
