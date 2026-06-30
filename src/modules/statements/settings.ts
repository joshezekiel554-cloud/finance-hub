// Settings loader for the Statement PDF renderer.
//
// The 9 keys defined in src/db/schema/app-settings.ts are user-editable
// via /api/app-settings. The PDF renderer needs them all in a typed map
// shape; this helper performs the SELECT and fills in defaults for any
// missing rows so a fresh install (or a setting the user hasn't touched
// yet) renders without crashing.
//
// Intentionally NOT exported through the modules/statements barrel —
// callers that need it import from here directly. Keeps the public
// surface of the module to "render + send".

import { db } from "../../db/index.js";
import {
  APP_SETTING_KEYS,
  appSettings,
  type AppSettingKey,
} from "../../db/schema/app-settings.js";

// Mirrors the 9 keys in APP_SETTING_KEYS. Values default to "" when a
// row hasn't been set yet so the PDF renderer can branch on truthiness
// instead of nullability for every field.
export type AppSettingsMap = {
  company_name: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  company_website: string;
  company_logo_path: string;
  payment_methods: string;
  footer_note: string;
  statement_number_next: string;
  statement_bcc_email: string;
  // Google Drive folder ID that is the root for all RMA photo subfolders.
  drive_root_folder_id: string;
  // Warehouse team email — used by RMA tracking notifications.
  warehouse_team_email: string;
  // QBO Item ids for the shipping + restocking deduction lines on RMA
  // credit memos. CM builder reads these at issue time; throws if the
  // relevant id is empty when a deduction is requested.
  rma_shipping_fee_item_id: string;
  rma_restocking_fee_item_id: string;
  // Next sequential damage CM number. Allocated atomically at approve
  // time. Stored as a string per the app_settings schema; coerced to
  // Number when read.
  damage_cm_number_next: string;
  // AI training keys (not statement settings, but AppSettingsMap mirrors
  // all of APP_SETTING_KEYS so loadAppSettings can index by any canonical
  // key without a type error).
  ai_voice_guide: string;
  ai_corrections_cron_enabled: string;
  autopilot_scan_cron_enabled: string;
  // Torah Judaica bookkeeper contact — surfaced so loadAppSettings can
  // index by any canonical key without a type error.
  tj_bookkeeper_email: string;
  tj_bookkeeper_name: string;
  // AI agent: kill switch ("1"/"") + soft monthly USD budget ceiling.
  agent_enabled: string;
  agent_monthly_budget_usd: string;
  // Inbox↔Finance integration master flag — surfaced so loadAppSettings can
  // index by any canonical key without a type error.
  inbox_integration_enabled: string;
  // Shared-tasks master flag ("true"/"") — gates the finance Tasks nav +
  // dashboard My-tasks widget. Default off until the feature launches.
  shared_tasks_enabled: string;
  // DEPRECATED — single order-hold internal recipient list, split into
  // warehouse + team below. Kept so old rows load; new code reads the split.
  order_hold_alert_recipients: string;
  // Split internal hold recipients (warehouse / Bluechip + accounts team).
  // Merged + deduped by loadInternalHoldRecipients for hold_alert + hold_cancel.
  order_hold_warehouse_recipients: string;
  order_hold_team_recipients: string;
  // Operator-editable order/hold email templates (empty = use the default
  // constant from src/modules/orders/templates.ts).
  order_tpl_hold_alert_subject: string;
  order_tpl_hold_alert_body: string;
  order_tpl_hold_notice_subject: string;
  order_tpl_hold_notice_body: string;
  order_tpl_hold_warning_subject: string;
  order_tpl_hold_warning_body: string;
  order_tpl_hold_cancel_subject: string;
  order_tpl_hold_cancel_body: string;
  order_tpl_order_cancelled_subject: string;
  order_tpl_order_cancelled_body: string;
  // Phase 4 — overdue-order review alert. Recipients (comma-separated, empty =
  // no send), GBP overdue threshold, and the no-contact window in days.
  order_overdue_alert_recipients: string;
  order_overdue_threshold_gbp: string;
  order_overdue_no_contact_days: string;
  // Time Clock allow-list (JSON array of userIds) — surfaced so loadAppSettings
  // can index by any canonical key without a type error.
  time_clock_user_ids: string;
};

const DEFAULTS: AppSettingsMap = {
  company_name: "",
  company_address: "",
  company_phone: "",
  company_email: "",
  company_website: "",
  company_logo_path: "",
  payment_methods: "",
  footer_note: "",
  statement_number_next: "1",
  // Preserves the historical hardcoded BCC. Operator can clear via
  // the Settings page → "Statement BCC" field to disable.
  statement_bcc_email: "accounts@feldart.com",
  drive_root_folder_id: "",
  warehouse_team_email: "",
  rma_shipping_fee_item_id: "",
  rma_restocking_fee_item_id: "",
  // Continues the legacy QBO range — operator can adjust via /settings
  // if they want to start a different sequence.
  damage_cm_number_next: "38771",
  ai_voice_guide: "",
  ai_corrections_cron_enabled: "",
  autopilot_scan_cron_enabled: "",
  tj_bookkeeper_email: "",
  tj_bookkeeper_name: "",
  // Agent ships enabled; the kill switch is for incidents, not opt-in.
  agent_enabled: "1",
  agent_monthly_budget_usd: "150",
  inbox_integration_enabled: "",
  shared_tasks_enabled: "",
  // Operator-specified default recipients: Feldart inboxes + Bluechip warehouse
  // (efrayim + shipping) so the order can be physically held. Tweakable in
  // /settings.
  order_hold_alert_recipients:
    "info@feldart.co.uk,info@feldart.com,sales@feldart.com,efrayim@bluechipfulfillment.com,shipping@bluechipfulfillment.com",
  // Default warehouse list = the Bluechip fulfilment inboxes (so a fresh
  // install can still physically hold a parcel). On an existing install the
  // 0052 data migration overwrites this with the legacy
  // order_hold_alert_recipients value. The accounts team defaults to the two
  // Feldart inboxes. The hold_alert + hold_cancel sends use both, deduped.
  order_hold_warehouse_recipients:
    "efrayim@bluechipfulfillment.com,shipping@bluechipfulfillment.com",
  order_hold_team_recipients: "info@feldart.com,info@feldart.co.uk",
  // Templates default to "" so the effective-value resolver falls through to
  // ORDER_EMAIL_DEFAULTS. Stored only when an operator customises one.
  order_tpl_hold_alert_subject: "",
  order_tpl_hold_alert_body: "",
  order_tpl_hold_notice_subject: "",
  order_tpl_hold_notice_body: "",
  order_tpl_hold_warning_subject: "",
  order_tpl_hold_warning_body: "",
  order_tpl_hold_cancel_subject: "",
  order_tpl_hold_cancel_body: "",
  order_tpl_order_cancelled_subject: "",
  order_tpl_order_cancelled_body: "",
  // Operator-specified: the overdue review alert goes to the two Feldart
  // inboxes (they decide whether to tell Bluechip to hold). £1000 + 14 days are
  // sensible starting points; tweak in /settings.
  order_overdue_alert_recipients: "info@feldart.com,info@feldart.co.uk",
  order_overdue_threshold_gbp: "1000",
  order_overdue_no_contact_days: "14",
  // Time Clock allow-list (JSON array of userIds). Empty default = feature off
  // until the operator seeds it (Hillel's id) via /settings.
  time_clock_user_ids: "",
};

// Single SELECT * over app_settings. With only 9 canonical rows this is
// cheaper than 9 individual key lookups; the table is keyed by
// (varchar 64) so reads are constant-time anyway.
export async function loadAppSettings(): Promise<AppSettingsMap> {
  const rows = await db.select().from(appSettings);
  const map: AppSettingsMap = { ...DEFAULTS };
  for (const r of rows) {
    if (isAppSettingKey(r.key)) {
      map[r.key] = r.value ?? "";
    }
  }
  return map;
}

// Reads ALL rows including user-defined keys (anything outside the
// canonical 9 still surfaces in /api/app-settings GET). Non-canonical
// keys land alongside the canonical ones in the returned record. The
// PATCH route validates against APP_SETTING_KEYS so writes are gated.
export async function loadAllAppSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(appSettings);
  const map: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) {
    map[r.key] = r.value ?? "";
  }
  return map;
}

export function isAppSettingKey(s: string): s is AppSettingKey {
  return (APP_SETTING_KEYS as readonly string[]).includes(s);
}
