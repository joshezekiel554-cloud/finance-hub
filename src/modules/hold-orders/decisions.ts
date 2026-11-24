// Pending operator decisions — each is a ONE-LINE switch. Both code paths
// exist and are tested; flip the constant once the operator decides.

// H8: when a hold auto-releases on payment (QBO shows it paid / reason
// resolved), email the warehouse "✅ CLEARED — good to send" — but ONLY when
// the warehouse was alerted about that hold (a hold-alert thread exists).
// false = today's behaviour: auto-releases email nobody.
export const AUTO_RELEASE_EMAILS_WAREHOUSE_IF_ALERTED = false;

// H9: should an active customer promise-to-pay (customers.promised_pay_by
// today or later) block NEW customer-rule holds? false = today's behaviour:
// the rule still holds; the promise only pauses the customer email ladder.
export const RULE_HOLDS_RESPECT_PROMISE = false;
