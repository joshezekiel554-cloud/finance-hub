import { describe, expect, it } from "vitest";
import { ExtensivClient, ExtensivError } from "./client.js";

function stub(handlers: { token?: () => Response; orders?: (url: string) => Response }) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    if (u.endsWith("/AuthServer/api/Token")) {
      return handlers.token?.() ?? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    return handlers.orders?.(u) ?? new Response(JSON.stringify({ _embedded: { item: [] } }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const creds = { clientId: "id", clientSecret: "secret", tplGuid: "{guid}" };

describe("ExtensivClient.getOrdersByIds", () => {
  it("queries by order id with RQL, using a client-credentials token", async () => {
    const { fetchImpl, calls } = stub({
      orders: () =>
        new Response(JSON.stringify({ _embedded: { item: [{ readOnly: { orderId: 120003 } }] } }), { status: 200 }),
    });
    const c = new ExtensivClient(creds, fetchImpl);
    const out = await c.getOrdersByIds(["120003", "120003", " 120232 "]);
    expect(out).toHaveLength(1);
    const auth = calls[0]!;
    expect(auth.method).toBe("POST");
    expect(auth.headers.get("authorization")).toBe("Basic " + Buffer.from("id:secret").toString("base64"));
    const get = calls[1]!;
    expect(get.method).toBe("GET");
    expect(get.headers.get("authorization")).toBe("Bearer tok");
    expect(decodeURIComponent(get.url)).toContain("rql=readOnly.orderId=in=(120003,120232)");
    expect(get.url).toContain("detail=All");
  });

  it("drops non-numeric ids and makes no call when none remain", async () => {
    const { fetchImpl, calls } = stub({});
    const c = new ExtensivClient(creds, fetchImpl);
    expect(await c.getOrdersByIds(["abc", "1,2", ""])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reuses the token across calls", async () => {
    const { fetchImpl, calls } = stub({});
    const c = new ExtensivClient(creds, fetchImpl);
    await c.getOrdersByIds(["1"]);
    await c.getOrdersByIds(["2"]);
    expect(calls.filter((x) => x.url.endsWith("/Token"))).toHaveLength(1);
  });

  it("throws ExtensivError on auth failure", async () => {
    const { fetchImpl } = stub({ token: () => new Response("{}", { status: 401 }) });
    const c = new ExtensivClient(creds, fetchImpl);
    await expect(c.getOrdersByIds(["1"])).rejects.toBeInstanceOf(ExtensivError);
  });

  it("throws ExtensivError on an API error", async () => {
    const { fetchImpl } = stub({ orders: () => new Response("boom", { status: 500 }) });
    const c = new ExtensivClient(creds, fetchImpl);
    await expect(c.getOrdersByIds(["1"])).rejects.toThrow(/HTTP 500/);
  });
});
