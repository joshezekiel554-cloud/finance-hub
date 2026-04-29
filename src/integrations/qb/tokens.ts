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

// Per-realm in-flight refresh promise. When a refresh is already running
// for a realm, concurrent callers reuse the same promise instead of firing
// their own — Intuit treats simultaneous refresh calls with the same
// refresh token as a replay attack and invalidates the entire chain.
const inFlightRefreshes = new Map<string, Promise<QbTokens>>();

export type QbTokens = {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  expiresAt: Date | null;
  scope: string | null;
  // The exact ciphertext currently in the DB row's refresh_token_enc column.
  // Captured here so saveQbTokensCAS can do a compare-and-swap on it
  // without re-encrypting (encrypt uses a random IV, so plaintext won't
  // round-trip to the same ciphertext). Not exported to consumers — they
  // see the decrypted refreshToken; this is internal CAS metadata.
  _priorRefreshTokenEnc?: string;
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
    _priorRefreshTokenEnc: row.refreshTokenEnc,
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

// Compare-and-swap save: only writes the new tokens if the row's current
// refresh_token_enc still matches the encrypted value we observed when we
// started the refresh. Returns true on success, false if another writer
// raced us (in which case the caller should reload + use whatever's now
// in the DB rather than overwriting it). Defense against tsx-watch
// process restarts that leave a partially-completed refresh and a fresh
// process trying to refresh with stale tokens.
export async function saveQbTokensCAS(
  input: QbTokens,
  expectedPriorRefreshTokenEnc: string,
): Promise<boolean> {
  const result = await db
    .update(oauthTokens)
    .set({
      accessTokenEnc: encrypt(input.accessToken),
      refreshTokenEnc: encrypt(input.refreshToken),
      expiresAt: input.expiresAt,
      scope: input.scope,
      revokedAt: null,
    })
    .where(
      and(
        eq(oauthTokens.provider, "quickbooks"),
        eq(oauthTokens.externalAccountId, input.realmId),
        eq(oauthTokens.refreshTokenEnc, expectedPriorRefreshTokenEnc),
      ),
    );
  // Drizzle MySQL returns [ResultSetHeader, ...]; affectedRows is on [0].
  const affected = (result as unknown as [{ affectedRows: number }])[0]
    ?.affectedRows;
  return (affected ?? 0) > 0;
}

export function isExpiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS;
}

// Loads tokens, refreshes via the supplied refreshFn if expiring soon, and
// persists the result. Single-flight per realm: if a refresh is already in
// flight for this realm, concurrent callers await the same promise instead
// of triggering their own refresh. Without this, Intuit's anti-replay
// detection invalidates the chain when two refresh calls arrive with the
// same refresh token.
//
// caller passes refreshFn so client.ts owns the OAuthClient instance and
// this module stays free of intuit-oauth as a direct dep.
export async function refreshIfNeeded(
  realmId: string,
  refreshFn: (current: QbTokens) => Promise<QbTokens>,
): Promise<QbTokens> {
  // If another caller has already started a refresh for this realm, attach
  // to it rather than duplicating the call. The waiting caller gets the
  // same fresh tokens once the in-flight refresh resolves.
  const existing = inFlightRefreshes.get(realmId);
  if (existing) {
    log.debug({ realmId }, "joining in-flight QB token refresh");
    return existing;
  }

  const current = await loadQbTokens(realmId);
  if (!current) {
    throw new Error(`No QB tokens found for realmId=${realmId}; reauthorize first`);
  }
  if (!isExpiringSoon(current.expiresAt)) {
    return current;
  }

  // Start a refresh; register the promise BEFORE awaiting so concurrent
  // callers see it. Always clear the entry in finally so a transient error
  // doesn't permanently block future refreshes.
  const promise = (async () => {
    log.info(
      { realmId, expiresAt: current.expiresAt },
      "refreshing QB access token (single-flight)",
    );
    const next = await refreshFn(current);
    const priorEnc = current._priorRefreshTokenEnc;
    if (!priorEnc) {
      // Shouldn't happen — loadQbTokens always populates this. Fall back
      // to a non-CAS save rather than throwing, so a buggy load doesn't
      // brick the refresh path.
      await saveQbTokens(next);
      return next;
    }
    const saved = await saveQbTokensCAS(next, priorEnc);
    if (!saved) {
      // Another writer (e.g., a tsx-watch restarted process) updated the
      // row mid-refresh. Our `next` may already be invalidated by Intuit
      // because their refresh re-rotated the chain. Reload + use whatever
      // they wrote rather than overwriting with our stale pair.
      log.warn(
        { realmId },
        "QB token CAS lost — another writer raced us; reloading",
      );
      const reloaded = await loadQbTokens(realmId);
      if (!reloaded) {
        throw new Error(
          `QB tokens vanished for realmId=${realmId} after CAS lost`,
        );
      }
      return reloaded;
    }
    return next;
  })().finally(() => {
    inFlightRefreshes.delete(realmId);
  });
  inFlightRefreshes.set(realmId, promise);
  return promise;
}

// Forces a refresh ignoring the expiry buffer. Used after a 401 from QBO
// when the cached access token went stale unexpectedly. Same single-flight
// semantics as refreshIfNeeded — concurrent 401s on the same realm share
// one refresh.
export async function forceRefresh(
  realmId: string,
  refreshFn: (current: QbTokens) => Promise<QbTokens>,
): Promise<QbTokens> {
  const existing = inFlightRefreshes.get(realmId);
  if (existing) {
    log.debug({ realmId }, "joining in-flight QB token refresh (force)");
    return existing;
  }
  const current = await loadQbTokens(realmId);
  if (!current) {
    throw new Error(`No QB tokens found for realmId=${realmId}; reauthorize first`);
  }
  const promise = (async () => {
    log.warn({ realmId }, "forcing QB token refresh after 401 (single-flight)");
    const next = await refreshFn(current);
    const priorEnc = current._priorRefreshTokenEnc;
    if (!priorEnc) {
      await saveQbTokens(next);
      return next;
    }
    const saved = await saveQbTokensCAS(next, priorEnc);
    if (!saved) {
      log.warn(
        { realmId },
        "QB token CAS lost on forceRefresh — reloading",
      );
      const reloaded = await loadQbTokens(realmId);
      if (!reloaded) {
        throw new Error(
          `QB tokens vanished for realmId=${realmId} after CAS lost`,
        );
      }
      return reloaded;
    }
    return next;
  })().finally(() => {
    inFlightRefreshes.delete(realmId);
  });
  inFlightRefreshes.set(realmId, promise);
  return promise;
}
