import { describe, it, expect } from "vitest";
import { computeOriginBalances } from "./balances";

const NOW = new Date("2026-06-09T00:00:00.000Z");
const past = "2026-05-01"; // overdue relative to NOW
const future = "2026-12-01"; // not yet due

describe("computeOriginBalances", () => {
  it("sums open invoice balances per origin", () => {
    const r = computeOriginBalances(
      [
        { origin: "feldart", balance: "250.00", dueDate: past },
        { origin: "feldart", balance: "170.00", dueDate: future },
        { origin: "tj", balance: "180.00", dueDate: past },
      ],
      { feldart: 0, tj: 0 },
      NOW,
    );
    expect(r.feldart.balance).toBe(420);
    expect(r.feldart.overdue).toBe(250); // only the past-due one
    expect(r.tj.balance).toBe(180);
    expect(r.tj.overdue).toBe(180);
  });

  it("ignores non-open (zero/negative balance) invoices", () => {
    const r = computeOriginBalances(
      [
        { origin: "tj", balance: "0.00", dueDate: past },
        { origin: "tj", balance: "-50.00", dueDate: past },
        { origin: "tj", balance: "100.00", dueDate: past },
      ],
      { feldart: 0, tj: 0 },
      NOW,
    );
    expect(r.tj.balance).toBe(100);
    expect(r.tj.overdue).toBe(100);
  });

  it("nets TJ unapplied credit against TJ balance + overdue only", () => {
    const r = computeOriginBalances(
      [
        { origin: "feldart", balance: "200.00", dueDate: past },
        { origin: "tj", balance: "180.00", dueDate: past },
      ],
      { feldart: 0, tj: 50 },
      NOW,
    );
    expect(r.tj.balance).toBe(130);
    expect(r.tj.overdue).toBe(130);
    // Feldart untouched by TJ credit
    expect(r.feldart.balance).toBe(200);
    expect(r.feldart.overdue).toBe(200);
  });

  it("floors netted figures at zero when credit exceeds balance", () => {
    const r = computeOriginBalances(
      [{ origin: "tj", balance: "100.00", dueDate: past }],
      { feldart: 0, tj: 250 },
      NOW,
    );
    expect(r.tj.balance).toBe(0);
    expect(r.tj.overdue).toBe(0);
  });

  it("keeps net overdue <= net balance (credit reduces both)", () => {
    const r = computeOriginBalances(
      [
        { origin: "tj", balance: "100.00", dueDate: past }, // overdue
        { origin: "tj", balance: "80.00", dueDate: future }, // current
      ],
      { feldart: 0, tj: 50 },
      NOW,
    );
    expect(r.tj.balance).toBe(130); // 180 - 50
    expect(r.tj.overdue).toBe(50); // 100 - 50
    expect(r.tj.overdue).toBeLessThanOrEqual(r.tj.balance);
  });

  it("treats null dueDate as not overdue", () => {
    const r = computeOriginBalances(
      [{ origin: "feldart", balance: "90.00", dueDate: null }],
      { feldart: 0, tj: 0 },
      NOW,
    );
    expect(r.feldart.balance).toBe(90);
    expect(r.feldart.overdue).toBe(0);
  });
});
