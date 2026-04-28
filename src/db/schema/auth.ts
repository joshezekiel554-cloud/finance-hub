import {
  boolean,
  int,
  mysqlTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import type { AdapterAccountType } from "@auth/core/adapters";

// @auth/drizzle-adapter MySQL spec — column shapes/lengths must match exactly
// (see node_modules/@auth/drizzle-adapter/lib/mysql.js).
//
// Token-at-rest encryption: `accounts.refresh_token`, `access_token`, and
// `id_token` are written by Auth.js's adapter in plaintext. This is the
// standard adapter shape; encrypting them would require shipping a custom
// adapter wrapper that intercepts the create/get/update/delete-account paths
// and runs values through `src/lib/crypto.ts`. We're deferring that to v2.1.
//
// The risk is bounded: these tokens grant only Google identity scopes (email +
// profile, NOT Gmail/Drive/Calendar) — distinct from the integration-OAuth
// tokens for QB/Gmail/Shopify, which DO carry sensitive scopes and ARE
// encrypted at rest in `oauth_tokens.access_token_enc` (see schema/oauth.ts).
// If the user-login Google client is ever scoped up, revisit this immediately.
export const users = mysqlTable("user", {
  id: varchar("id", { length: 255 })
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }).unique(),
  emailVerified: timestamp("emailVerified", { mode: "date", fsp: 3 }),
  image: varchar("image", { length: 255 }),
});

export const accounts = mysqlTable(
  "account",
  {
    userId: varchar("userId", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 255 }).$type<AdapterAccountType>().notNull(),
    provider: varchar("provider", { length: 255 }).notNull(),
    providerAccountId: varchar("providerAccountId", { length: 255 }).notNull(),
    refresh_token: varchar("refresh_token", { length: 255 }),
    access_token: varchar("access_token", { length: 255 }),
    expires_at: int("expires_at"),
    token_type: varchar("token_type", { length: 255 }),
    scope: varchar("scope", { length: 255 }),
    id_token: varchar("id_token", { length: 2048 }),
    session_state: varchar("session_state", { length: 255 }),
  },
  (account) => ({
    compositePk: primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  }),
);

export const sessions = mysqlTable("session", {
  sessionToken: varchar("sessionToken", { length: 255 }).primaryKey(),
  userId: varchar("userId", { length: 255 })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = mysqlTable(
  "verificationToken",
  {
    identifier: varchar("identifier", { length: 255 }).notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => ({
    compositePk: primaryKey({ columns: [vt.identifier, vt.token] }),
  }),
);

export const authenticators = mysqlTable(
  "authenticator",
  {
    credentialID: varchar("credentialID", { length: 255 }).notNull().unique(),
    userId: varchar("userId", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerAccountId: varchar("providerAccountId", { length: 255 }).notNull(),
    credentialPublicKey: varchar("credentialPublicKey", { length: 255 }).notNull(),
    counter: int("counter").notNull(),
    credentialDeviceType: varchar("credentialDeviceType", { length: 255 }).notNull(),
    credentialBackedUp: boolean("credentialBackedUp").notNull(),
    transports: varchar("transports", { length: 255 }),
  },
  (a) => ({
    compositePk: primaryKey({ columns: [a.userId, a.credentialID] }),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
