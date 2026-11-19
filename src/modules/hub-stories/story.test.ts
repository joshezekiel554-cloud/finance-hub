import { describe, expect, it } from "vitest";
import {
  addDaysYmd,
  balanceAt,
  buildBuying,
  buildMoney,
  buildPayBehaviour,
  buildStory,
  buildTimeline,
  emptyLedger,
  fifoPaidDates,
  invoiceDays,
  judgePromises,
  lineSku,
  median,
  promiseRecordTag,
  summarisePromises,
  topSkus,
  type Ledger,
  type LedgerInvoice,
  type TimelineInput,
} from "./story.js";

const TODAY = "2026-11-19";
const now = new Date(`${TODAY}T14:00:00Z`);
const ago = (n: number) => addDaysYmd(TODAY, -n);

let seq = 0;
function inv(over: Partial<LedgerInvoice> & { issueDate: string }): LedgerInvoice {
  seq++;
  return { id: `i${String(seq).padStart(3, "0")}`, docNumber: `10${seq}`, dueDate: addDaysYmd(over.issueDate, 30), total: 1000, balance: 0, origin: "feldart", ...over };
}
const pay = (date: string, amount: number, book: "feldart" | "tj" = "feldart") => ({
  id: `p${date}${amount}`,
  date,
  total: amount,
  feldart: book === "feldart" ? amount : 0,
  tj: book === "tj" ? amount : 0,
});

describe("median / addDaysYmd", () => {
  it("handles odd, even and empty", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(addDaysYmd("2026-02-27", 2)).toBe("2026-03-01");
  });
});

describe("fifoPaidDates", () => {
  it("pays the oldest invoice first, per book", () => {
    const a = inv({ issueDate: "2026-01-01" });
    const b = inv({ issueDate: "2026-02-01" });
    const t = inv({ issueDate: "2026-01-15", origin: "tj" });
    const l: Ledger = { ...emptyLedger(), invoices: [b, a, t], payments: [pay("2026-02-10", 1000), pay("2026-03-20", 1000), pay("2026-04-01", 1000, "tj")] };
    const f = fifoPaidDates(l, "feldart");
    expect(f.get(a.id)).toBe("2026-02-10");
    expect(f.get(b.id)).toBe("2026-03-20");
    expect(fifoPaidDates(l, "tj").get(t.id)).toBe("2026-04-01");
  });

  it("an opening debt soaks up cash first; a prepayment pays on the invoice date", () => {
    const a = inv({ issueDate: "2026-01-01" });
    const debt: Ledger = { ...emptyLedger(), opening: { feldart: 500, tj: 0, total: 500 }, invoices: [a], payments: [pay("2026-01-10", 600), pay("2026-02-01", 900)] };
    expect(fifoPaidDates(debt, "feldart").get(a.id)).toBe("2026-02-01");
    const pre: Ledger = { ...emptyLedger(), opening: { feldart: -1000, tj: 0, total: -1000 }, invoices: [a] };
    expect(fifoPaidDates(pre, "feldart").get(a.id)).toBe("2026-01-01");
  });

  it("counts applied credit memos as cash and skips invoices QBO says are open", () => {
    const a = inv({ issueDate: "2026-01-01" });
    const b = inv({ issueDate: "2026-01-02", balance: 1000 });
    const l: Ledger = {
      ...emptyLedger(),
      invoices: [a, b],
      credits: [{ id: "c1", docNumber: "CM1", date: "2026-01-20", total: 1000, balance: 0, origin: "feldart" }],
      payments: [pay("2026-03-01", 1000)],
    };
    const f = fifoPaidDates(l, "feldart");
    expect(f.get(a.id)).toBe("2026-01-20");
    expect(f.has(b.id)).toBe(false);
  });

  it("gives no date when the cash doesn't cover it (paid by something finance can't see)", () => {
    const a = inv({ issueDate: "2026-01-01" });
    expect(fifoPaidDates({ ...emptyLedger(), invoices: [a], payments: [pay("2026-02-01", 400)] }, "feldart").size).toBe(0);
  });
});

/** n invoices each paid `days` after issue, oldest ~`span` days ago. */
function steadyLedger(n: number, days: number, span = 600): Ledger {
  const invoices: LedgerInvoice[] = [];
  const payments: ReturnType<typeof pay>[] = [];
  for (let k = 0; k < n; k++) {
    const issue = ago(span - Math.floor((k * (span - days - 10)) / Math.max(1, n - 1)));
    invoices.push(inv({ issueDate: issue }));
    payments.push(pay(addDaysYmd(issue, days), 1000));
  }
  return { ...emptyLedger(), invoices, payments };
}

describe("buildPayBehaviour", () => {
  it("reports the median days from invoice date and the on-time share", () => {
    const p = buildPayBehaviour(steadyLedger(6, 25), TODAY, null);
    expect(p.usualDaysToPay).toBe(25);
    expect(p.onTimePct).toBe(100);
    expect(p.invoicesPaid2y).toBe(6);
    expect(p.trend).toBe("steady");
  });

  it("trend is null under 4 paid invoices", () => {
    expect(buildPayBehaviour(steadyLedger(3, 25), TODAY, null).trend).toBeNull();
    expect(buildPayBehaviour(emptyLedger(), TODAY, null)).toMatchObject({ usualDaysToPay: null, onTimePct: null, invoicesPaid2y: 0, trend: null });
  });

  it("slipping when the oldest overdue invoice is > 1.5× usual and ≥ usual + 20 days", () => {
    const l = steadyLedger(6, 40);
    expect(buildPayBehaviour(l, TODAY, 60).trend).toBe("steady"); // not > 1.5 × 40
    expect(buildPayBehaviour(l, TODAY, 59).trend).toBe("steady");
    expect(buildPayBehaviour(l, TODAY, 61).trend).toBe("slipping");
  });

  it("needs the +20 days too for quick payers", () => {
    const l = steadyLedger(6, 10);
    expect(buildPayBehaviour(l, TODAY, 25).trend).toBe("steady"); // 25 > 15 but < 30
    expect(buildPayBehaviour(l, TODAY, 30).trend).toBe("slipping");
  });

  it("improving when recent payments come much faster than before", () => {
    const invoices: LedgerInvoice[] = [];
    const payments: ReturnType<typeof pay>[] = [];
    const add = (issueAgo: number, days: number) => {
      const i = inv({ issueDate: ago(issueAgo) });
      invoices.push(i);
      payments.push(pay(addDaysYmd(i.issueDate, days), 1000));
    };
    add(600, 60);
    add(500, 60);
    add(400, 60);
    add(120, 15);
    add(60, 15);
    expect(buildPayBehaviour({ ...emptyLedger(), invoices, payments }, TODAY, null)).toMatchObject({ trend: "improving", recentDaysToPay: 15 });
  });

  it("ignores invoices issued over 2 years ago", () => {
    const l = steadyLedger(5, 20, 1000);
    expect(buildPayBehaviour(l, TODAY, null).invoicesPaid2y).toBeLessThan(5);
  });
});

describe("buildMoney", () => {
  it("splits by book, nets unapplied credit, finds the oldest overdue", () => {
    const l: Ledger = {
      ...emptyLedger(),
      invoices: [
        inv({ issueDate: ago(100), dueDate: ago(70), total: 500, balance: 500 }),
        inv({ issueDate: ago(10), dueDate: addDaysYmd(TODAY, 20), total: 300, balance: 300 }),
        inv({ issueDate: ago(400), dueDate: ago(370), total: 200, balance: 200, origin: "tj", beforeWindow: true }),
      ],
      credits: [{ id: "c", docNumber: null, date: ago(5), total: 50, balance: 50, origin: "feldart" }],
    };
    const m = buildMoney(l, 950, TODAY);
    expect(m).toEqual({
      balance: 950,
      overdue: 700,
      oldestOverdueDays: 370,
      oldestOverdueAgeDays: 400,
      book: { feldart: { balance: 750, overdue: 500 }, tj: { balance: 200, overdue: 200 } },
    });
  });

  it("nulls when nothing is overdue", () => {
    expect(buildMoney(emptyLedger(), 0, TODAY)).toMatchObject({ overdue: 0, oldestOverdueDays: null, oldestOverdueAgeDays: null });
  });
});

describe("promises", () => {
  const owing = (): Ledger => ({ ...emptyLedger(), invoices: [inv({ issueDate: ago(90), total: 2000, balance: 2000 })] });
  const at = (ymd: string) => new Date(`${ymd}T15:00:00Z`);

  it("kept when the balance is settled by the date", () => {
    const l = owing();
    l.payments.push(pay(ago(20), 2000));
    const [r] = judgePromises([{ setAt: at(ago(30)), date: ago(15), source: "customer" }], l, TODAY);
    expect(r?.outcome).toBe("kept");
  });

  it("kept when they paid what was owed even though new invoices came after", () => {
    const l = owing();
    l.payments.push(pay(ago(20), 2000));
    l.invoices.push(inv({ issueDate: ago(18), total: 900, balance: 900 }));
    expect(judgePromises([{ setAt: at(ago(30)), date: ago(15), source: "customer" }], l, TODAY)[0]?.outcome).toBe("kept");
  });

  it("part-paid, broken, pending", () => {
    const l = owing();
    l.payments.push(pay(ago(20), 200));
    const res = judgePromises(
      [
        { setAt: at(ago(30)), date: ago(15), source: "customer" },
        { setAt: at(ago(14)), date: ago(5), source: "customer" },
        { setAt: at(ago(2)), date: addDaysYmd(TODAY, 3), source: "customer" },
      ],
      l,
      TODAY,
    );
    expect(res.map((r) => r.outcome)).toEqual(["partPaid", "broken", "pending"]);
    const s = summarisePromises(res);
    expect(s).toEqual({ made: 3, kept: 0, broken: 1, partPaid: 1, last: { date: addDaysYmd(TODAY, 3), outcome: "pending" } });
    expect(promiseRecordTag(s)).toBe("0/2");
  });

  it("the same date saved on the customer and mirrored on held orders counts once", () => {
    const l = owing();
    const res = judgePromises(
      [
        { setAt: at(ago(30)), date: ago(15), source: "customer", note: "wire" },
        { setAt: at(ago(30)), date: ago(15), source: "held-order" },
        { setAt: at(ago(29)), date: ago(15), source: "held-order" },
      ],
      l,
      TODAY,
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ source: "customer", outcome: "broken" });
    expect(promiseRecordTag(summarisePromises([]))).toBeNull();
  });

  it("balanceAt walks the ledger from the opening balance", () => {
    const l = owing();
    l.opening.total = 100;
    l.payments.push(pay(ago(20), 500));
    expect(balanceAt(l, ago(100))).toBe(100);
    expect(balanceAt(l, ago(50))).toBe(2100);
    expect(balanceAt(l, TODAY)).toBe(1600);
  });
});

describe("buying", () => {
  it("one order per invoice day; median gap; avg order", () => {
    const days = invoiceDays(
      [
        { issueDate: ago(130), total: 1000, origin: "feldart" },
        { issueDate: ago(130), total: 200, origin: "feldart" },
        { issueDate: ago(90), total: 800, origin: "feldart" },
        { issueDate: ago(50), total: 1000, origin: "feldart" },
        { issueDate: ago(10), total: 1000, origin: "feldart" },
        { issueDate: ago(5), total: 999, origin: "tj" },
        { issueDate: "2030-01-01", total: 5, origin: "feldart" },
      ],
      ago(730),
      TODAY,
    );
    expect(days).toHaveLength(4);
    expect(buildBuying(days, ["MEN01"])).toEqual({ lastOrderAt: ago(10), usualGapDays: 40, avgOrderUsd: 1000, orders2y: 4, topSkus: ["MEN01"] });
    expect(buildBuying(days.slice(0, 3)).usualGapDays).toBeNull();
  });

  it("finds the SKU code in whichever column the sync put it", () => {
    expect(lineSku({ sku: "Menorah Silver 9in", description: "MEN01", itemName: null })).toBe("MEN01");
    expect(lineSku({ sku: "ksd-22", description: "Kiddush cup", itemName: null })).toBe("KSD-22");
    expect(lineSku({ sku: "Shipping", description: "Freight charge", itemName: "Shipping" })).toBeNull();
    expect(
      topSkus([
        { sku: "A Title", description: "AB12", itemName: null, qty: 2 },
        { sku: "CD34", description: "x", itemName: null, qty: 5 },
        { sku: "A Title", description: "AB12", itemName: null, qty: 1 },
      ]),
    ).toEqual(["CD34", "AB12"]);
  });
});

describe("buildTimeline", () => {
  const base = (): TimelineInput => ({ orders: [], invoices: [], payments: [], credits: [], chases: [], promises: [], holds: [], rmas: [], statements: [], hubNotes: [] });
  const ctx = { today: TODAY, baseUrl: "https://finance.example", customerId: "c1" };

  it("newest first, plain text, absolute links, TJ book label, nothing older than 2 years or in the future", () => {
    const t = buildTimeline(
      {
        ...base(),
        invoices: [inv({ issueDate: ago(3), docNumber: "2001", origin: "tj", total: 120 }), inv({ issueDate: ago(800) }), inv({ issueDate: "2030-01-01" })],
        payments: [pay(ago(1), 50)],
        chases: [{ date: ago(2), level: 2, subject: "Overdue" }],
        orders: [{ id: "o1", number: "1234", date: ago(4), total: 1500, cancelled: false, holdStartedAt: ago(4), holdReleasedAt: null, holdReason: "customer_on_hold" }],
        rmas: [{ id: "r1", number: "RMA-7", date: ago(6), status: "approved", type: "damage", total: 80 }],
        hubNotes: [{ date: ago(0), text: "Note from hub (Josh): cheque Monday" }],
      },
      ctx,
    );
    expect(t.map((e) => e.kind)).toEqual(["hub-note", "payment", "chase", "invoice", "order", "hold-on", "rma"]);
    expect(t.find((e) => e.kind === "invoice")?.text).toBe("TJ invoice 2001 for $120.00");
    expect(t.find((e) => e.kind === "order")).toMatchObject({ text: "Shopify order #1234 for $1,500.00", link: "https://finance.example/customers/c1?tab=orders", source: "finance" });
    expect(t.find((e) => e.kind === "rma")?.link).toBe("https://finance.example/returns/r1");
    for (const e of t) {
      expect(e.text.length).toBeLessThanOrEqual(160);
      expect(e.link?.startsWith("https://finance.example/")).toBe(true);
    }
  });

  it("caps each kind and the total", () => {
    const statements = Array.from({ length: 40 }, (_, k) => ({ date: ago(k), number: k, type: "open_items" }));
    const payments = Array.from({ length: 40 }, (_, k) => pay(ago(k + 1), 10 + k));
    const invoices = Array.from({ length: 40 }, (_, k) => inv({ issueDate: ago(k + 2) }));
    const chases = Array.from({ length: 40 }, (_, k) => ({ date: ago(k + 3), level: 1, subject: null }));
    const hubNotes = Array.from({ length: 40 }, (_, k) => ({ date: ago(k + 4), text: "x".repeat(300) }));
    const t = buildTimeline({ ...base(), statements, payments, invoices, chases, hubNotes }, ctx);
    expect(t).toHaveLength(60);
    for (const k of ["statement", "payment", "invoice", "chase", "hub-note"]) {
      expect(t.filter((e) => e.kind === k).length).toBeLessThanOrEqual(15);
    }
    const only = buildTimeline({ ...base(), statements, payments }, ctx);
    expect(only.filter((e) => e.kind === "statement")).toHaveLength(15);
    expect(only).toHaveLength(30);
    expect(t.every((e) => e.text.length <= 160)).toBe(true);
  });

  it("promise set + outcome events", () => {
    const t = buildTimeline(
      { ...base(), promises: [{ setAt: new Date(`${ago(10)}T12:00:00Z`), date: ago(5), source: "customer", note: "wire", outcome: "broken" }] },
      ctx,
    );
    expect(t.map((e) => [e.kind, e.date])).toEqual([
      ["promise-broken", ago(4)],
      ["promise-set", ago(10)],
    ]);
  });
});

describe("buildStory", () => {
  it("assembles every section", () => {
    const s = buildStory(
      {
        customer: { id: "c1", name: "Keter", emails: ["a@keter.com"], balance: 0 },
        ledger: steadyLedger(5, 30),
        promisesMade: [],
        lines: [],
        extras: { orders: [], chases: [], holds: [], rmas: [], statements: [], hubNotes: [] },
      },
      { now, baseUrl: "https://finance.example" },
    );
    expect(s.customer).toEqual({ id: "c1", name: "Keter", emails: ["a@keter.com"] });
    expect(s.payBehaviour.usualDaysToPay).toBe(30);
    expect(s.promises).toEqual({ made: 0, kept: 0, broken: 0, partPaid: 0 });
    expect(s.buying.orders2y).toBe(5);
    expect(s.timeline.length).toBeGreaterThan(0);
    expect(s.generatedAt).toBe(now.toISOString());
  });
});
