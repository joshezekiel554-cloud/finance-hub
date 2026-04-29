// Shopify customers — read API for the "import B2B by tag" sweep.
//
// Uses the customers/search.json endpoint which accepts a Shopify-search
// query like `tag:b2b` (case-insensitive substring match on the tag).
// Paginates via the standard Link-header cursor exposed by client.getPage.

import type { ShopifyClient } from "./client.js";
import type { Page, ShopifyCustomer } from "./types.js";

const CUSTOMER_FIELDS = [
  "id",
  "email",
  "first_name",
  "last_name",
  "tags",
  "state",
  "default_address",
  "created_at",
  "updated_at",
].join(",");

// Lists every Shopify customer matching the given search query — defaults
// to `tag:b2b` for the canonical use case. Iterates Shopify's pagination
// internally and returns the full set; callers don't need to think about
// page tokens. Cap is generous (10,000) but the customer-list backfill is
// a one-shot user action so we'd rather get the whole answer than paginate
// it back to the UI.
export async function listCustomersByQuery(
  client: ShopifyClient,
  query: string,
  opts: { pageSize?: number; cap?: number } = {},
): Promise<ShopifyCustomer[]> {
  const pageSize = opts.pageSize ?? 250;
  const cap = opts.cap ?? 10_000;
  const all: ShopifyCustomer[] = [];
  let pageToken: string | null = null;

  do {
    const page: Page<ShopifyCustomer> = await client.getPage<ShopifyCustomer>({
      path: `/customers/search.json?query=${encodeURIComponent(query)}&fields=${CUSTOMER_FIELDS}&limit=${pageSize}`,
      pageToken,
      extract: (raw): ShopifyCustomer[] =>
        (raw as { customers?: ShopifyCustomer[] }).customers ?? [],
    });
    all.push(...page.items);
    if (all.length >= cap) break;
    pageToken = page.next;
  } while (pageToken);

  return all.slice(0, cap);
}

// Convenience wrapper for the common case.
export async function listCustomersByTag(
  client: ShopifyClient,
  tag: string,
): Promise<ShopifyCustomer[]> {
  // Shopify's search syntax: `tag:b2b` matches customers whose tags array
  // contains b2b. Tags with spaces need quoting; bare-word tags (the usual
  // case for "b2b", "wholesale", etc.) work directly.
  const trimmed = tag.trim();
  const query = /\s/.test(trimmed) ? `tag:"${trimmed}"` : `tag:${trimmed}`;
  return listCustomersByQuery(client, query);
}
