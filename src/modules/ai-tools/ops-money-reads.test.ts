import { describe, expect, it } from "vitest";
import { matchCredits, OPS_MONEY_READS, weekBuckets } from "./ops-money-reads.js";

describe("unapplied credits", () => {
  it("nets credit against the oldest open invoices in the same book", () => {
    const r = matchCredits(
      [
        { customerId: "c1", origin: "feldart", docNumber: "CM1", balance: 150, date: "2026-10-01" },
        { customerId: "c1", origin: "tj", docNumber: "CM9", balance: 40, date: "2026-09-01" },
        { customerId: "c2", origin: "feldart", docNumber: "CM2", balance: 30, date: "2026-10-05" },
      ],
      [
        { customerId: "c1", origin: "feldart", docNumber: "102", balance: 100, dueDate: "2026-10-20" },
        { customerId: "c1", origin: "feldart", docNumber: "101", balance: 80, dueDate: "2026-09-20" },
        { customerId: "c2", origin: "tj", docNumber: "201", balance: 500, dueDate: "2026-09-01" },
      ],
    );
    const c1f = r.find((x) => x.customerId === "c1" && x.book === "Feldart")!;
    expect(c1f).toMatchObject({ unappliedCredit: 150, openBalance: 180, creditLeftAfter: 0 });
    expect(c1f.wouldCover).toEqual([
      { invoice: "101", balance: 80, dueDate: "2026-09-20", covered: 80 },
      { invoice: "102", balance: 100, dueDate: "2026-10-20", covered: 70 },
    ]);
    // credit and debt in DIFFERENT books never net
    const c2 = r.find((x) => x.customerId === "c2")!;
    expect(c2).toMatchObject({ book: "Feldart", openBalance: 0, wouldCover: [], creditLeftAfter: 30 });
    const c1tj = r.find((x) => x.customerId === "c1" && x.book === "Torah Judaica")!;
    expect(c1tj.openBalance).toBe(0);
    expect(r[0]!.customerId).toBe("c1"); // biggest nettable amount first
  });
});

describe("cash outlook buckets", () => {
  it("splits what's due by week and keeps overdue separate", () => {
    const w = weekBuckets(
      [
        { balance: 100, dueDate: "2026-11-01" }, // overdue
        { balance: 50, dueDate: "2026-11-04" }, // today → this week
        { balance: 25, dueDate: "2026-11-10" }, // this week (4..10)
        { balance: 10, dueDate: "2026-11-11" }, // next week
        { balance: 999, dueDate: "2026-12-31" }, // beyond window
        { balance: 7, dueDate: null },
      ],
      "2026-11-04",
      14,
    );
    expect(w.overdue).toBe(100);
    expect(w.overdueInvoices).toBe(1);
    expect([w.noDueDate, w.noDueDateInvoices]).toEqual([7, 1]); // reported, not dropped
    expect(w.buckets).toEqual([
      { week: "this week", from: "2026-11-04", to: "2026-11-10", due: 75, invoices: 2 },
      { week: "in 1 week", from: "2026-11-11", to: "2026-11-17", due: 10, invoices: 1 },
    ]);
  });

  it("both tools are read-only ops tools with closed schemas", () => {
    for (const t of OPS_MONEY_READS) {
      expect(t.ops).toBe(true);
      expect(t.write).toBeFalsy();
      expect(t.input_schema.additionalProperties).toBe(false);
    }
  });
});
