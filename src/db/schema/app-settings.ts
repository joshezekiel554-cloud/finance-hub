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
  // Email address that gets BCC'd on every statement send. Empty
  // string = no BCC. Defaults to accounts@feldart.com so existing
  // behaviour is preserved on a fresh install.
  "statement_bcc_email",
  // Google Drive folder ID that is the root for all RMA photo subfolders.
  // Set via Settings UI or direct API call. If empty, photo upload returns 412.
  "drive_root_folder_id",
  // Email address (or comma-separated list) that gets the "customer is
  // shipping back RMA X with tracking Y" notification when the operator
  // adds tracking. Empty = no email is sent (operator may notify the
  // warehouse out-of-band).
  "warehouse_team_email",
  // QBO Item ids used as line refs for the shipping + restocking fee
  // deduction lines on credit memos. Operator creates the service
  // items in QBO once + pastes the numeric Item.Id here. Empty = the
  // CM builder throws a clear error if a deduction is requested,
  // refusing to silently issue against a wrong item.
  "rma_shipping_fee_item_id",
  "rma_restocking_fee_item_id",
  // Sequential counter for damage credit memo DocNumbers (DC#####).
  // Allocated atomically at approve time via SELECT FOR UPDATE on
  // this row → increment → save. Default seed "38771" continues the
  // legacy QBO range. Operator can edit in /settings → Returns to
  // adjust the seed or recover from an accidental increment.
  "damage_cm_number_next",
  // AI voice/style guide consumed by autopilot draft prompts. Free prose,
  // editable on the /ai-training page; seeded by scripts/seed-voice-guide.ts.
  "ai_voice_guide",
  // "true"/"" flag — enables the weekly learn-from-edits distill cron
  // (Wave C). Default off; added now so the KV key is recognized.
  "ai_corrections_cron_enabled",
  // "true"/"" flag — enables the autopilot scan cron (default off).
  // Manual "Run autopilot now" triggers bypass this gate (they pass
  // trigger="manual" to the handler).
  "autopilot_scan_cron_enabled",
  // Torah Judaica bookkeeper contact — the one-click "Email TJ bookkeeper"
  // dispute action pre-fills a message to this address. Empty = the action
  // opens compose with no recipient pre-filled.
  "tj_bookkeeper_email",
  "tj_bookkeeper_name",
  // "1"/"" kill switch for the conversational AI agent (spec
  // 2026-06-11-ai-agent-design §5). Off = the chat turn route returns a
  // friendly 403; existing AI surfaces (card, autopilot) are unaffected.
  "agent_enabled",
  // Soft monthly spend ceiling for ALL Anthropic usage, in USD (plain
  // number as text, e.g. "150"). Never blocks — drives the 80%/100%
  // notifications + the /agent spend dashboard (Wave C).
  "agent_monthly_budget_usd",
] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];
