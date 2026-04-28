// Shopify orders read API.
//
// Surface for week-4 B2B invoicing reconciler:
//   getOrderByName  - fetches a single order by its display name (e.g. "#18301").
//                     The Feldart shipment parser produces "SHOP18301"; we strip
//                     the prefix and prepend "#" to match Shopify's filter.
//   listOrdersSince - cursor-paginated incremental sync over updated_at_min.
//
// Field set is narrowed via the `fields=` query param to keep payloads small.
// All read endpoints honor X-Shopify-Access-Token from the client config.

import type { ShopifyClient } from "./client.js";
import type { ShopifyOrder } from "./types.js";

const ORDER_FIELDS = [
  "id",
  "name",
  "order_number",
  "email",
  "created_at",
  "updated_at",
  "processed_at",
  "cancelled_at",
  "closed_at",
  "fulfillment_status",
  "financial_status",
  "currency",
  "total_price",
  "subtotal_price",
  "total_tax",
  "note",
  "tags",
  "customer",
  "shipping_address",
  "billing_address",
  "line_items",
].join(",");

export type ListOrdersOptions = {
  // ISO timestamp; only orders updated at-or-after this point are returned.
  updatedAtMin?: string;
  // status query: "any" includes archived/closed, default is "open".
  status?: "any" | "open" | "closed" | "cancelled";
  pageSize?: number;
  pageToken?: string | null;
};

// Fetch a single order by its display name. Shopify allows "name=" as a query
// filter; the API still returns an array, so we take the first hit. Returns
// null when nothing matches (Shopify returns 200 + empty array, not 404).
export async function getOrderByName(
  client: ShopifyClient,
  name: string,
): Promise<ShopifyOrder | null> {
  // Normalize: accept "18301", "#18301", or "SHOP18301".
  const normalized = normalizeOrderName(name);
  const path = `/orders.json?status=any&name=${encodeURIComponent(normalized)}&fields=${ORDER_FIELDS}`;
  const { data } = await client.getJson<{ orders: ShopifyOrder[] }>(path);
  return data.orders[0] ?? null;
}

// Single page of an incremental orders sweep. Caller drives pagination by
// passing back the previous page's `next` until it returns null.
export async function listOrdersSince(
  client: ShopifyClient,
  opts: ListOrdersOptions = {},
) {
  const params = new URLSearchParams();
  params.set("status", opts.status ?? "any");
  params.set("limit", String(opts.pageSize ?? 250));
  params.set("fields", ORDER_FIELDS);
  if (opts.updatedAtMin) {
    params.set("updated_at_min", opts.updatedAtMin);
  }
  const path = `/orders.json?${params.toString()}`;
  return client.getPage<ShopifyOrder>({
    path,
    extract: (raw) => (raw as { orders?: ShopifyOrder[] }).orders ?? [],
    pageToken: opts.pageToken ?? null,
  });
}

// "SHOP18301", "shop18301", "#18301", "18301" -> "#18301"
export function normalizeOrderName(input: string): string {
  const trimmed = input.trim();
  const stripped = trimmed.replace(/^SHOP/i, "").replace(/^#/, "");
  return `#${stripped}`;
}
