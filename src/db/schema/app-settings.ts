// Generic key/value settings for app-wide configuration. Used today for
// the Statement PDF (company info, payment methods, logo path, the
// auto-incrementing statement number counter), and future-proofed for
// other modules that need user-editable defaults without proliferating
// dedicated schemas.
//
// Values are stored as TEXT so we can hold multi-line content (addresses,
// payment methods blocks) without column-length surprises. Callers
// validate shape at the API + render layer; the schema doesn't try to
// enforce types beyond "string".

import {
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const appSettings = mysqlTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  description: varchar("description", { length: 512 }),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  updatedByUserId: varchar("updated_by_user_id", { length: 255 }).references(
    () => users.id,
    { onDelete: "set null" },
  ),
});

export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;

// Canonical keys used by the codebase. Anything outside this list is
// considered "user-defined" and will display in settings but won't have
// typed convenience accessors.
export const APP_SETTING_KEYS = [
  "company_name",
  "company_address",
  "company_phone",
  "company_email",
  "company_website",
  "company_logo_path",
  "payment_methods",
  "footer_note",
  "statement_number_next",
] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];
