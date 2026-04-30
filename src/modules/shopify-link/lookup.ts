// ID-first Shopify customer lookup.
//
// The historical pattern (findCustomerByEmail every time we need a
// Shopify record) breaks when QBO's primary contact and Shopify's
// account email diverge — the lookup quietly returns the wrong record
// or nothing. The audit's Eichlers BP false-positive was the canonical
// failure: QBO had motti@neweichlers.com, Shopify had junior@.
//
// This module routes every Shopify lookup through the cached
// customers.shopifyCustomerId when present, and only falls back to
// email matching (primary first, then each billing email) when the
// cached id is null. A successful email lookup persists the id so the
// next call is a single-GET-by-id rather than another email guess.
//
// Multiple emails matching DIFFERENT Shopify ids → ambiguous, returns
// no result + an `ambiguous` flag so the caller can flag the row in
// the audit / link UI rather than silently picking one.

import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import {
  ShopifyClient,
  ShopifyApiError,
} from "../../integrations/shopify/client.js";
import { findCustomerByEmail } from "../../integrations/shopify/hold.js";
import type { ShopifyCustomer } from "../../integrations/shopify/types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "shopify-link.lookup" });

export type LinkResolution =
  | {
      kind: "by_id";
      customer: ShopifyCustomer;
      shopifyCustomerId: string;
    }
  | {
      kind: "by_email";
      customer: ShopifyCustomer;
      shopifyCustomerId: string;
      matchedEmail: string;
      // True when this email lookup is the first time we've resolved
      // the link — caller should persist `customers.shopifyCustomerId`.
      // The lookup helper does the persist itself by default; the flag
      // is exposed for callers that want to suppress (e.g. dry-run).
      newlyDiscovered: boolean;
    }
  | {
      kind: "ambiguous";
      // Distinct Shopify ids each email resolved to (lower-cased emails →
      // shopify id). Caller surfaces these in the manual-link UI.
      candidatesByEmail: Record<string, string>;
    }
  | { kind: "none" };

export type LinkLookupInput = {
  customerId: string;
  shopifyCustomerId: string | null;
  primaryEmail: string | null;
  billingEmails: string[] | null;
};

// Get a Shopify customer by ID. Returns null on 404 (the cached id is
// stale because the Shopify customer was deleted, etc.). Throws on
// other errors so the caller can decide.
async function fetchById(
  client: ShopifyClient,
  shopifyCustomerId: string,
): Promise<ShopifyCustomer | null> {
  const path = `/customers/${encodeURIComponent(shopifyCustomerId)}.json?fields=id,email,first_name,last_name,tags,state,default_address,created_at,updated_at`;
  try {
    const { data } = await client.getJson<{ customer?: ShopifyCustomer }>(
      path,
    );
    return data.customer ?? null;
  } catch (err) {
    if (err instanceof ShopifyApiError && err.status === 404) {
      log.warn(
        { shopifyCustomerId },
        "cached shopify id no longer exists; clearing on next email match",
      );
      return null;
    }
    throw err;
  }
}

// Distinct ordered list of (lower-cased) emails to try for a customer.
// Primary first, then billing emails minus the primary. Empty/null
// entries dropped, dedupe preserves first occurrence.
function collectEmails(input: LinkLookupInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  function push(e: string | null | undefined) {
    if (!e) return;
    const norm = e.trim().toLowerCase();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  }
  push(input.primaryEmail);
  if (Array.isArray(input.billingEmails)) {
    for (const e of input.billingEmails) push(e);
  }
  return out;
}

// Persist a discovered ID. Best-effort: a write failure shouldn't
// block the lookup result the caller needs.
async function persistShopifyId(
  customerId: string,
  shopifyCustomerId: string,
): Promise<void> {
  try {
    await db
      .update(customers)
      .set({ shopifyCustomerId })
      .where(eq(customers.id, customerId));
  } catch (err) {
    log.warn(
      { err, customerId, shopifyCustomerId },
      "persist shopifyCustomerId failed — lookup result still returned",
    );
  }
}

// Main entry point. Tries cache first, then emails. When emails return
// multiple distinct ids, surfaces ambiguous. When all paths return
// nothing, surfaces none. Persists newly-discovered ids by default;
// pass { persist: false } for dry-run semantics.
export async function findShopifyCustomer(
  input: LinkLookupInput,
  client: ShopifyClient,
  opts: { persist?: boolean } = {},
): Promise<LinkResolution> {
  const persist = opts.persist !== false;

  // 1. Cached ID path.
  if (input.shopifyCustomerId) {
    const customer = await fetchById(client, input.shopifyCustomerId);
    if (customer) {
      return {
        kind: "by_id",
        customer,
        shopifyCustomerId: String(customer.id),
      };
    }
    // Stale cache — fall through to email lookup. Don't clear the
    // column yet; only overwrite when we find a fresh successful match.
  }

  // 2. Email path. Track each lookup result so we can detect ambiguity.
  const candidatesByEmail: Record<string, string> = {};
  let firstHit: { customer: ShopifyCustomer; email: string } | null = null;
  for (const email of collectEmails(input)) {
    let customer: ShopifyCustomer | null = null;
    try {
      customer = await findCustomerByEmail(client, email);
    } catch (err) {
      log.warn(
        { err, customerId: input.customerId, email },
        "shopify email lookup threw — continuing to next email",
      );
      continue;
    }
    if (!customer) continue;
    const id = String(customer.id);
    candidatesByEmail[email] = id;
    if (!firstHit) firstHit = { customer, email };
  }

  const distinctIds = new Set(Object.values(candidatesByEmail));
  if (distinctIds.size > 1) {
    return { kind: "ambiguous", candidatesByEmail };
  }
  if (firstHit) {
    const id = String(firstHit.customer.id);
    const newlyDiscovered = input.shopifyCustomerId !== id;
    if (persist && newlyDiscovered) {
      await persistShopifyId(input.customerId, id);
    }
    return {
      kind: "by_email",
      customer: firstHit.customer,
      shopifyCustomerId: id,
      matchedEmail: firstHit.email,
      newlyDiscovered,
    };
  }
  return { kind: "none" };
}

// Generic Shopify customer search for the manual link UI. Picks the
// right strategy based on what the operator typed:
//
//   pure digits → GET /customers/{id} directly. Fastest path; lets the
//                 operator paste a Shopify customer id straight from the
//                 admin URL without us guessing what to search for.
//   contains @  → email:"foo" exact match. Same shape as the standard
//                 lookup elsewhere.
//   anything    → search across company:, first_name:, last_name:.
//                 OR-joined so "Eichlers" matches both a company name
//                 and a person's surname.
//
// Returns up to `limit` results in every case. Errors propagate.
export async function searchShopifyByCompany(
  client: ShopifyClient,
  rawQuery: string,
  limit = 10,
): Promise<ShopifyCustomer[]> {
  const trimmed = rawQuery.trim();
  if (!trimmed) return [];

  const fieldList =
    "id,email,first_name,last_name,tags,state,default_address,created_at,updated_at";

  // 1. Pure-numeric → direct GET by id.
  if (/^\d+$/.test(trimmed)) {
    try {
      const { data } = await client.getJson<{ customer?: ShopifyCustomer }>(
        `/customers/${encodeURIComponent(trimmed)}.json?fields=${fieldList}`,
      );
      return data.customer ? [data.customer] : [];
    } catch (err) {
      if (err instanceof ShopifyApiError && err.status === 404) return [];
      throw err;
    }
  }

  // 2. Looks like an email → exact-match email search.
  if (trimmed.includes("@")) {
    const query = `email:"${trimmed.toLowerCase()}"`;
    const path = `/customers/search.json?query=${encodeURIComponent(query)}&fields=${fieldList}&limit=${limit}`;
    const { data } = await client.getJson<{ customers?: ShopifyCustomer[] }>(
      path,
    );
    return data.customers ?? [];
  }

  // 3. Free-form text → multi-field OR search. company: matches the
  // default address's company; first_name/last_name catch contact
  // names. Quoting handles multi-word values like "Eichlers Judaica".
  const q = `"${trimmed}"`;
  const query = `company:${q} OR first_name:${q} OR last_name:${q}`;
  const path = `/customers/search.json?query=${encodeURIComponent(query)}&fields=${fieldList}&limit=${limit}`;
  const { data } = await client.getJson<{ customers?: ShopifyCustomer[] }>(
    path,
  );
  return data.customers ?? [];
}
