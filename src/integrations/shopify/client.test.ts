import { describe, expect, it, vi } from "vitest";
import {
  ShopifyApiError,
  ShopifyClient,
  parseNextPageToken,
  parseRetryAfterMs,
} from "./client.js";
import {
  getOrderByName,
  listOrdersSince,
  normalizeOrderName,
} from "./orders.js";
import type { ShopifyOrder } from "./types.js";

const BASE_URL = "https://test-shop.myshopify.com/admin/api/2026-01";

function makeClient(fetchImpl: typeof fetch, sleep = vi.fn()) {
  return new ShopifyClient({
    shop: "test-shop.myshopify.com",
    accessToken: "shpat_TESTTOKEN",
    apiVersion: "2026-01",
    fetchImpl,
    sleep,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 1,
    name: "#18301",
    order_number: 18301,
    email: "buyer@example.com",
    created_at: "2026-04-20T10:00:00Z",
    updated_at: "2026-04-21T10:00:00Z",
    processed_at: "2026-04-20T10:00:00Z",
    cancelled_at: null,
    closed_at: null,
    fulfillment_status: "fulfilled",
    financial_status: "paid",
    currency: "USD",
    total_price: "100.00",
    subtotal_price: "100.00",
    total_tax: "0.00",
    note: null,
    tags: "",
    customer: null,
    shipping_address: null,
    billing_address: null,
    line_items: [],
    ...overrides,
  };
}

describe("normalizeOrderName", () => {
  it("strips SHOP prefix and prepends #", () => {
    expect(normalizeOrderName("SHOP18301")).toBe("#18301");
    expect(normalizeOrderName("shop18301")).toBe("#18301");
  });
  it("preserves an already-prefixed name", () => {
    expect(normalizeOrderName("#18301")).toBe("#18301");
  });
  it("adds # to a bare number", () => {
    expect(normalizeOrderName("18301")).toBe("#18301");
  });
  it("trims whitespace before normalizing", () => {
    expect(normalizeOrderName("  SHOP18301  ")).toBe("#18301");
  });
});

describe("parseRetryAfterMs", () => {
  it("returns ms from a numeric seconds value", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
  });
  it("clamps tiny values to a 250ms floor", () => {
    expect(parseRetryAfterMs("0")).toBe(250);
  });
  it("falls back to a default when missing", () => {
    expect(parseRetryAfterMs(null)).toBe(2000);
  });
  it("handles a future Date string", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThanOrEqual(6000);
  });
});

describe("parseNextPageToken", () => {
  it("extracts the relative path of a rel=next link", () => {
    const link = `<${BASE_URL}/orders.json?limit=2&page_info=ABC123>; rel="next"`;
    expect(parseNextPageToken(link, BASE_URL)).toBe(
      "/orders.json?limit=2&page_info=ABC123",
    );
  });
  it("ignores rel=previous when only previous is present", () => {
    const link = `<${BASE_URL}/orders.json?page_info=PREV>; rel="previous"`;
    expect(parseNextPageToken(link, BASE_URL)).toBeNull();
  });
  it("returns null when the header is missing", () => {
    expect(parseNextPageToken(null, BASE_URL)).toBeNull();
  });
  it("picks rel=next when both directions are present", () => {
    const link = `<${BASE_URL}/orders.json?page_info=PREV>; rel="previous", <${BASE_URL}/orders.json?page_info=NEXT>; rel="next"`;
    expect(parseNextPageToken(link, BASE_URL)).toBe(
      "/orders.json?page_info=NEXT",
    );
  });
});

describe("ShopifyClient.request — auth + retry", () => {
  it("injects the X-Shopify-Access-Token header on every request", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true }),
    );
    const client = makeClient(fetchImpl as typeof fetch);
    await client.request("/shop.json");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = init?.headers as Headers;
    expect(headers.get("X-Shopify-Access-Token")).toBe("shpat_TESTTOKEN");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("retries once on 429 and honors Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, sleep);
    const res = await client.request("/shop.json");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("does not retry a second time if 429 persists", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(
      async () =>
        new Response("still rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
    );
    const client = makeClient(fetchImpl as typeof fetch, sleep);
    const res = await client.request("/shop.json");
    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("ShopifyClient.getJson — error surfacing", () => {
  it("throws ShopifyApiError on non-2xx with status + body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"errors":"not found"}', {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClient(fetchImpl as typeof fetch);
    await expect(client.getJson("/orders/999.json")).rejects.toBeInstanceOf(
      ShopifyApiError,
    );
    await expect(client.getJson("/orders/999.json")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("getOrderByName", () => {
  it("queries with the normalized name and returns the first hit", async () => {
    const order = makeOrder();
    const fetchImpl = vi.fn(async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("name=%2318301");
      expect(u).toContain("status=any");
      return jsonResponse({ orders: [order] });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await getOrderByName(client, "SHOP18301");
    expect(result).toEqual(order);
  });

  it("returns null when no order matches", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ orders: [] }));
    const client = makeClient(fetchImpl as typeof fetch);
    const result = await getOrderByName(client, "SHOP99999");
    expect(result).toBeNull();
  });
});

describe("listOrdersSince — pagination", () => {
  it("returns first page items + parses Link header for next", async () => {
    const orderA = makeOrder({ id: 1, name: "#1" });
    const orderB = makeOrder({ id: 2, name: "#2" });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ orders: [orderA, orderB] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: `<${BASE_URL}/orders.json?limit=2&page_info=NEXT>; rel="next"`,
        },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const page = await listOrdersSince(client, {
      updatedAtMin: "2026-04-20T00:00:00Z",
      pageSize: 2,
    });
    expect(page.items.map((o) => o.id)).toEqual([1, 2]);
    expect(page.next).toBe("/orders.json?limit=2&page_info=NEXT");
  });

  it("returns next=null on the final page", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ orders: [makeOrder()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const page = await listOrdersSince(client);
    expect(page.next).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it("uses the page_info cursor for follow-up pages", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("page_info=ABC");
      return new Response(JSON.stringify({ orders: [makeOrder()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const page = await listOrdersSince(client, {
      pageToken: "/orders.json?limit=2&page_info=ABC",
    });
    expect(page.items).toHaveLength(1);
  });
});
