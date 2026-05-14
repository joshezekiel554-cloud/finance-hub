import { describe, it, expect } from "vitest";
import type { QboCreditMemo } from "./types.js";
import { aggregateCreditBalanceByQbCustomerId } from "./credit-memo-aggregation.js";

function memo(overrides: Partial<QboCreditMemo>): QboCreditMemo {
  return {
    Id: "cm-x",
    CustomerRef: { value: "cust-x", name: "Test" },
    Balance: 0,
    ...overrides,
  } as QboCreditMemo;
}

describe("aggregateCreditBalanceByQbCustomerId", () => {
  it("returns empty map for empty input", () => {
    expect(aggregateCreditBalanceByQbCustomerId([]).size).toBe(0);
  });

  it("sums balances per customer", () => {
    const totals = aggregateCreditBalanceByQbCustomerId([
      memo({ Id: "cm1", CustomerRef: { value: "A", name: "A" }, Balance: 100 }),
      memo({ Id: "cm2", CustomerRef: { value: "A", name: "A" }, Balance: 150 }),
      memo({ Id: "cm3", CustomerRef: { value: "B", name: "B" }, Balance: 50 }),
    ]);
    expect(totals.get("A")).toBe(250);
    expect(totals.get("B")).toBe(50);
  });

  it("ignores memos with zero or negative balance", () => {
    const totals = aggregateCreditBalanceByQbCustomerId([
      memo({ Id: "cm1", CustomerRef: { value: "A", name: "A" }, Balance: 0 }),
      memo({ Id: "cm2", CustomerRef: { value: "A", name: "A" }, Balance: -10 }),
      memo({ Id: "cm3", CustomerRef: { value: "A", name: "A" }, Balance: 100 }),
    ]);
    expect(totals.get("A")).toBe(100);
  });

  it("ignores memos missing CustomerRef.value", () => {
    const totals = aggregateCreditBalanceByQbCustomerId([
      memo({ Id: "cm1", CustomerRef: { value: "", name: "?" }, Balance: 100 }),
      memo({ Id: "cm2", CustomerRef: { value: "A", name: "A" }, Balance: 50 }),
    ]);
    expect(totals.size).toBe(1);
    expect(totals.get("A")).toBe(50);
  });

  it("ignores non-finite Balance values", () => {
    const totals = aggregateCreditBalanceByQbCustomerId([
      memo({
        Id: "cm1",
        CustomerRef: { value: "A", name: "A" },
        Balance: NaN as unknown as number,
      }),
      memo({ Id: "cm2", CustomerRef: { value: "A", name: "A" }, Balance: 200 }),
    ]);
    expect(totals.get("A")).toBe(200);
  });
});
