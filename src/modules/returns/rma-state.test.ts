import { describe, expect, it } from "vitest";
import { TRANSITIONS, type RmaAction } from "./rma-state.js";

describe("TRANSITIONS table", () => {
  it("defines transitions for every RmaAction", () => {
    const expectedActions: RmaAction[] = [
      "approve",
      "deny",
      "override_approve",
      "unapprove",
      "generate_warehouse_export",
      "cancel_warehouse_export",
      "set_warehouse_number",
      "mark_received",
      "issue_credit_memo",
      "mark_replacement_sent",
      "cancel",
    ];
    for (const action of expectedActions) {
      expect(TRANSITIONS[action]).toBeDefined();
    }
  });

  it("approve from draft yields approved", () => {
    const rule = TRANSITIONS.approve;
    const result = rule({
      currentStatus: "draft",
      returnType: "damage",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextStatus).toBe("approved");
    }
  });
});
