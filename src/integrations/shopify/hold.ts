// Shopify customer matching + tag mutation helpers for the hold/release
// feature. "Put on hold" removes the configured B2B tag from the matched
// Shopify customer; "Release" re-adds it. The mutation surface is
// intentionally tag-array oriented (get → mutate locally → set) so the
// rest of the customer's Shopify tag set is preserved verbatim — we only
// touch the one tag.
//
// Match strategy: by email, exact-match. The spec calls for matching the
// finance-hub customer to a Shopify customer via the customers' primary
// email; Shopify's customers/search.json with `email:"foo@bar"` runs a
// case-insensitive exact-match on the email field.
//
// Auth: tokens injected by ShopifyClient from env. Hold mutations need
// the `write_customers` scope on the Admin API access token; reads only
// need `read_customers` (already granted in week-4 setup).
//
// Returned tag arrays are normalized: trimmed, lowercased, de-duplicated
// while preserving first-seen order. Shopify itself stores tags as a
// single comma-joined string and returns them that way; we split on
// commas, trim each entry, and round-trip through the same normalizer
// when writing so we never persist whitespace-padded tags.

import type { ShopifyClient } from "./client.js";
import type { ShopifyCustomer } from "./types.js";

// Splits Shopify's comma-joined tags string into a normalized array.
// Empty/whitespace-only entries are dropped.
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Joins a tag array back into the comma-string Shopify expects on PUT.
function joinTags(tags: string[]): string {
  return tags.join(", ");
}

// Looks up a Shopify customer record by email (exact-match). Returns
// null when no Shopify customer exists for the address. Email is lower-
// cased + trimmed before the search; an empty/null input returns null
// without hitting the API.
export async function findCustomerByEmail(
  client: ShopifyClient,
  email: string | null | undefined,
): Promise<ShopifyCustomer | null> {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return null;

  // Shopify's email-exact-match operator. Quoting handles addresses with
  // periods or plus-signs the parser would otherwise tokenize.
  const query = `email:"${normalized}"`;
  const path = `/customers/search.json?query=${encodeURIComponent(query)}&fields=id,email,first_name,last_name,tags,state,default_address,created_at,updated_at&limit=1`;

  const { data } = await client.getJson<{ customers?: ShopifyCustomer[] }>(path);
  const match = data.customers?.[0];
  return match ?? null;
}

// Fetches a single customer by id and returns the parsed tag array.
// Does NOT swallow errors — callers handle network/API failures.
export async function getCustomerTags(
  client: ShopifyClient,
  shopifyCustomerId: number | string,
): Promise<string[]> {
  const path = `/customers/${shopifyCustomerId}.json?fields=id,tags`;
  const { data } = await client.getJson<{ customer?: { tags?: string } }>(path);
  return parseTags(data.customer?.tags);
}

// Writes the full tag set back to Shopify. The PUT body uses the
// `customer` envelope with `tags` as a comma-joined string — Shopify
// rejects array-shaped tags on this endpoint. Caller is responsible for
// having normalized the tags array first (parseTags + addTag/removeTag
// do this).
export async function setCustomerTags(
  client: ShopifyClient,
  shopifyCustomerId: number | string,
  tags: string[],
): Promise<void> {
  const path = `/customers/${shopifyCustomerId}.json`;
  const body = JSON.stringify({
    customer: {
      id: Number(shopifyCustomerId),
      tags: joinTags(tags),
    },
  });
  const res = await client.request(path, { method: "PUT", body });
  if (!res.ok) {
    const text = await res.text();
    // Surface the same error type as the rest of the client so callers
    // can inspect status (e.g. 403 → write_customers scope missing).
    const { ShopifyApiError } = await import("./client.js");
    throw new ShopifyApiError(res.status, path, text);
  }
}

// Adds a tag if not already present. Idempotent: returns the resulting
// tag array either way. The tag is normalized (trim + lowercase) before
// comparison so we never end up with "B2B" alongside "b2b".
export async function addTag(
  client: ShopifyClient,
  shopifyCustomerId: number | string,
  tag: string,
): Promise<{ tagsAfter: string[] }> {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    throw new Error("addTag: tag must be non-empty");
  }
  const current = await getCustomerTags(client, shopifyCustomerId);
  if (current.includes(normalized)) {
    return { tagsAfter: current };
  }
  const next = [...current, normalized];
  await setCustomerTags(client, shopifyCustomerId, next);
  return { tagsAfter: next };
}

// Removes a tag if present. Idempotent: returns the resulting tag array
// either way. Comparison is case-insensitive after the same normalize
// pass parseTags applies on read.
export async function removeTag(
  client: ShopifyClient,
  shopifyCustomerId: number | string,
  tag: string,
): Promise<{ tagsAfter: string[] }> {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    throw new Error("removeTag: tag must be non-empty");
  }
  const current = await getCustomerTags(client, shopifyCustomerId);
  if (!current.includes(normalized)) {
    return { tagsAfter: current };
  }
  const next = current.filter((t) => t !== normalized);
  await setCustomerTags(client, shopifyCustomerId, next);
  return { tagsAfter: next };
}
