import { describe, expect, it, vi } from "vitest";
import { ShopifyApiError, ShopifyClient } from "./client.js";
import {
  addTag,
  getCustomerTags,
  parseTags,
  removeTag,
  setCustomerTags,
} from "./hold.js";

const BASE_URL = "https://test-shop.myshopify.com/admin/api/2026-01";
const GRAPHQL_URL = `${BASE_URL}/graphql.json`;

function makeClient(fetchImpl: typeof fetch) {
  return new ShopifyClient({
    shop: "test-shop.myshopify.com",
    accessToken: "shpat_TESTTOKEN",
    apiVersion: "2026-01",
    fetchImpl,
    sleep: vi.fn(),
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

type FetchCall = { url: string; method: string; body: unknown };

// Fetch stub that answers GraphQL POSTs with `graphqlBody` and the
// follow-up REST tag read with `tagsString`, while recording every call
// so tests can assert exactly what was written.
function makeFetchStub(opts: {
  graphqlBody?: unknown;
  tagsString?: string;
}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, method, body });
    if (u === GRAPHQL_URL) {
      return jsonResponse(
        opts.graphqlBody ?? { data: { tagsAdd: { userErrors: [] } } },
      );
    }
    if (/\/customers\/\d+\.json/.test(u) && method === "GET") {
      return jsonResponse({ customer: { id: 123, tags: opts.tagsString ?? "" } });
    }
    throw new Error(`unexpected fetch in test: ${method} ${u}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function graphqlCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url === GRAPHQL_URL);
}

function fullSetWrites(calls: FetchCall[]): FetchCall[] {
  // The old racy write was a REST PUT of the full tag set to
  // /customers/{id}.json — assert it never happens again.
  return calls.filter((c) => c.method === "PUT");
}

describe("parseTags", () => {
  it("splits, trims, lowercases, de-dupes preserving order", () => {
    expect(parseTags(" B2B , vip,  b2b , ,wholesale ")).toEqual([
      "b2b",
      "vip",
      "wholesale",
    ]);
  });
  it("returns [] for null/empty", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("addTag — atomic tagsAdd mutation", () => {
  it("issues a single tagsAdd GraphQL mutation with the customer GID and only the one tag", async () => {
    const { fetchImpl, calls } = makeFetchStub({
      graphqlBody: { data: { tagsAdd: { userErrors: [] } } },
      tagsString: "b2b, vip",
    });
    const client = makeClient(fetchImpl);
    const { tagsAfter } = await addTag(client, 123, "b2b");

    const gql = graphqlCalls(calls);
    expect(gql).toHaveLength(1);
    const body = gql[0]?.body as { query: string; variables: unknown };
    expect(body.query).toContain("tagsAdd(id: $id, tags: $tags)");
    expect(body.query).toContain("userErrors");
    expect(body.variables).toEqual({
      id: "gid://shopify/Customer/123",
      tags: ["b2b"],
    });
    // No full-tag-set write occurs — the write is the atomic mutation.
    expect(fullSetWrites(calls)).toHaveLength(0);
    // tagsAfter is the fresh post-mutation read.
    expect(tagsAfter).toEqual(["b2b", "vip"]);
  });

  it("normalizes the tag (trim + lowercase) before mutating", async () => {
    const { fetchImpl, calls } = makeFetchStub({ tagsString: "b2b" });
    const client = makeClient(fetchImpl);
    await addTag(client, 123, "  B2B  ");
    const body = graphqlCalls(calls)[0]?.body as { variables: { tags: string[] } };
    expect(body.variables.tags).toEqual(["b2b"]);
  });

  it("throws on an empty tag without hitting the API", async () => {
    const { fetchImpl, calls } = makeFetchStub({});
    const client = makeClient(fetchImpl);
    await expect(addTag(client, 123, "   ")).rejects.toThrow(
      "addTag: tag must be non-empty",
    );
    expect(calls).toHaveLength(0);
  });

  it("throws when the mutation returns userErrors", async () => {
    const { fetchImpl } = makeFetchStub({
      graphqlBody: {
        data: {
          tagsAdd: {
            userErrors: [{ field: ["id"], message: "Customer does not exist" }],
          },
        },
      },
    });
    const client = makeClient(fetchImpl);
    await expect(addTag(client, 123, "b2b")).rejects.toThrow(
      /tagsAdd failed.*Customer does not exist/,
    );
  });

  it("throws ShopifyApiError on top-level GraphQL errors (e.g. missing scope)", async () => {
    const { fetchImpl } = makeFetchStub({
      graphqlBody: {
        errors: [{ message: "Access denied for tagsAdd field" }],
      },
    });
    const client = makeClient(fetchImpl);
    await expect(addTag(client, 123, "b2b")).rejects.toBeInstanceOf(
      ShopifyApiError,
    );
  });
});

describe("removeTag — atomic tagsRemove mutation", () => {
  it("issues a single tagsRemove GraphQL mutation with the customer GID and only the one tag", async () => {
    const { fetchImpl, calls } = makeFetchStub({
      graphqlBody: { data: { tagsRemove: { userErrors: [] } } },
      tagsString: "vip",
    });
    const client = makeClient(fetchImpl);
    const { tagsAfter } = await removeTag(client, 123, "b2b");

    const gql = graphqlCalls(calls);
    expect(gql).toHaveLength(1);
    const body = gql[0]?.body as { query: string; variables: unknown };
    expect(body.query).toContain("tagsRemove(id: $id, tags: $tags)");
    expect(body.variables).toEqual({
      id: "gid://shopify/Customer/123",
      tags: ["b2b"],
    });
    expect(fullSetWrites(calls)).toHaveLength(0);
    expect(tagsAfter).toEqual(["vip"]);
  });

  it("throws when the mutation returns userErrors", async () => {
    const { fetchImpl } = makeFetchStub({
      graphqlBody: {
        data: {
          tagsRemove: {
            userErrors: [{ field: null, message: "Tags cannot be blank" }],
          },
        },
      },
    });
    const client = makeClient(fetchImpl);
    await expect(removeTag(client, 123, "b2b")).rejects.toThrow(
      /tagsRemove failed.*Tags cannot be blank/,
    );
  });

  it("throws on an empty tag without hitting the API", async () => {
    const { fetchImpl, calls } = makeFetchStub({});
    const client = makeClient(fetchImpl);
    await expect(removeTag(client, 123, "")).rejects.toThrow(
      "removeTag: tag must be non-empty",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("setCustomerTags — delta via atomic mutations, never a full-set PUT", () => {
  it("adds missing tags and removes extra tags as separate atomic mutations", async () => {
    // Current Shopify state: ["vip", "b2b"]; desired: ["vip", "b2b-b2b-upfront"].
    const calls: FetchCall[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: u, method, body });
      if (u === GRAPHQL_URL) {
        const isAdd = (body as { query: string }).query.includes("tagsAdd");
        return jsonResponse({
          data: isAdd
            ? { tagsAdd: { userErrors: [] } }
            : { tagsRemove: { userErrors: [] } },
        });
      }
      return jsonResponse({ customer: { id: 123, tags: "vip, b2b" } });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);

    await setCustomerTags(client, 123, ["vip", "b2b-b2b-upfront"]);

    const gql = graphqlCalls(calls);
    expect(gql).toHaveLength(2);
    const addCall = gql.find((c) =>
      (c.body as { query: string }).query.includes("tagsAdd"),
    );
    const removeCall = gql.find((c) =>
      (c.body as { query: string }).query.includes("tagsRemove"),
    );
    expect((addCall?.body as { variables: unknown }).variables).toEqual({
      id: "gid://shopify/Customer/123",
      tags: ["b2b-b2b-upfront"],
    });
    expect((removeCall?.body as { variables: unknown }).variables).toEqual({
      id: "gid://shopify/Customer/123",
      tags: ["b2b"],
    });
    // "vip" is in both current and desired — never rewritten.
    expect(fullSetWrites(calls)).toHaveLength(0);
  });

  it("issues no mutation when the desired set already matches", async () => {
    const { fetchImpl, calls } = makeFetchStub({ tagsString: "vip, b2b" });
    const client = makeClient(fetchImpl);
    await setCustomerTags(client, 123, ["VIP", "b2b"]);
    expect(graphqlCalls(calls)).toHaveLength(0);
    expect(fullSetWrites(calls)).toHaveLength(0);
  });
});

describe("getCustomerTags", () => {
  it("reads /customers/{id}.json and parses the comma-joined tags", async () => {
    const { fetchImpl, calls } = makeFetchStub({ tagsString: "B2B, VIP" });
    const client = makeClient(fetchImpl);
    const tags = await getCustomerTags(client, 123);
    expect(tags).toEqual(["b2b", "vip"]);
    expect(calls[0]?.url).toContain("/customers/123.json?fields=id,tags");
  });
});
