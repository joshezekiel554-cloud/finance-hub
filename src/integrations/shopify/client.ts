// Shopify Admin REST API client — minimal fetch wrapper.
//
// We don't use @shopify/shopify-api here because the offline access token is
// permanent (no refresh, no session storage), and this surface is small (a few
// reads for week-4 invoicing reconciliation, plus a tag mutation later for
// hold/release). A direct fetch with retry + cursor pagination handling is
// easier to reason about than the SDK's session machinery for our needs.
//
// Behaviors this client guarantees:
//   - Injects X-Shopify-Access-Token from env on every request
//   - Retries once on 429, honoring Retry-After (Shopify's leaky-bucket signal)
//   - Surfaces non-2xx as ShopifyApiError with status, body, request URL
//   - Cursor-based pagination via the Link header (rel="next")

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import type { Page } from "./types.js";

const log = createLogger({ component: "shopify-client" });

export type ShopifyClientConfig = {
  shop: string; // e.g. "feldart-usa.myshopify.com"
  accessToken: string;
  apiVersion: string; // e.g. "2026-01"
  // Override fetch for testing.
  fetchImpl?: typeof fetch;
  // Override the retry-after sleeper for testing.
  sleep?: (ms: number) => Promise<void>;
};

export function configFromEnv(): ShopifyClientConfig {
  return {
    shop: env.SHOPIFY_STORE_DOMAIN,
    accessToken: env.SHOPIFY_ADMIN_TOKEN,
    apiVersion: env.SHOPIFY_API_VERSION,
  };
}

export class ShopifyApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`Shopify API ${status}: ${url}\n${body.slice(0, 500)}`);
    this.name = "ShopifyApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const DEFAULT_RETRY_AFTER_MS = 2000;

export class ShopifyClient {
  private readonly cfg: Required<Omit<ShopifyClientConfig, "fetchImpl" | "sleep">> &
    Pick<ShopifyClientConfig, "fetchImpl" | "sleep">;

  constructor(cfg: ShopifyClientConfig = configFromEnv()) {
    this.cfg = {
      shop: cfg.shop,
      accessToken: cfg.accessToken,
      apiVersion: cfg.apiVersion,
      fetchImpl: cfg.fetchImpl,
      sleep: cfg.sleep,
    };
  }

  private get baseUrl(): string {
    return `https://${this.cfg.shop}/admin/api/${this.cfg.apiVersion}`;
  }

  private fetcher(): typeof fetch {
    return this.cfg.fetchImpl ?? fetch;
  }

  private sleeper(ms: number): Promise<void> {
    if (this.cfg.sleep) return this.cfg.sleep(ms);
    return new Promise((r) => setTimeout(r, ms));
  }

  // Single request. Retries once on 429.
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("X-Shopify-Access-Token", this.cfg.accessToken);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const doFetch = () =>
      this.fetcher()(url, { ...init, headers });

    let res = await doFetch();
    if (res.status === 429) {
      const retryAfter = parseRetryAfterMs(res.headers.get("Retry-After"));
      log.warn(
        { url, retryAfter },
        "shopify 429 — sleeping then retrying once",
      );
      await this.sleeper(retryAfter);
      res = await doFetch();
    }
    return res;
  }

  // GET that parses JSON and throws on non-2xx.
  async getJson<T>(path: string): Promise<{ data: T; res: Response }> {
    const res = await this.request(path, { method: "GET" });
    const text = await res.text();
    if (!res.ok) {
      throw new ShopifyApiError(res.status, path, text);
    }
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new ShopifyApiError(res.status, path, `non-JSON body: ${text.slice(0, 200)}`);
    }
    return { data, res };
  }

  // Paginated GET. Pulls up to `pageSize` per call; caller drives pagination
  // by calling getPage(nextToken) with the previous page's `next`. The
  // pageSize lives in the path (limit=N) on the first call; subsequent calls
  // use the page_info cursor returned in the Link header — Shopify rejects
  // mixing query params with page_info, so we strip everything except limit.
  async getPage<T>(opts: {
    path: string; // e.g. "/orders.json?status=any"
    extract: (raw: unknown) => T[];
    pageToken?: string | null;
  }): Promise<Page<T>> {
    const url = opts.pageToken
      ? `${this.baseUrl}/${opts.pageToken.replace(/^\//, "")}`
      : `${this.baseUrl}${opts.path}`;
    const { data, res } = await this.getJson<unknown>(
      opts.pageToken ? url : opts.path,
    );
    const items = opts.extract(data);
    const next = parseNextPageToken(res.headers.get("Link"), this.baseUrl);
    return { items, next };
  }
}

// Parses a Retry-After header value (seconds, or a date) and returns ms. Falls
// back to a sane default when the header is missing or malformed — Shopify
// usually sends a small integer.
export function parseRetryAfterMs(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = value.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.max(asNumber * 1000, 250);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(asDate - Date.now(), 250);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

// Extracts the relative path from a Link header rel="next" entry. Shopify
// returns absolute URLs — we strip the host so getPage can re-resolve against
// the configured baseUrl, keeping the path interchangeable across versions.
export function parseNextPageToken(
  linkHeader: string | null,
  baseUrl: string,
): string | null {
  if (!linkHeader) return null;
  // Format: <https://shop/admin/api/2026-01/orders.json?...&page_info=XXX>; rel="next", <...>; rel="previous"
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (m && m[1]) {
      const url = m[1];
      if (url.startsWith(baseUrl)) {
        return url.slice(baseUrl.length);
      }
      return url;
    }
  }
  return null;
}
