import { describe, expect, it } from "vitest";
import {
  buildChaseSignals,
  buildCustomerPromiseSignals,
  buildPromiseSignals,
  buildSuggestedSignals,
  dedupeByKey,
  pickFollowUp,
  signalContractProblems,
  sortSignals,
  type ChaseFacts,
  type CustomerPromiseFacts,
  type PromiseFacts,
  type Signal,
  type SuggestionFacts,
} from "./finance-signals.js";
import { endOfDayNewYork } from "../promises/promise-state.js";

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
      detail:
        'Chase email: "Feldart - follow-up on overdue balance ($2,400.00)". No reply from the customer\'s linked email addresses and no payment recorded since.',
      since: "2026-11-10T14:00:00.000Z",
      customer: { id: "cust1", name: "Keter Judaica" },
      amount: { value: 2400, currency: "USD" },
      links: [
        { label: "Keter Judaica in finance ($2,400.00 open)", url: "https://finance.example/customers/cust1" },
        { label: "Chase queue", url: "https://finance.example/chase" },
      ],
      dedupe: "customer:cust1",
      tags: { chaseLevel: 2, balanceBand: "2k-10k", daysQuiet: 9, followedUp: false },
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
    expect(s!.detail).toBe("No reply from the customer's linked email addresses and no payment recorded since.");
  });

  it("a follow-up we sent restarts the clock: card clears, returns 5 days later under a new key", () => {
    const fu = { at: daysAgo(2), messageId: "fu1", activityId: "actfu", subject: "Re: follow-up" };
    expect(buildChaseSignals([chase({ followUp: fu })], ctx)).toHaveLength(0);
    const [s] = buildChaseSignals([chase({ chasedAt: daysAgo(20), followUp: { ...fu, at: daysAgo(6) } })], ctx);
    expect(s!.key).toBe("finance.chase-no-reply.cust1.fu1");
    expect(s!.title).toContain(`followed up ${daysAgo(6).toISOString().slice(0, 10)}, still no reply`);
    expect(s!.since).toBe(daysAgo(6).toISOString());
    expect(s!.tags?.followedUp).toBe(true);
    // a reply after the follow-up clears it
    expect(buildChaseSignals([chase({ chasedAt: daysAgo(20), followUp: { ...fu, at: daysAgo(6) }, lastInboundAt: daysAgo(1) })], ctx)).toHaveLength(0);
    // a follow-up older than the chase is ignored
    expect(buildChaseSignals([chase({ followUp: { ...fu, at: daysAgo(30) } })], ctx)[0]!.key).toBe("finance.chase-no-reply.cust1.msg1");
  });

  it("pickFollowUp: chase thread or money subject, never the chase's own copy or unrelated mail", () => {
    const chasedAt = daysAgo(10);
    const base = { chasedAt, chaseActivityId: "c1", chaseMessageId: "m1", chaseThreadId: "t1" };
    const mk = (o: Partial<{ activityId: string; at: Date; subject: string | null; messageId: string | null; threadId: string | null }>) => ({
      activityId: "x", at: daysAgo(3), subject: "Re: Order 110719", messageId: "mx", threadId: "tx", ...o,
    });
    expect(pickFollowUp(base, [mk({})])).toBeNull(); // order chatter
    expect(pickFollowUp(base, [mk({ messageId: "m1", threadId: "t1" })])).toBeNull(); // the chase itself
    expect(pickFollowUp(base, [mk({ at: new Date(chasedAt.getTime() + 60_000), threadId: "t1" })])).toBeNull(); // same send
    expect(pickFollowUp(base, [mk({ threadId: "t1" })])?.messageId).toBe("mx");
    expect(pickFollowUp(base, [mk({ subject: "Re: Feldart - Statement of Account ($768.70 open)" })])?.messageId).toBe("mx");
    expect(pickFollowUp(base, [mk({ subject: "Overdue - Final reminder" })])?.messageId).toBe("mx");
    // automated statement runs / hold notices are not follow-ups (S Moskovits ignored 5 statements)
    expect(pickFollowUp(base, [mk({ subject: "Feldart - Statement of Account ($3,643.00 open)" })])).toBeNull();
    expect(pickFollowUp(base, [mk({ subject: "Action needed — order 18926 still on hold" })])).toBeNull();
    const latest = pickFollowUp(base, [mk({ threadId: "t1", messageId: "a", at: daysAgo(5) }), mk({ threadId: "t1", messageId: "b", at: daysAgo(2) })]);
    expect(latest?.messageId).toBe("b");
  });

  it("keeps a customer chased months ago and silent since (no age-out)", () => {
    const [s] = buildChaseSignals([chase({ chasedAt: daysAgo(70) })], ctx);
    expect(s!.since).toBe(daysAgo(70).toISOString());
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
      title: "Meoros Judaica: promised payment by 2026-11-14, date passed and order still on hold ($1,240.00 open)",
      detail:
        'Order 18926 is still on hold; promise note: "paying Friday". Check whether payment arrived and release the hold, or chase.',
      since: "2026-11-14T14:00:00.000Z",
      customer: { id: "cust2", name: "Meoros Judaica" },
      amount: { value: 1240, currency: "USD" },
      links: [{ label: "Meoros Judaica in finance (order 18926 on hold)", url: "https://finance.example/customers/cust2" }],
      dedupe: "customer:cust2",
      tags: { variant: "held-order", balanceBand: "500-2k", daysPast: 5 },
    });
  });

  it("counts the whole promised day: missed only from the next day", () => {
    // Stored as the end of the promised day in New York (the order picker).
    const today = endOfDayNewYork("2026-11-19")!;
    expect(buildPromiseSignals([promise({ promisedBy: today })], ctx)).toHaveLength(0);
    const yesterday = endOfDayNewYork("2026-11-18")!;
    const [s] = buildPromiseSignals([promise({ promisedBy: yesterday })], ctx);
    // keyed by the New York calendar day, not the next UTC day
    expect(s!.key).toBe("finance.promise-missed.cust2.2026-11-18");
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

describe("chase-no-reply with a customer promise", () => {
  it("stays quiet while the customer's promise date hasn't passed", () => {
    expect(buildChaseSignals([chase({ promisedPayBy: "2026-11-19" })], ctx)).toHaveLength(0);
    expect(buildChaseSignals([chase({ promisedPayBy: "2026-11-25" })], ctx)).toHaveLength(0);
    // passed promise → chasing (and the nudge) resume
    expect(buildChaseSignals([chase({ promisedPayBy: "2026-11-18" })], ctx)).toHaveLength(1);
  });
});

function custPromise(over: Partial<CustomerPromiseFacts> = {}): CustomerPromiseFacts {
  return {
    customerId: "cust3",
    customerName: "Shalom House",
    promisedBy: "2026-11-17",
    note: "wire on Monday",
    setBy: "josh@x.com",
    setAt: new Date("2026-11-12T10:00:00Z"),
    balance: 3100,
    lastPaymentDate: null,
    ...over,
  };
}

describe("buildCustomerPromiseSignals", () => {
  it("nudges a passed customer-level promise with no payment since it was made", () => {
    const [s] = buildCustomerPromiseSignals([custPromise()], ctx);
    expect(s).toMatchObject({
      key: "finance.promise-missed.cust3.2026-11-17",
      kind: "promise-missed",
      severity: "high",
      title: "Shalom House: promised payment by 2026-11-17, no payment recorded since ($3,100.00 open)",
      customer: { id: "cust3", name: "Shalom House" },
      dedupe: "customer:cust3",
      tags: { variant: "customer", balanceBand: "2k-10k", daysPast: 2 },
    });
    expect(s!.detail).toContain('Promise saved 2026-11-12 by josh@x.com; note: "wire on Monday"');
    expect(signalContractProblems(s!, ctx.baseUrl)).toEqual([]);
  });

  it("waits until the day after the promised date", () => {
    expect(buildCustomerPromiseSignals([custPromise({ promisedBy: "2026-11-19" })], ctx)).toHaveLength(0);
    expect(buildCustomerPromiseSignals([custPromise({ promisedBy: "2026-11-18" })], ctx)).toHaveLength(1);
  });

  it("counts a promise kept only once the balance is under $50; a part-payment still fires, worded as such", () => {
    expect(buildCustomerPromiseSignals([custPromise({ balance: 20, lastPaymentDate: new Date("2026-11-14") })], ctx)).toHaveLength(0);
    const [part] = buildCustomerPromiseSignals([custPromise({ lastPaymentDate: new Date("2026-11-14") })], ctx);
    expect(part!.title).toContain("only part-paid since");
    expect(part!.detail).toContain("A payment has reached QuickBooks since (latest 2026-11-14)");
    expect(part!.tags?.partPaid).toBe(true);
    const [none] = buildCustomerPromiseSignals([custPromise({ lastPaymentDate: new Date("2026-11-01") })], ctx);
    expect(none!.title).toContain("no payment recorded since");
    expect(none!.tags?.partPaid).toBe(false);
  });

  it("dedupes against the held-order variant with the same customer + date", () => {
    const merged = dedupeByKey([
      ...buildCustomerPromiseSignals([custPromise({ customerId: "cust2", promisedBy: "2026-11-14" })], ctx),
      ...buildPromiseSignals([promise()], ctx),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.tags?.variant).toBe("customer");
  });
});

function suggestion(over: Partial<SuggestionFacts> = {}): SuggestionFacts {
  return {
    activityId: "act9",
    messageId: "gm9",
    customerId: "cust4",
    customerName: "Judaica Plus",
    emailAt: daysAgo(2),
    date: "2026-11-21",
    quote: "Payment will go out Friday",
    balance: 780,
    promisedPayBy: null,
    promiseSetAt: null,
    lastPaymentDate: null,
    ...over,
  };
}

describe("buildSuggestedSignals", () => {
  it("suggests a promise read from a recent email, in the contract's shape", () => {
    const [s] = buildSuggestedSignals([suggestion()], ctx);
    expect(s).toEqual({
      key: "finance.promise-suggested.cust4.gm9",
      kind: "promise-suggested",
      severity: "medium",
      title: "Judaica Plus: email of 2026-11-17 says payment by 2026-11-21 ($780.00 open)",
      detail:
        "They wrote: \"Payment will go out Friday\". Picked up automatically from the customer's email; nothing is saved in finance until someone confirms the promise.",
      since: daysAgo(2).toISOString(),
      customer: { id: "cust4", name: "Judaica Plus" },
      amount: { value: 780, currency: "USD" },
      links: [{ label: "Judaica Plus in finance ($780.00 open)", url: "https://finance.example/customers/cust4" }],
      dedupe: "customer:cust4",
      promise: { date: "2026-11-21", quote: "Payment will go out Friday" },
      tags: { balanceBand: "500-2k", daysUntil: 2 },
    });
    expect(signalContractProblems(s!, ctx.baseUrl)).toEqual([]);
  });

  it("drops passed dates, old emails, small balances and active promises", () => {
    expect(buildSuggestedSignals([suggestion({ date: "2026-11-18" })], ctx)).toHaveLength(0);
    expect(buildSuggestedSignals([suggestion({ date: "2026-11-19" })], ctx)).toHaveLength(1);
    expect(buildSuggestedSignals([suggestion({ emailAt: daysAgo(15) })], ctx)).toHaveLength(0);
    expect(buildSuggestedSignals([suggestion({ balance: 49 })], ctx)).toHaveLength(0);
    expect(buildSuggestedSignals([suggestion({ promisedPayBy: "2026-11-30" })], ctx)).toHaveLength(0);
  });

  it("drops a suggestion once a promise was saved after the email, or they paid", () => {
    expect(buildSuggestedSignals([suggestion({ promiseSetAt: daysAgo(1), promisedPayBy: "2026-11-18" })], ctx)).toHaveLength(0);
    // a promise saved BEFORE the email (and since passed) doesn't block it
    expect(buildSuggestedSignals([suggestion({ promiseSetAt: daysAgo(10), promisedPayBy: "2026-11-12" })], ctx)).toHaveLength(1);
    expect(buildSuggestedSignals([suggestion({ lastPaymentDate: daysAgo(1) })], ctx)).toHaveLength(0);
  });

  it("keeps only the latest email per customer and falls back to the activity id", () => {
    const out = buildSuggestedSignals(
      [
        suggestion({ activityId: "old", messageId: null, emailAt: daysAgo(5) }),
        suggestion({ activityId: "new", messageId: null, emailAt: daysAgo(1) }),
      ],
      ctx,
    );
    expect(out.map((s) => s.key)).toEqual(["finance.promise-suggested.cust4.new"]);
  });

  it("omits the quote when the email had none", () => {
    const [s] = buildSuggestedSignals([suggestion({ quote: null })], ctx);
    expect(s!.promise).toEqual({ date: "2026-11-21" });
  });
});

describe("signalContractProblems", () => {
  const base = (): Signal => buildChaseSignals([chase()], ctx)[0]!;

  it("passes every builder's output", () => {
    for (const s of [base(), ...buildPromiseSignals([promise()], ctx)]) {
      expect(signalContractProblems(s, ctx.baseUrl)).toEqual([]);
    }
  });

  it("flags tags, off-origin links and a missing promise", () => {
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 9; i++) tooMany[`t${i}`] = i;
    expect(signalContractProblems({ ...base(), tags: tooMany }, ctx.baseUrl)).toContain("tags");
    expect(signalContractProblems({ ...base(), tags: { ["x".repeat(25)]: 1 } }, ctx.baseUrl)).toContain("tag-key");
    expect(
      signalContractProblems({ ...base(), links: [{ label: "x", url: "https://evil.example/customers/1" }] }, ctx.baseUrl),
    ).toContain("link-url");
    expect(signalContractProblems({ ...base(), kind: "promise-suggested" }, ctx.baseUrl)).toContain("promise");
  });
});

describe("sortSignals with suggestions", () => {
  it("puts a suggestion after a medium chase of the same severity", () => {
    const sorted = sortSignals([
      ...buildSuggestedSignals([suggestion({ balance: 99_000 })], ctx),
      ...buildChaseSignals([chase({ level: 1, balance: 100 })], ctx),
    ]);
    expect(sorted.map((s) => s.kind)).toEqual(["chase-no-reply", "promise-suggested"]);
  });
});
