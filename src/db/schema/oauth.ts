import { index, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

// OAuth tokens for *integration* providers (QuickBooks, Gmail/Google, Shopify).
// Per-account row keyed by (provider, externalAccountId) so we can hold tokens
// for multiple QB realms or multiple Gmail accounts simultaneously without
// schema changes. Plain text columns are AES-256-GCM-encrypted via
// src/lib/crypto.ts before insert.
//
// User login OAuth (Google SSO via Auth.js) lives in `accounts` (auth.ts).
export const oauthTokens = mysqlTable(
  "oauth_tokens",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    provider: mysqlEnum("provider", ["quickbooks", "gmail", "shopify"]).notNull(),
    // Identifier within the provider (QB realmId, Gmail user email, Shopify shop domain)
    externalAccountId: varchar("external_account_id", { length: 255 }).notNull(),
    // TEXT (not VARCHAR) — encrypted-token base64 can grow with key rotation metadata
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: timestamp("expires_at"),
    scope: varchar("scope", { length: 1024 }),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
    // Soft revocation — sync workers back off without losing audit trail
    revokedAt: timestamp("revoked_at"),
    // Provider-specific bookkeeping (e.g. webhook URLs, install IDs)
    meta: text("meta"),
    // OAuth state-handshake columns. Filled at /oauth/start, consumed at /callback.
    // Eventually move to a signed cookie or short-lived Redis entry.
    pendingStateExpiresAt: timestamp("pending_state_expires_at"),
    pendingStateNonce: varchar("pending_state_nonce", { length: 64 }),
    pendingStateUserId: varchar("pending_state_user_id", { length: 24 }),
  },
  (t) => ({
    providerAccountIdx: index("idx_oauth_tokens_provider_account").on(
      t.provider,
      t.externalAccountId,
    ),
    pendingNonceIdx: index("idx_oauth_tokens_pending_nonce").on(t.pendingStateNonce),
  }),
);

export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type OAuthProvider = OAuthToken["provider"];
