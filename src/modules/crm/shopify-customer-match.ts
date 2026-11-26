// Match Shopify customers to finance customers by email. Shared by the
// customers "import b2b from Shopify" sweep (routes/customers.ts) and the
// Hold Orders bulk rule picker.
//
// Match key: customers.primary_email, case-insensitive. The billingEmails
// JSON array could also match in theory but QB customers are keyed on a
// single primary email in practice — covers the 99% case without per-row
// JSON_CONTAINS calls.

import { inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import type { ShopifyCustomer } from "../../integrations/shopify/types.js";

export function normalizeEmail(e: string | null | undefined): string | null {
  const s = (e ?? "").trim().toLowerCase();
  return s ? s : null;
}

export type FinanceMatch = { id: string; displayName: string; email: string | null };

export type ShopifyMatchResult = {
  matched: FinanceMatch[];
  // Shopify customers with no finance/QBO customer on that email (or no email).
  unmatched: Array<{ shopifyId: string; name: string; email: string | null }>;
};

function shopifyName(c: Pick<ShopifyCustomer, "first_name" | "last_name" | "email">): string {
  const n = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return n || c.email || "(no name)";
}

/** PURE: split Shopify customers into matched finance rows + unmatched. */
export function splitShopifyMatches(
  shopify: ReadonlyArray<Pick<ShopifyCustomer, "id" | "email" | "first_name" | "last_name">>,
  finance: readonly FinanceMatch[],
): ShopifyMatchResult {
  const byEmail = new Map<string, FinanceMatch[]>();
  for (const f of finance) {
    const k = normalizeEmail(f.email);
    if (!k) continue;
    const list = byEmail.get(k) ?? [];
    list.push(f);
    byEmail.set(k, list);
  }
  const matched = new Map<string, FinanceMatch>();
  const unmatched: ShopifyMatchResult["unmatched"] = [];
  for (const s of shopify) {
    const k = normalizeEmail(s.email);
    const hits = k ? byEmail.get(k) : undefined;
    if (hits && hits.length > 0) for (const h of hits) matched.set(h.id, h);
    else unmatched.push({ shopifyId: String(s.id), name: shopifyName(s), email: s.email ?? null });
  }
  return { matched: [...matched.values()], unmatched };
}

/** Look up finance customers for a Shopify customer list. */
export async function matchShopifyCustomers(
  shopify: ReadonlyArray<Pick<ShopifyCustomer, "id" | "email" | "first_name" | "last_name">>,
): Promise<ShopifyMatchResult> {
  const emails = Array.from(
    new Set(shopify.map((c) => normalizeEmail(c.email)).filter((e): e is string => Boolean(e))),
  );
  const finance: FinanceMatch[] = [];
  for (let i = 0; i < emails.length; i += 1000) {
    finance.push(
      ...(await db
        .select({ id: customers.id, displayName: customers.displayName, email: customers.primaryEmail })
        .from(customers)
        .where(inArray(customers.primaryEmail, emails.slice(i, i + 1000)))),
    );
  }
  return splitShopifyMatches(shopify, finance);
}
