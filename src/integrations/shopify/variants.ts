// Shopify catalogue lookups by SKU.
//
// Used by Invoicing Today: when the warehouse ships an item that wasn't on
// the Shopify order (or the shipment isn't a Shopify order at all), the
// operator has to type a price by hand. Showing the storefront retail price
// next to that box saves a trip to the Shopify admin.
//
// One Admin GraphQL call per chunk of SKUs. Shopify's `sku:` search is
// token-based (a hyphenated SKU can match others), so results are filtered
// back down to exact, case-insensitive SKU matches here.

import type { ShopifyClient } from "./client.js";

export type RetailPrice = {
  sku: string;
  price: number;
  compareAtPrice: number | null;
  productTitle: string;
  variantTitle: string | null;
  productStatus: string | null;
};

type VariantNode = {
  sku: string | null;
  price: string | null;
  compareAtPrice: string | null;
  title: string | null;
  product: { title: string; status: string | null } | null;
};

const QUERY = `query RetailBySku($q: String!, $first: Int!) {
  productVariants(first: $first, query: $q) {
    nodes { sku price compareAtPrice title product { title status } }
  }
}`;

// Keep each search string modest: Shopify caps query length and the cost of
// `first` scales the request's point cost.
const CHUNK = 25;

// Shopify search syntax: quote the value and escape backslashes/quotes so a
// SKU can never break out of its term.
export function skuSearchTerm(sku: string): string {
  return `sku:"${sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Prefer an ACTIVE product's variant when several share a SKU.
function rank(node: VariantNode): number {
  return node.product?.status === "ACTIVE" ? 0 : 1;
}

// Returns a map keyed by UPPER-CASED SKU. SKUs with no exact match in the
// catalogue are simply absent from the map.
export async function getRetailPricesBySku(
  client: ShopifyClient,
  skus: string[],
): Promise<Map<string, RetailPrice>> {
  const wanted = Array.from(
    new Set(skus.map((s) => s.trim()).filter((s) => s.length > 0)),
  );
  const out = new Map<string, RetailPrice>();
  const best = new Map<string, number>();

  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const wantedUpper = new Set(chunk.map((s) => s.toUpperCase()));
    const q = chunk.map(skuSearchTerm).join(" OR ");
    const data = await client.graphql<{
      productVariants: { nodes: VariantNode[] };
    }>(QUERY, { q, first: Math.min(250, chunk.length * 4) });

    for (const node of data.productVariants.nodes) {
      if (!node.sku || node.price === null) continue;
      const key = node.sku.trim().toUpperCase();
      if (!wantedUpper.has(key)) continue;
      const price = Number(node.price);
      if (!Number.isFinite(price)) continue;
      const r = rank(node);
      const prev = best.get(key);
      if (prev !== undefined && prev <= r) continue;
      best.set(key, r);
      const compareAt =
        node.compareAtPrice !== null ? Number(node.compareAtPrice) : null;
      out.set(key, {
        sku: node.sku,
        price,
        compareAtPrice:
          compareAt !== null && Number.isFinite(compareAt) ? compareAt : null,
        productTitle: node.product?.title ?? "",
        variantTitle:
          node.title && node.title !== "Default Title" ? node.title : null,
        productStatus: node.product?.status ?? null,
      });
    }
  }
  return out;
}
