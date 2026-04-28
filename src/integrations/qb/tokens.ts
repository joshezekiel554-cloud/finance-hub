// QB OAuth token storage on top of `oauth_tokens` (provider='quickbooks').
//
// 1.0 read+wrote `qb-tokens.json` from disk. 2.0 stores access + refresh
// tokens encrypted at rest in MySQL, keyed by realmId (externalAccountId).
// One QB realm = one row. Multiple realms is supported by the schema's
// (provider, externalAccountId) UNIQUE constraint, but in practice we expect
// a single Feldart realm.

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { oauthTokens } from "../../db/schema/oauth.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "qb-tokens" });

// Buffer applied when checking expiry: refresh proactively if the access
// token will expire in less than this window. 1.0 used 50 minutes (out of
// QBO's 60-minute access-token lifetime); 5 minutes is safer and still
// avoids hot-spinning on refreshes.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type QbTokens = {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  expiresAt: Date | null;
  scope: string | null;
};

export async function loadQbTokens(realmId: string): Promise<QbTokens | null> {
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.provider, "quickbooks"),
        eq(oauthTokens.externalAccountId, realmId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt) {
    log.warn({ realmId }, "qb token row is revoked");
    return null;
  }
  if (!row.refreshTokenEnc) {
    log.warn({ realmId }, "qb token row has no refresh token; reauth required");
    return null;
  }

  return {
    accessToken: decrypt(row.accessTokenEnc),
    refreshToken: decrypt(row.refreshTokenEnc),
    realmId,
    expiresAt: row.expiresAt ?? null,
    scope: row.scope ?? null,
  };
}

export async function saveQbTokens(input: QbTokens): Promise<void> {
  const accessTokenEnc = encrypt(input.accessToken);
  const refreshTokenEnc = encrypt(input.refreshToken);

  // Try update first (the common case once OAuth callback has provisioned a row),
  // fall back to insert if no existing row matches.
  const existing = await db
    .select({ id: oauthTokens.id })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.provider, "quickbooks"),
        eq(oauthTokens.externalAccountId, input.realmId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(oauthTokens)
      .set({
        accessTokenEnc,
        refreshTokenEnc,
        expiresAt: input.expiresAt,
        scope: input.scope,
        revokedAt: null,
      })
      .where(eq(oauthTokens.id, existing[0].id));
    return;
  }

  await db.insert(oauthTokens).values({
    id: nanoid(24),
    provider: "quickbooks",
    externalAccountId: input.realmId,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt: input.expiresAt,
    scope: input.scope,
  });
}

export function isExpiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS;
}

// Refreshes via intuit-oauth, persists new tokens. Caller passes in a function
// that performs the refresh (so client.ts owns the OAuthClient instance and
// this module stays free of intuit-oauth as a direct dep).
export async function refreshIfNeeded(
  realmId: string,
  refreshFn: (current: QbTokens) => Promise<QbTokens>,
): Promise<QbTokens> {
  const current = await loadQbTokens(realmId);
  if (!current) {
    throw new Error(`No QB tokens found for realmId=${realmId}; reauthorize first`);
  }
  if (!isExpiringSoon(current.expiresAt)) {
    return current;
  }

  log.info({ realmId, expiresAt: current.expiresAt }, "refreshing QB access token");
  const next = await refreshFn(current);
  await saveQbTokens(next);
  return next;
}
