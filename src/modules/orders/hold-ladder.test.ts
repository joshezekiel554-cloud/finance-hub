import { describe, expect, it } from "vitest";
import { reasonClause, actionClause, isLadderPaused } from "./hold-ladder.js";

describe("hold ladder customer copy", () => {
  it("uses payment wording for a prepay-unpaid hold", () => {
    expect(reasonClause("payment_upfront_unpaid")).toMatch(/payment for this order/i);
    expect(actionClause("payment_upfront_unpaid")).toMatch(/complete payment/i);
  });

  it("uses overdue-balance wording for on-hold / overdue reasons", () => {
    for (const reason of ["customer_on_hold", "overdue_non_communicating", null]) {
      expect(reasonClause(reason)).toMatch(/overdue account balance/i);
      expect(actionClause(reason)).toMatch(/outstanding balance/i);
    }
  });
});

// "They've promised to pay Wednesday" — the ladder skips the order until the
// date passes, then resumes on its own. An expired pause must read as NOT
// paused, or an order silently stops being chased forever, which is the
// failure mode the dated pause exists to avoid.
describe("isLadderPaused", () => {
  const now = new Date("2026-08-03T17:00:00Z");

  it("pauses while the date is still ahead", () => {
    expect(isLadderPaused("2026-08-05T23:59:00-04:00", now)).toBe(true);
  });

  it("stops pausing once the date has passed", () => {
    expect(isLadderPaused("2026-08-02T23:59:00-04:00", now)).toBe(false);
  });

  it("treats an unset pause as not paused", () => {
    expect(isLadderPaused(null, now)).toBe(false);
    expect(isLadderPaused(undefined, now)).toBe(false);
  });

  it("treats an unparseable value as not paused rather than pausing forever", () => {
    expect(isLadderPaused("not a date", now)).toBe(false);
  });

  it("accepts a Date as well as a string", () => {
    expect(isLadderPaused(new Date("2026-08-06T12:00:00Z"), now)).toBe(true);
    expect(isLadderPaused(new Date("2026-08-01T12:00:00Z"), now)).toBe(false);
  });
});
