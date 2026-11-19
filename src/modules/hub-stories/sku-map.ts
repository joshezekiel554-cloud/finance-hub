// Fetch + cache the SKU → season map from the hub proxy (SKU_MAP_URL).
// Auth: a fresh app→hub token per fetch, signed with HUB_SECRET_FINANCE.
// Unset URL or secret → null (the season-missed check is off). A failed
// refresh keeps serving the last good map; with none it throws, so the
// signals feed names "season-missed" in its errors.

import { env } from "../../lib/env.js";
import { mintAppToHubToken } from "../../lib/hub-token.js";
import { createLogger } from "../../lib/logger.js";
import { skuMapSchema, type SkuMap } from "./seasons.js";

const log = createLogger({ component: "hub-stories.sku-map" });

/** Refresh at most every 12 h; after a failure wait 15 min before retrying. */
export const SKU_MAP_TTL_MS = 12 * 3_600_000;
const RETRY_MS = 15 * 60_000;
const TIMEOUT_MS = 8_000;

export type SkuMapFetcher = (url: string, token: string) => Promise<unknown>;

const defaultFetcher: SkuMapFetcher = async (url, token) => {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sku-map HTTP ${res.status}`);
  return res.json();
};

export function createSkuMapCache(opts: {
  url: string | undefined;
  secret: string | undefined;
  fetcher?: SkuMapFetcher;
  nowMs?: () => number;
}) {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const nowMs = opts.nowMs ?? Date.now;
  let value: SkuMap | null = null;
  let fetchedAt = -Infinity;
  let failedAt = -Infinity;
  let inflight: Promise<SkuMap | null> | null = null;

  async function refresh(): Promise<SkuMap | null> {
    try {
      const raw = await fetcher(opts.url!, mintAppToHubToken({ secret: opts.secret!, ttlSeconds: 120 }));
      value = skuMapSchema.parse(raw);
      fetchedAt = nowMs();
      log.info({ skus: Object.keys(value.skus).length, seasons: value.seasons.length }, "sku map refreshed");
      return value;
    } catch (err) {
      failedAt = nowMs();
      log.warn({ err }, "sku map refresh failed");
      if (value) return value;
      throw err;
    } finally {
      inflight = null;
    }
  }

  return {
    enabled: Boolean(opts.url && opts.secret),
    async get(): Promise<SkuMap | null> {
      if (!opts.url || !opts.secret) return null;
      const t = nowMs();
      if (value && t - fetchedAt < SKU_MAP_TTL_MS) return value;
      if (t - failedAt < RETRY_MS) {
        if (value) return value;
        throw new Error("sku map unavailable (retrying later)");
      }
      inflight ??= refresh();
      return inflight;
    },
  };
}

let shared: ReturnType<typeof createSkuMapCache> | null = null;

/** The process-wide cached map (null when SKU_MAP_URL / HUB_SECRET_FINANCE is unset). */
export function getSkuMap(): Promise<SkuMap | null> {
  shared ??= createSkuMapCache({ url: env.SKU_MAP_URL, secret: env.HUB_SECRET_FINANCE });
  return shared.get();
}
