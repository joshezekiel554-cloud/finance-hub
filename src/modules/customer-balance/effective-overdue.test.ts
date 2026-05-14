import { describe, it, expect } from "vitest";
import { effectiveOverdue } from "./effective-overdue.js";

describe("effectiveOverdue", () => {
  it("returns overdue when there are no credits", () => {
    expect(effectiveOverdue("800.00", "0.00")).toBe(800);
  });

  it("subtracts credits from overdue", () => {
    expect(effectiveOverdue("800.00", "200.00")).toBe(600);
  });

  it("floors at zero when credits exceed overdue", () => {
    expect(effectiveOverdue("100.00", "500.00")).toBe(0);
  });

  it("returns zero when both are zero", () => {
    expect(effectiveOverdue("0.00", "0.00")).toBe(0);
  });

  it("accepts numeric inputs", () => {
    expect(effectiveOverdue(1000, 250)).toBe(750);
  });

  it("treats null/undefined as zero", () => {
    expect(effectiveOverdue(null, undefined)).toBe(0);
    expect(effectiveOverdue("500.00", null)).toBe(500);
    expect(effectiveOverdue(undefined, "100.00")).toBe(0);
  });

  it("rounds to 2 decimal places to avoid float artifacts", () => {
    expect(effectiveOverdue("0.3", "0")).toBe(0.3);
    expect(effectiveOverdue("100.10", "50.05")).toBe(50.05);
  });

  it("treats non-numeric strings as zero", () => {
    expect(effectiveOverdue("not a number", "100")).toBe(0);
    expect(effectiveOverdue("500", "not a number")).toBe(500);
  });
});
