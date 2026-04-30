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
