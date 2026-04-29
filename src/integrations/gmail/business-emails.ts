// Hardcoded list of feldart's own outbound addresses. Used in two places:
//
//   - gmail/poller.ts → classifyDirection: messages FROM these are
//     outbound (we sent them); everything else is inbound.
//   - qb/sync.ts → parseBillingEmails: filtered out so they never end up
//     in customers.billing_emails. Putting our own address in a
//     customer's billing_emails causes the per-customer email backfill
//     to over-match (the query becomes "from:info@feldart.com OR
//     to:info@feldart.com" — i.e., the entire business inbox).
//
// TODO(week-7): replace with listAliases() result so adding a new sendAs
// inside Gmail automatically classifies outbound without a code change.

export const BUSINESS_EMAILS = new Set<string>([
  "info@feldart.com",
  "accounts@feldart.com",
  "admin@feldart.co.uk",
  "sales@feldart.com",
]);

export function isBusinessEmail(address: string): boolean {
  return BUSINESS_EMAILS.has(address.toLowerCase());
}
