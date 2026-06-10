// Shopify customer matching + tag mutation helpers for the hold/release
// feature. "Put on hold" removes the configured B2B tag from the matched
// Shopify customer; "Release" re-adds it.
//
// Tag writes go through the Admin GraphQL tagsAdd/tagsRemove mutations,
// which mutate individual tags atomically server-side. This eliminates
// the read-modify-write race the old REST flow had (audit #13): two
// concurrent toggles (operator + operator, or operator + autopilot) used
// to read the tag set, mutate it in JS, then PUT the FULL set back —
// clobbering each other's unrelated tags. With tagsAdd/tagsRemove only
// the named tags are touched; the rest of the customer's tag set is
// never rewritten. Requires the `write_customers` scope on the Admin
// token (already granted).
//
// Match strategy: by email, exact-match. The spec calls for matching the
// finance-hub customer to a Shopify customer via the customers' primary
// email; Shopify's customers/search.json with `email:"foo@bar"` runs a
// case-insensitive exact-match on the email field.
//
// Returned tag arrays are normalized: trimmed, lowercased, de-duplicated
// while preserving first-seen order. Shopify itself stores tags as a
// single comma-joined string and returns them that way; we split on
// commas and trim each entry. Input tags are normalized the same way
// before mutating — Shopify tags are case-preserving but
// case-insensitively unique, so we never end up with "B2B" alongside
// "b2b".

import type { ShopifyClient } from "./client.js";
import type { ShopifyCustomer } from "./types.js";

// Atomic single-tag mutations. tagsAdd/tagsRemove are idempotent on the
// Shopify side (adding a present tag / removing an absent tag is a
// no-op) and only touch the named tags — never the full set.
const TAGS_ADD = `mutation tagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;
const TAGS_REMOVE = `mutation tagsRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
}`;

type TagMutationName = "tagsAdd" | "tagsRemove";

type TagMutationData = Record<
  TagMutationName,
  { userErrors?: Array<{ field?: string[] | null; message: string }> } | null
>;

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

// GraphQL node id for a customer given its numeric REST id.
function customerGid(shopifyCustomerId: number | string): string {
  return `gid://shopify/Customer/${shopifyCustomerId}`;
}

// Runs one tagsAdd/tagsRemove mutation and throws when Shopify reports
// userErrors (top-level GraphQL errors already throw inside
// client.graphql as ShopifyApiError).
async function runTagsMutation(
  client: ShopifyClient,
  mutationName: TagMutationName,
  shopifyCustomerId: number | string,
  tags: string[],
): Promise<void> {
  const mutation = mutationName === "tagsAdd" ? TAGS_ADD : TAGS_REMOVE;
  const data = await client.graphql<Partial<TagMutationData>>(mutation, {
    id: customerGid(shopifyCustomerId),
    tags,
  });
  const userErrors = data[mutationName]?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `shopify ${mutationName} failed for customer ${shopifyCustomerId}: ${userErrors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }
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

// Reconciles the customer's tag set toward `tags` using atomic
// tagsAdd/tagsRemove mutations — NOT a full-set REST PUT (audit #13).
// We read the current set fresh, diff it against the desired set, and
// only mutate the delta; tags present in both are never rewritten, so a
// concurrent unrelated tag change can no longer be clobbered by the
// write itself. (The caller's desired set is still computed from its
// own earlier read — for hold flips the delta only ever contains the
// b2b/upfront tags, which is the intent.)
export async function setCustomerTags(
  client: ShopifyClient,
  shopifyCustomerId: number | string,
  tags: string[],
): Promise<void> {
  const desired = new Set<string>();
  for (const t of tags) {
    const normalized = t.trim().toLowerCase();
    if (normalized) desired.add(normalized);
  }
  const current = await getCustomerTags(client, shopifyCustomerId);
  const currentSet = new Set(current);
  const toAdd = [...desired].filter((t) => !currentSet.has(t));
  const toRemove = current.filter((t) => !desired.has(t));
  if (toAdd.length > 0) {
    await runTagsMutation(client, "tagsAdd", shopifyCustomerId, toAdd);
  }
  if (toRemove.length > 0) {
    await runTagsMutation(client, "tagsRemove", shopifyCustomerId, toRemove);
  }
}

// Adds a tag via an atomic tagsAdd mutation. Idempotent (Shopify no-ops
// when the tag is already present) and touches ONLY this tag — no
// read-modify-write of the full set. The tag is normalized (trim +
// lowercase) before sending so we never end up with "B2B" alongside
// "b2b". Returns the fresh post-mutation tag set.
export async function addTag(
  client: ShopifyClient,
  shopifyCustomerId: number | string,
  tag: string,
): Promise<{ tagsAfter: string[] }> {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    throw new Error("addTag: tag must be non-empty");
  }
  await runTagsMutation(client, "tagsAdd", shopifyCustomerId, [normalized]);
  const tagsAfter = await getCustomerTags(client, shopifyCustomerId);
  return { tagsAfter };
}

// Removes a tag via an atomic tagsRemove mutation. Idempotent (Shopify
// no-ops when the tag is absent) and touches ONLY this tag. Same
// normalize pass as addTag. Returns the fresh post-mutation tag set.
export async function removeTag(
  client: ShopifyClient,
  shopifyCustomerId: number | string,
  tag: string,
): Promise<{ tagsAfter: string[] }> {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    throw new Error("removeTag: tag must be non-empty");
  }
  await runTagsMutation(client, "tagsRemove", shopifyCustomerId, [normalized]);
  const tagsAfter = await getCustomerTags(client, shopifyCustomerId);
  return { tagsAfter };
}
