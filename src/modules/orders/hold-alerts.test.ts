import { describe, expect, it } from "vitest";
import {
  classifyOrderHoldAlert,
  holdReasonStillApplies,
  isPaymentPending,
} from "./hold-alerts.js";

describe("holdReasonStillApplies (auto-clear)", () => {
  const base = {
    holdStatus: "active" as string | null,
    financialStatus: "paid" as string | null,
    overdueBalance: "0" as string | null,
    overdueThresholdGbp: 1000,
  };

  it("customer_on_hold still applies only while the customer is on hold", () => {
    expect(
      holdReasonStillApplies({ ...base, reason: "customer_on_hold", holdStatus: "hold" }),
    ).toBe(true);
    expect(
      holdReasonStillApplies({ ...base, reason: "customer_on_hold", holdStatus: "active" }),
    ).toBe(false);
  });

  it("payment_upfront_unpaid clears once the order is paid", () => {
    expect(
      holdReasonStillApplies({
        ...base,
        reason: "payment_upfront_unpaid",
        holdStatus: "payment_upfront",
        financialStatus: "pending",
      }),
    ).toBe(true);
    expect(
      holdReasonStillApplies({
        ...base,
        reason: "payment_upfront_unpaid",
        holdStatus: "payment_upfront",
        financialStatus: "paid",
      }),
    ).toBe(false);
  });

  it("overdue_non_communicating clears once overdue drops below threshold", () => {
    expect(
      holdReasonStillApplies({
        ...base,
        reason: "overdue_non_communicating",
        overdueBalance: "1500",
      }),
    ).toBe(true);
    expect(
      holdReasonStillApplies({
        ...base,
        reason: "overdue_non_communicating",
        overdueBalance: "200",
      }),
    ).toBe(false);
  });

  it("releases on an unknown / null reason", () => {
    expect(holdReasonStillApplies({ ...base, reason: null })).toBe(false);
  });
});

describe("isPaymentPending", () => {
  it("treats null / empty as pending", () => {
    expect(isPaymentPending(null)).toBe(true);
    expect(isPaymentPending("")).toBe(true);
    expect(isPaymentPending("   ")).toBe(true);
  });

  it("treats unpaid Shopify statuses as pending", () => {
    expect(isPaymentPending("pending")).toBe(true);
    expect(isPaymentPending("authorized")).toBe(true);
    expect(isPaymentPending("partially_paid")).toBe(true);
  });

  it("treats settled statuses as not pending", () => {
    expect(isPaymentPending("paid")).toBe(false);
    expect(isPaymentPending("refunded")).toBe(false);
    expect(isPaymentPending("partially_refunded")).toBe(false);
    expect(isPaymentPending("voided")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPaymentPending("PAID")).toBe(false);
    expect(isPaymentPending("Pending")).toBe(true);
  });
});

describe("classifyOrderHoldAlert", () => {
  it("flags an order for a customer on hold", () => {
    expect(
      classifyOrderHoldAlert({
        cancelledAt: null,
        holdStatus: "hold",
        financialStatus: "paid",
      }),
    ).toBe("customer_on_hold");
  });

  it("flags a payment-upfront customer with an unpaid order", () => {
    expect(
      classifyOrderHoldAlert({
        cancelledAt: null,
        holdStatus: "payment_upfront",
        financialStatus: "pending",
      }),
    ).toBe("payment_upfront_unpaid");
  });

  it("does NOT flag a payment-upfront customer once the order is paid", () => {
    expect(
      classifyOrderHoldAlert({
        cancelledAt: null,
        holdStatus: "payment_upfront",
        financialStatus: "paid",
      }),
    ).toBeNull();
  });

  it("does NOT flag an active customer", () => {
    expect(
      classifyOrderHoldAlert({
        cancelledAt: null,
        holdStatus: "active",
        financialStatus: "pending",
      }),
    ).toBeNull();
  });

  it("never flags a cancelled order, even for a held customer", () => {
    expect(
      classifyOrderHoldAlert({
        cancelledAt: new Date(),
        holdStatus: "hold",
        financialStatus: "pending",
      }),
    ).toBeNull();
  });

  it("flags a payment-upfront order with null financial status (unconfirmed)", () => {
    expect(
      classifyOrderHoldAlert({
        cancelledAt: null,
        holdStatus: "payment_upfront",
        financialStatus: null,
      }),
    ).toBe("payment_upfront_unpaid");
  });
});
