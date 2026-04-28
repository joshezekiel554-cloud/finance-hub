import { createLogger } from "~/lib/logger.js";
import { getInternalGmailClient, withRetry } from "./client.js";
import type { AliasContext, MailAlias } from "./types.js";

const log = createLogger({ module: "gmail.aliases" });

// In-memory cache. Aliases change rarely (admin action in Gmail settings) so
// caching for a session is fine. Bust manually via clearAliasCache() if a
// teammate adds a new sendAs entry.
let cache:
  | {
      externalAccountId: string;
      aliases: MailAlias[];
      fetchedAt: number;
    }
  | null = null;

const CACHE_TTL_MS = 60 * 60 * 1000;

export function clearAliasCache(): void {
  cache = null;
}

export async function listAliases(externalAccountId?: string): Promise<MailAlias[]> {
  if (
    cache &&
    (externalAccountId === undefined || cache.externalAccountId === externalAccountId) &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return cache.aliases;
  }

  const gmail = await getInternalGmailClient(externalAccountId);
  const res = await withRetry(
    () => gmail.users.settings.sendAs.list({ userId: "me" }),
    "settings.sendAs.list",
  );

  const aliases: MailAlias[] = (res.data.sendAs ?? []).map((s) => ({
    sendAsEmail: s.sendAsEmail ?? "",
    displayName: s.displayName ?? null,
    isPrimary: Boolean(s.isPrimary),
    isDefault: Boolean(s.isDefault),
    replyToAddress: s.replyToAddress ?? null,
    verificationStatus: s.verificationStatus ?? null,
  }));

  // We can't know externalAccountId without round-tripping, but the client
  // caches per-account and listAliases() is read-after-getClient. Stamp with
  // whatever caller passed (or empty) — TTL handles correctness.
  cache = {
    externalAccountId: externalAccountId ?? "",
    aliases,
    fetchedAt: Date.now(),
  };

  log.info({ count: aliases.length }, "fetched gmail aliases");
  return aliases;
}

// Context → alias mapping is configured in week 7 (see plan §Open items).
// For now, accept the context arg and return the default/primary alias if no
// mapping is configured. Callers should treat the result as a recommendation
// the UI can override.
//
// TODO(week-7): load mapping from a config file (e.g., src/modules/email-compose/alias-map.ts)
// keyed by context, falling back to default. Until that config exists, default.
export async function resolveAliasFromContext(
  _context: AliasContext,
  externalAccountId?: string,
): Promise<MailAlias | null> {
  const aliases = await listAliases(externalAccountId);
  if (aliases.length === 0) return null;

  // Prefer isDefault, then isPrimary, then first.
  const def = aliases.find((a) => a.isDefault);
  if (def) return def;
  const primary = aliases.find((a) => a.isPrimary);
  if (primary) return primary;
  return aliases[0] ?? null;
}
