// Auto-release decisions with customer rules (PURE).
//
// The existing auto-clear pass (orders/hold-alerts.ts releaseResolvedHolds)
// releases a held order when its reason no longer applies — driven by QBO
// data (overdue balance below threshold / invoices paid), Shopify payment
// status, or the customer being taken off hold. Customer rules add:
//
//   - reason "customer_rule": still applies while the customer's rule would
//     still hold them today (evaluateCustomerRule over their current QBO
//     invoices). If the rule was deleted or set to "never", the hold is NOT
//     auto-released — a hold the system can no longer explain waits for a
//     person (same principle as "manual").
//   - the per-rule auto_release_on_payment switch: when a customer HAS a rule
//     with the switch OFF, their payment-driven holds (customer_rule,
//     overdue_non_communicating, payment_upfront_unpaid) are never
//     auto-released. "customer_on_hold" still clears when someone takes the
//     account off hold — that's a deliberate human action, not a payment.
//   - customers WITHOUT a rule: behaviour unchanged.

export const PAYMENT_DRIVEN_REASONS = new Set([
  "customer_rule",
  "overdue_non_communicating",
  "payment_upfront_unpaid",
]);

export type AutoReleaseInput = {
  reason: string | null;
  // The customer's rule, if they have one.
  rule: { preset: string; autoReleaseOnPayment: boolean } | null;
  // Standard reasons: holdReasonStillApplies(). Ignored for customer_rule.
  standardStillApplies: boolean;
  // customer_rule only: does the rule still hold them today?
  ruleStillHolds: boolean;
};

/** True = release now. */
export function shouldAutoRelease(input: AutoReleaseInput): boolean {
  const reason = input.reason ?? "";
  if (input.rule && !input.rule.autoReleaseOnPayment && PAYMENT_DRIVEN_REASONS.has(reason)) {
    return false;
  }
  if (reason === "customer_rule") {
    if (!input.rule || input.rule.preset === "never") return false;
    return !input.ruleStillHolds;
  }
  return !input.standardStillApplies;
}
