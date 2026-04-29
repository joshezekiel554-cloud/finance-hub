import { createLogger } from "~/lib/logger.js";
import { getInternalGmailClient, withRetry } from "./client.js";

const log = createLogger({ module: "gmail.aliases" });

export type GmailAlias = {
  sendAsEmail: string;
  displayName: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  treatAsAlias: boolean;
  verificationStatus: string | null;
};

// 5-minute TTL: aliases change rarely (admin action in Gmail settings) but
// we'd rather not hit Gmail every time the compose modal opens. The
// per-account map lets us cache distinct mailboxes independently.
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_KEY = "__default__";

type CacheEntry = {
  aliases: GmailAlias[];
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(externalAccountId?: string): string {
  return externalAccountId ?? DEFAULT_KEY;
}

export function clearAliasCache(externalAccountId?: string): void {
  if (externalAccountId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(externalAccountId));
}

export async function listAliases(
  externalAccountId?: string,
): Promise<GmailAlias[]> {
  const key = cacheKey(externalAccountId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.aliases;
  }

  const gmail = await getInternalGmailClient(externalAccountId);
  const res = await withRetry(
    () => gmail.users.settings.sendAs.list({ userId: "me" }),
    "settings.sendAs.list",
  );

  const aliases: GmailAlias[] = (res.data.sendAs ?? []).map((s) => ({
    sendAsEmail: s.sendAsEmail ?? "",
    displayName: s.displayName ?? null,
    isPrimary: Boolean(s.isPrimary),
    isDefault: Boolean(s.isDefault),
    treatAsAlias: Boolean(s.treatAsAlias),
    verificationStatus: s.verificationStatus ?? null,
  }));

  cache.set(key, { aliases, fetchedAt: Date.now() });
  log.info({ count: aliases.length, key }, "fetched gmail aliases");
  return aliases;
}
