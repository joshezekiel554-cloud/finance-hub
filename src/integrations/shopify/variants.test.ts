import { describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "./client.js";
import { getRetailPricesBySku, skuSearchTerm } from "./variants.js";

type Node = {
  sku: string | null;
  price: string | null;
  compareAtPrice?: string | null;
  title?: string | null;
  product?: { title: string; status: string | null } | null;
};

function makeClient(answer: (q: string) => Node[]) {
  const queries: string[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      variables: { q: string; first: number };
    };
    queries.push(body.variables.q);
    const nodes = answer(body.variables.q).map((n) => ({
      compareAtPrice: null,
      title: "Default Title",
      product: { title: "Product", status: "ACTIVE" },
      ...n,
    }));
    return new Response(
      JSON.stringify({ data: { productVariants: { nodes } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new ShopifyClient({
    shop: "test-shop.myshopify.com",
    accessToken: "shpat_TEST",
    apiVersion: "2026-01",
    fetchImpl,
    sleep: vi.fn(),
  });
  return { client, queries };
}

describe("skuSearchTerm", () => {
  it("quotes the SKU and escapes quotes/backslashes", () => {
    expect(skuSearchTerm("PHCR01G")).toBe('sku:"PHCR01G"');
    expect(skuSearchTerm('A"B\\C')).toBe('sku:"A\\"B\\\\C"');
  });
});

describe("getRetailPricesBySku", () => {
  it("returns exact, case-insensitive matches keyed by upper-cased SKU", async () => {
    const { client } = makeClient(() => [
      { sku: "PHCR01G", price: "76.00", title: "Gold", product: { title: "Classic Round Pan Holder", status: "ACTIVE" } },
      // Token search noise: a sibling SKU that wasn't asked for.
      { sku: "PHCR01G-XL", price: "99.00" },
    ]);
    const map = await getRetailPricesBySku(client, ["phcr01g"]);
    expect(map.size).toBe(1);
    expect(map.get("PHCR01G")).toEqual({
      sku: "PHCR01G",
      price: 76,
      compareAtPrice: null,
      productTitle: "Classic Round Pan Holder",
      variantTitle: "Gold",
      productStatus: "ACTIVE",
    });
  });

  it("omits SKUs that are not in the catalogue", async () => {
    const { client } = makeClient(() => []);
    const map = await getRetailPricesBySku(client, ["FTL03G-leather"]);
    expect(map.size).toBe(0);
  });

  it("prefers an ACTIVE product when several variants share a SKU", async () => {
    const { client } = makeClient(() => [
      { sku: "DUP1", price: "10.00", product: { title: "Old", status: "ARCHIVED" } },
      { sku: "DUP1", price: "12.00", product: { title: "New", status: "ACTIVE" } },
    ]);
    const map = await getRetailPricesBySku(client, ["DUP1"]);
    expect(map.get("DUP1")?.price).toBe(12);
    expect(map.get("DUP1")?.productTitle).toBe("New");
  });

  it("drops 'Default Title' variant names and keeps compare-at prices", async () => {
    const { client } = makeClient(() => [
      { sku: "X1", price: "20.00", compareAtPrice: "25.00", title: "Default Title" },
    ]);
    const map = await getRetailPricesBySku(client, ["X1"]);
    expect(map.get("X1")?.variantTitle).toBeNull();
    expect(map.get("X1")?.compareAtPrice).toBe(25);
  });

  it("dedupes, skips blanks and chunks large requests", async () => {
    const skus = Array.from({ length: 30 }, (_, i) => `S${i}`);
    const { client, queries } = makeClient((q) =>
      skus.filter((s) => q.includes(`"${s}"`)).map((s) => ({ sku: s, price: "1.00" })),
    );
    const map = await getRetailPricesBySku(client, [...skus, "S0", " ", ""]);
    expect(queries).toHaveLength(2);
    expect(map.size).toBe(30);
  });

  it("makes no call for an empty list", async () => {
    const { client, queries } = makeClient(() => []);
    const map = await getRetailPricesBySku(client, []);
    expect(map.size).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
