import { describe, expect, it } from "vitest";
import { reasonClause, actionClause } from "./hold-ladder.js";

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
