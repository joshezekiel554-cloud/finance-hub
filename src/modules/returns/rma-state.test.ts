import { describe, expect, it } from "vitest";
import { TRANSITIONS, type RmaAction, validateTransition } from "./rma-state.js";

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

describe("validateTransition — damage flow", () => {
  it("draft → approved (approve)", () => {
    const r = validateTransition({
      currentStatus: "draft",
      returnType: "damage",
      action: "approve",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("approved");
  });

  it("approved → completed (issue_credit_memo)", () => {
    const r = validateTransition({
      currentStatus: "approved",
      returnType: "damage",
      action: "issue_credit_memo",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("completed");
  });

  it("approved → completed (mark_replacement_sent)", () => {
    const r = validateTransition({
      currentStatus: "approved",
      returnType: "damage",
      action: "mark_replacement_sent",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("completed");
  });
});

describe("validateTransition — seasonal flow", () => {
  it("draft → approved (approve)", () => {
    const r = validateTransition({
      currentStatus: "draft",
      returnType: "seasonal",
      action: "approve",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("approved");
  });

  it("approved → awaiting_warehouse_number (generate_warehouse_export)", () => {
    const r = validateTransition({
      currentStatus: "approved",
      returnType: "seasonal",
      action: "generate_warehouse_export",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("awaiting_warehouse_number");
  });

  it("awaiting_warehouse_number → sent_to_warehouse (set_warehouse_number)", () => {
    const r = validateTransition({
      currentStatus: "awaiting_warehouse_number",
      returnType: "seasonal",
      action: "set_warehouse_number",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("sent_to_warehouse");
  });

  it("awaiting_warehouse_number → approved (cancel_warehouse_export)", () => {
    const r = validateTransition({
      currentStatus: "awaiting_warehouse_number",
      returnType: "seasonal",
      action: "cancel_warehouse_export",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("approved");
  });

  it("sent_to_warehouse → received (mark_received)", () => {
    const r = validateTransition({
      currentStatus: "sent_to_warehouse",
      returnType: "seasonal",
      action: "mark_received",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("received");
  });

  it("received → completed (issue_credit_memo)", () => {
    const r = validateTransition({
      currentStatus: "received",
      returnType: "seasonal",
      action: "issue_credit_memo",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("completed");
  });
});
