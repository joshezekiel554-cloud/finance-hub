// TODO(schema-designer): replace this stub with the full oauth_tokens table per
// v2.0/v2.1 spec. Auth task only needs: provider (enum), encrypted access/refresh
// tokens, expires_at. Stub keeps shape minimal so auth-engineer's oauth callback
// route compiles; schema-designer owns the canonical version.
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const oauthTokens = mysqlTable("oauth_tokens", {
  id: varchar("id", { length: 24 }).primaryKey(),
  provider: mysqlEnum("provider", ["quickbooks", "gmail", "shopify"]).notNull(),
  // Identifier within the provider (QB realmId, Gmail user email, Shopify shop domain)
  externalAccountId: varchar("external_account_id", { length: 255 }).notNull(),
  // Encrypted via src/lib/crypto.ts (AES-256-GCM, base64). Long-lived refresh
  // tokens can grow; access tokens fit easily, but use TEXT to avoid surprise.
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  expiresAt: timestamp("expires_at"),
  scope: varchar("scope", { length: 1024 }),
  installedAt: timestamp("installed_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  // Soft revocation flag — tells sync workers to back off without deleting the row
  revokedAt: timestamp("revoked_at"),
  // For optional bookkeeping; sync workers re-fetch on demand
  meta: text("meta"),
  // Optional column reserved for callback-handshake state. Real flow stores
  // state ephemerally (signed) and removes after callback; left here for the
  // skeleton handler.
  pendingStateExpiresAt: timestamp("pending_state_expires_at"),
  pendingStateNonce: varchar("pending_state_nonce", { length: 64 }),
  pendingStateUserId: varchar("pending_state_user_id", { length: 24 }),
});

export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type OAuthProvider = OAuthToken["provider"];
