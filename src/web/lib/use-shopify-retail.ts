// Shopify storefront retail price per SKU, for reference on Invoicing Today.
// Keyed by the sorted SKU set so cards asking for the same SKUs share a fetch.
// Returns a map keyed by UPPER-CASED SKU; missing SKUs aren't in Shopify.

import { useQuery } from "@tanstack/react-query";
import type { RetailPriceHit } from "../components/invoicing/extensiv-shipment";

export function useShopifyRetailPrices(skus: string[]): {
  prices: Map<string, RetailPriceHit>;
  isLoading: boolean;
  isError: boolean;
} {
  const key = Array.from(new Set(skus.map((s) => s.trim().toUpperCase())))
    .filter((s) => s.length > 0)
    .sort();
  const q = useQuery({
    queryKey: ["invoicing", "shopify-retail", key],
    enabled: key.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 1,
    queryFn: async (): Promise<Record<string, RetailPriceHit>> => {
      const res = await fetch("/api/invoicing/shopify-retail-prices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skus: key.slice(0, 100) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { prices?: Record<string, RetailPriceHit> };
      return body.prices ?? {};
    },
  });
  const prices = new Map<string, RetailPriceHit>(Object.entries(q.data ?? {}));
  return { prices, isLoading: q.isLoading && key.length > 0, isError: q.isError };
}
