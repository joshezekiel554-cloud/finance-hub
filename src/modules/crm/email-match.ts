// Shared "find this customer's emails" matcher.
//
// A customer's emails are matched by their ADDRESS-SET (primary + billing +
// invoice/statement "to"), not just the stored email_log.customerId link. The
// link is lossy: with the origin split, one real business can have TWO customer
// records sharing an email, so an email to that address attaches to only one
// record (or, when an address is shared across records, gets orphaned with a
// NULL customerId by the unambiguous-matching guard). Matching by address makes
// every AI surface (card, autopilot drafter, agent) see the full conversation
// regardless — the same way the Inbox board matches.

import { eq, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog } from "../../db/schema/crm.js";

export type CustomerAddrFields = {
  primaryEmail: string | null;
  billingEmails: string[] | null;
  invoiceToEmails: string[] | null;
  statementToEmails: string[] | null;
};

// Deduped, lowercased set of the customer's own addresses.
export function customerAddrSet(c: CustomerAddrFields): string[] {
  const out = new Set<string>();
  const add = (e: unknown) => {
    if (typeof e === "string" && e.trim()) out.add(e.trim().toLowerCase());
  };
  add(c.primaryEmail);
  for (const arr of [c.billingEmails, c.invoiceToEmails, c.statementToEmails]) {
    if (Array.isArray(arr)) for (const e of arr) add(e);
  }
  return [...out];
}

// Build a one-shot lowercased email → customerId index over ALL customers, for
// matching an inbound thing (an order, an email) to a customer. Only
// UNAMBIGUOUS addresses (belonging to exactly one customer) are included —
// shared addresses are dropped rather than mis-attributed. Matches the Gmail
// poller's index semantics.
export async function buildCustomerEmailIndex(): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: customers.id,
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
      invoiceToEmails: customers.invoiceToEmails,
      statementToEmails: customers.statementToEmails,
    })
    .from(customers);
  const addrToCustomers = new Map<string, Set<string>>();
  const add = (email: unknown, id: string) => {
    if (typeof email !== "string") return;
    const key = email.trim().toLowerCase();
    if (!key) return;
    const set = addrToCustomers.get(key) ?? new Set<string>();
    set.add(id);
    addrToCustomers.set(key, set);
  };
  for (const r of rows) {
    add(r.primaryEmail, r.id);
    for (const arr of [r.billingEmails, r.invoiceToEmails, r.statementToEmails]) {
      if (Array.isArray(arr)) for (const e of arr) add(e, r.id);
    }
  }
  const index = new Map<string, string>();
  for (const [addr, ids] of addrToCustomers) {
    if (ids.size === 1) index.set(addr, ids.values().next().value as string);
  }
  return index;
}

// SQL predicate: emails linked to this customer id OR to/from any of the
// customer's addresses. Pass to `.where(...)`.
export function emailMatchForCustomer(
  customerId: string,
  c: CustomerAddrFields,
) {
  const conds = [eq(emailLog.customerId, customerId)];
  for (const a of customerAddrSet(c)) {
    conds.push(sql`lower(${emailLog.fromAddress}) LIKE ${`%${a}%`}`);
    conds.push(sql`lower(${emailLog.toAddress}) LIKE ${`%${a}%`}`);
  }
  return or(...conds);
}
