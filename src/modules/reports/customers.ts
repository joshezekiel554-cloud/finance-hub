// Customer picker for Feldart AI report forms: name/email substring search.

import { asc, like, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";

export type CustomerOption = { id: string; name: string; email: string | null };

/** Escape LIKE wildcards so a typed "%" or "_" matches literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchCustomerOptions(q: string, limit = 20): Promise<CustomerOption[]> {
  const pattern = likePattern(q.trim());
  return db
    .select({ id: customers.id, name: customers.displayName, email: customers.primaryEmail })
    .from(customers)
    .where(or(like(customers.displayName, pattern), like(customers.primaryEmail, pattern)))
    .orderBy(asc(customers.displayName))
    .limit(limit);
}
