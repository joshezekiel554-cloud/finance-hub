// Hardcoded list of feldart's own outbound addresses. Used in two places:
//
//   - gmail/poller.ts → getOutboundAddressSet: direction classification now
//     uses the live Gmail sendAs alias list (listAliases, 5-min cached);
//     this set is merged in as a hard fallback so classification keeps
//     working when the Gmail settings API is unavailable.
//   - qb/sync.ts → parseBillingEmails: filtered out so they never end up
//     in customers.billing_emails. Putting our own address in a
//     customer's billing_emails causes the per-customer email backfill
//     to over-match (the query becomes "from:info@feldart.com OR
//     to:info@feldart.com" — i.e., the entire business inbox).

export const BUSINESS_EMAILS = new Set<string>([
  "info@feldart.com",
  "accounts@feldart.com",
  "admin@feldart.co.uk",
  "sales@feldart.com",
]);

export function isBusinessEmail(address: string): boolean {
  return BUSINESS_EMAILS.has(address.toLowerCase());
}
