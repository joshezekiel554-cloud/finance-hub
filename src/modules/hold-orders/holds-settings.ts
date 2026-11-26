// Hold Orders → Settings: the typed config every hold consumer reads. PURE
// (shared by the server and the Hold Orders SPA): no DB, no Node APIs.
//
// Storage: plain app_settings rows (TEXT key/value, APP_SETTING_KEYS). Some
// keys are the SAME keys finance's /settings page already edits (overdue
// threshold / no-contact days / review recipients / warehouse + team
// recipients), so an edit in either app shows in both. Every consumer parses
// the raw map with parseHoldsConfig() per run; a missing or garbage value
// falls back to the default below (= the constants the code used before).

import { z } from "zod";
import {
  DEFAULT_RULE_MIN_BALANCE,
  NUMBERED_PRESETS,
  PRESET_NUMBERS,
  isNumberedPreset,
  type HoldRuleNumbers,
  type NumberedPreset,
  type PresetTable,
} from "./presets.js";

// Who the default rule covers. Only one option today: "b2b" =
// customers.customer_type = 'b2b' (finance's own classification, set by the
// customers sweep / import). Deliberately NOT the Shopify b2b tag: finance
// doesn't store Shopify tags, and a live Shopify call per detection run would
// make holds depend on Shopify being up.
export const DEFAULT_RULE_SCOPES = ["b2b"] as const;
export type DefaultRuleScope = (typeof DEFAULT_RULE_SCOPES)[number];

// The default rule's per-rule flags (not settings): it emails the warehouse
// when it holds, never emails customers by itself, and releases on payment —
// the same defaults a newly-created explicit rule starts with.
export const DEFAULT_RULE_FLAGS = {
  autoStartLadder: false,
  autoReleaseOnPayment: true,
  notifyWarehouse: true,
} as const;

export type HoldsConfig = {
  // 1. Standard rules
  overdueThresholdGbp: number;
  noContactDays: number;
  overdueRecipients: string;
  holdAlertLookbackDays: number;
  overdueAlertLookbackDays: number;
  defaultRuleEnabled: boolean;
  defaultRulePreset: NumberedPreset;
  defaultRuleScope: DefaultRuleScope;
  // 2. Presets
  presets: PresetTable;
  defaultMinBalance: number;
  // 3. "Possible hold" flags (the board's At-risk tab)
  ruleOrderLookbackDays: number;
  overdueWidgetLookbackDays: number;
  // 4. Email ladder
  warnDays: number;
  cancelDays: number;
  warehouseRecipients: string;
  teamRecipients: string;
  // 5. Auto-release (H8 / H9)
  autoReleaseEmailsWarehouse: boolean;
  ruleHoldsRespectPromise: boolean;
};

export type HoldsConfigField = keyof HoldsConfig;

/** Config field → app_settings key. */
export const HOLDS_SETTING_KEYS = {
  overdueThresholdGbp: "order_overdue_threshold_gbp",
  noContactDays: "order_overdue_no_contact_days",
  overdueRecipients: "order_overdue_alert_recipients",
  holdAlertLookbackDays: "order_hold_alert_lookback_days",
  overdueAlertLookbackDays: "order_overdue_alert_lookback_days",
  defaultRuleEnabled: "holds_default_rule_enabled",
  defaultRulePreset: "holds_default_rule_preset",
  defaultRuleScope: "holds_default_rule_scope",
  presets: "holds_preset_overrides",
  defaultMinBalance: "holds_default_min_balance",
  ruleOrderLookbackDays: "holds_rule_order_lookback_days",
  overdueWidgetLookbackDays: "order_overdue_widget_lookback_days",
  warnDays: "order_hold_warn_days",
  cancelDays: "order_hold_cancel_days",
  warehouseRecipients: "order_hold_warehouse_recipients",
  teamRecipients: "order_hold_team_recipients",
  autoReleaseEmailsWarehouse: "holds_auto_release_emails_warehouse",
  ruleHoldsRespectPromise: "holds_rule_holds_respect_promise",
} as const satisfies Record<HoldsConfigField, string>;

export type HoldsSettingKey = (typeof HOLDS_SETTING_KEYS)[HoldsConfigField];

function clonePresets(t: PresetTable): PresetTable {
  return {
    standard_30_45: { ...t.standard_30_45 },
    extended_60_75: { ...t.extended_60_75 },
    vip_90_110: { ...t.vip_90_110 },
    strict: { ...t.strict },
  };
}

/** Defaults = the constants the code used before Settings existed. */
export const HOLDS_CONFIG_DEFAULTS: HoldsConfig = {
  overdueThresholdGbp: 1000,
  noContactDays: 14,
  overdueRecipients: "info@feldart.com,info@feldart.co.uk",
  holdAlertLookbackDays: 3,
  overdueAlertLookbackDays: 3,
  // Ships OFF (operator decision A): a default rule is only live once an
  // admin has dry-run it and switched it on.
  defaultRuleEnabled: false,
  defaultRulePreset: "standard_30_45",
  defaultRuleScope: "b2b",
  presets: clonePresets(PRESET_NUMBERS),
  defaultMinBalance: DEFAULT_RULE_MIN_BALANCE,
  ruleOrderLookbackDays: 30,
  overdueWidgetLookbackDays: 30,
  warnDays: 7,
  cancelDays: 10,
  warehouseRecipients: "efrayim@bluechipfulfillment.com,shipping@bluechipfulfillment.com",
  teamRecipients: "info@feldart.com,info@feldart.co.uk",
  // H8 ON (operator decision C).
  autoReleaseEmailsWarehouse: true,
  // H9 OFF (operator decision C).
  ruleHoldsRespectPromise: false,
};

// ---- bounds + validation ---------------------------------------------------

export const BOUNDS = {
  money: { min: 0, max: 1_000_000 },
  noContactDays: { min: 1, max: 365 },
  alertLookbackDays: { min: 1, max: 30 },
  listLookbackDays: { min: 1, max: 180 },
  ruleDays: { min: 0, max: 730 },
  ladderDays: { min: 1, max: 60 },
} as const;

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Comma-separated email list; empty allowed. */
export function invalidEmails(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !EMAIL_RE.test(s));
}

const int = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);
const money = z.number().finite().min(BOUNDS.money.min).max(BOUNDS.money.max);
const emails = z
  .string()
  .max(2000)
  .refine((s) => invalidEmails(s).length === 0, { message: "Not a valid email list (comma-separated)" });

const presetNumbersSchema = z
  .object({
    termsDays: int(BOUNDS.ruleDays),
    holdWhenInvoiceDaysOver: int(BOUNDS.ruleDays),
    minBalance: money,
  })
  .refine((n) => n.holdWhenInvoiceDaysOver >= n.termsDays, {
    message: "Hold-after days can't be less than the terms",
    path: ["holdWhenInvoiceDaysOver"],
  });

const baseShape = {
  overdueThresholdGbp: money,
  noContactDays: int(BOUNDS.noContactDays),
  overdueRecipients: emails,
  holdAlertLookbackDays: int(BOUNDS.alertLookbackDays),
  overdueAlertLookbackDays: int(BOUNDS.alertLookbackDays),
  defaultRuleEnabled: z.boolean(),
  defaultRulePreset: z.enum(NUMBERED_PRESETS),
  defaultRuleScope: z.enum(DEFAULT_RULE_SCOPES),
  presets: z.object({
    standard_30_45: presetNumbersSchema,
    extended_60_75: presetNumbersSchema,
    vip_90_110: presetNumbersSchema,
    strict: presetNumbersSchema,
  }),
  defaultMinBalance: money,
  ruleOrderLookbackDays: int(BOUNDS.listLookbackDays),
  overdueWidgetLookbackDays: int(BOUNDS.listLookbackDays),
  warnDays: int(BOUNDS.ladderDays),
  cancelDays: int(BOUNDS.ladderDays),
  warehouseRecipients: emails,
  teamRecipients: emails,
  autoReleaseEmailsWarehouse: z.boolean(),
  ruleHoldsRespectPromise: z.boolean(),
};

/** A whole config, with the cross-field checks. */
export const holdsConfigSchema = z.object(baseShape).strict().superRefine((c, ctx) => {
  if (c.warnDays >= c.cancelDays) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["warnDays"],
      message: "The warning day must come before the cancel day",
    });
  }
});

/** PATCH / preview body: any subset of fields (and any subset of presets). */
export const holdsConfigPatchSchema = z
  .object({ ...baseShape, presets: baseShape.presets.partial().strict() })
  .partial()
  .strict();
export type HoldsConfigPatch = z.infer<typeof holdsConfigPatchSchema>;

export type MergeResult =
  | { ok: true; config: HoldsConfig }
  | { ok: false; errors: Array<{ field: string; message: string }> };

/** current ⊕ patch → validated full config (or field errors). */
export function mergeHoldsConfig(current: HoldsConfig, patch: unknown): MergeResult {
  const p = holdsConfigPatchSchema.safeParse(patch);
  if (!p.success) {
    return { ok: false, errors: p.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) };
  }
  const merged = { ...current, ...p.data, presets: { ...current.presets, ...(p.data.presets ?? {}) } };
  const full = holdsConfigSchema.safeParse(merged);
  if (!full.success) {
    return { ok: false, errors: full.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) };
  }
  return { ok: true, config: full.data };
}

// ---- parse (raw strings → config) ------------------------------------------

type RawSettings = Partial<Record<string, string | undefined>>;

function numOr(raw: string | undefined, def: number, ok: (n: number) => boolean): number {
  const s = (raw ?? "").trim();
  // "" means "use the default" (Number("") is 0, which would silently flag
  // every overdue customer when someone just clears the field).
  if (s === "") return def;
  const n = Number(s);
  return Number.isFinite(n) && ok(n) ? n : def;
}

function intIn(raw: string | undefined, def: number, b: { min: number; max: number }): number {
  return Math.floor(numOr(raw, def, (n) => n >= b.min && n <= b.max));
}

function boolOr(raw: string | undefined, def: boolean): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return def;
}

/** holds_preset_overrides JSON → full table (bad/missing entries → built-in). */
export function parsePresetOverrides(raw: string | undefined, base: PresetTable = PRESET_NUMBERS): PresetTable {
  const out = clonePresets(base);
  const s = (raw ?? "").trim();
  if (!s) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isNumberedPreset(k)) continue;
    const r = presetNumbersSchema.safeParse(v);
    if (r.success) out[k] = r.data;
  }
  return out;
}

export function parseHoldsConfig(settings: RawSettings): HoldsConfig {
  const d = HOLDS_CONFIG_DEFAULTS;
  const k = HOLDS_SETTING_KEYS;
  const get = (f: HoldsConfigField) => settings[k[f]];
  const presetRaw = (get("defaultRulePreset") ?? "").trim();
  const scopeRaw = (get("defaultRuleScope") ?? "").trim();
  const warnDays = intIn(get("warnDays"), d.warnDays, BOUNDS.ladderDays);
  let cancelDays = intIn(get("cancelDays"), d.cancelDays, BOUNDS.ladderDays);
  // A hand-edited pair that's out of order: keep the ladder sane.
  if (cancelDays <= warnDays) cancelDays = Math.min(BOUNDS.ladderDays.max, warnDays + 1);
  return {
    overdueThresholdGbp: numOr(get("overdueThresholdGbp"), d.overdueThresholdGbp, (n) => n >= 0),
    noContactDays: Math.floor(numOr(get("noContactDays"), d.noContactDays, (n) => n > 0)),
    // Recipient lists: blank IS meaningful (= nobody), so take the stored
    // value as-is. A key that was never stored falls back to the default.
    overdueRecipients: (get("overdueRecipients") ?? d.overdueRecipients).trim(),
    holdAlertLookbackDays: intIn(get("holdAlertLookbackDays"), d.holdAlertLookbackDays, BOUNDS.alertLookbackDays),
    overdueAlertLookbackDays: intIn(get("overdueAlertLookbackDays"), d.overdueAlertLookbackDays, BOUNDS.alertLookbackDays),
    defaultRuleEnabled: boolOr(get("defaultRuleEnabled"), d.defaultRuleEnabled),
    defaultRulePreset: isNumberedPreset(presetRaw) ? presetRaw : d.defaultRulePreset,
    defaultRuleScope: (DEFAULT_RULE_SCOPES as readonly string[]).includes(scopeRaw)
      ? (scopeRaw as DefaultRuleScope)
      : d.defaultRuleScope,
    presets: parsePresetOverrides(get("presets")),
    defaultMinBalance: numOr(get("defaultMinBalance"), d.defaultMinBalance, (n) => n >= 0 && n <= BOUNDS.money.max),
    ruleOrderLookbackDays: intIn(get("ruleOrderLookbackDays"), d.ruleOrderLookbackDays, BOUNDS.listLookbackDays),
    overdueWidgetLookbackDays: intIn(get("overdueWidgetLookbackDays"), d.overdueWidgetLookbackDays, BOUNDS.listLookbackDays),
    warnDays,
    cancelDays,
    warehouseRecipients: (get("warehouseRecipients") ?? d.warehouseRecipients).trim(),
    teamRecipients: (get("teamRecipients") ?? d.teamRecipients).trim(),
    autoReleaseEmailsWarehouse: boolOr(get("autoReleaseEmailsWarehouse"), d.autoReleaseEmailsWarehouse),
    ruleHoldsRespectPromise: boolOr(get("ruleHoldsRespectPromise"), d.ruleHoldsRespectPromise),
  };
}

// ---- serialize (config → raw strings) --------------------------------------

function serializeField(c: HoldsConfig, f: HoldsConfigField): string {
  const v = c[f];
  if (f === "presets") {
    const t = v as PresetTable;
    // Stable key order so an unchanged table never diffs.
    const ordered: Record<string, HoldRuleNumbers> = {};
    for (const p of NUMBERED_PRESETS) {
      ordered[p] = {
        termsDays: t[p].termsDays,
        holdWhenInvoiceDaysOver: t[p].holdWhenInvoiceDaysOver,
        minBalance: t[p].minBalance,
      };
    }
    return JSON.stringify(ordered);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export function serializeHoldsConfig(c: HoldsConfig): Record<HoldsSettingKey, string> {
  const out = {} as Record<HoldsSettingKey, string>;
  for (const f of Object.keys(HOLDS_SETTING_KEYS) as HoldsConfigField[]) {
    out[HOLDS_SETTING_KEYS[f]] = serializeField(c, f);
  }
  return out;
}

/** Keys whose serialized value differs → {key: [before, after]}. */
export function diffHoldsConfig(
  before: HoldsConfig,
  after: HoldsConfig,
): Array<{ key: HoldsSettingKey; field: HoldsConfigField; before: string; after: string }> {
  const out: Array<{ key: HoldsSettingKey; field: HoldsConfigField; before: string; after: string }> = [];
  for (const f of Object.keys(HOLDS_SETTING_KEYS) as HoldsConfigField[]) {
    const b = serializeField(before, f);
    const a = serializeField(after, f);
    if (a !== b) out.push({ key: HOLDS_SETTING_KEYS[f], field: f, before: b, after: a });
  }
  return out;
}

// ---- sections (UI + "changed by" lines) ------------------------------------

export const HOLDS_SETTINGS_SECTIONS = [
  "standard",
  "presets",
  "flags",
  "ladder",
  "autoRelease",
  "exclusions",
] as const;
export type HoldsSettingsSection = (typeof HOLDS_SETTINGS_SECTIONS)[number];

export const SECTION_FIELDS: Record<HoldsSettingsSection, HoldsConfigField[]> = {
  standard: [
    "overdueThresholdGbp",
    "noContactDays",
    "overdueRecipients",
    "holdAlertLookbackDays",
    "overdueAlertLookbackDays",
    "defaultRuleEnabled",
    "defaultRulePreset",
    "defaultRuleScope",
  ],
  presets: ["presets", "defaultMinBalance"],
  flags: ["ruleOrderLookbackDays", "overdueWidgetLookbackDays"],
  ladder: ["warnDays", "cancelDays", "warehouseRecipients", "teamRecipients"],
  autoRelease: ["autoReleaseEmailsWarehouse", "ruleHoldsRespectPromise"],
  exclusions: [],
};

export function sectionForKey(key: string): HoldsSettingsSection | null {
  for (const s of HOLDS_SETTINGS_SECTIONS) {
    if (SECTION_FIELDS[s].some((f) => HOLDS_SETTING_KEYS[f] === key)) return s;
  }
  return null;
}

export type SettingsAuditRow = {
  at: string;
  by: string | null;
  // Keys this audit row changed.
  keys: string[];
};

export type LastChanged = Record<HoldsSettingsSection, { at: string; by: string | null } | null>;

/** Newest change per section from audit rows (any order in). */
export function lastChangedBySection(rows: readonly SettingsAuditRow[]): LastChanged {
  const out: LastChanged = {
    standard: null,
    presets: null,
    flags: null,
    ladder: null,
    autoRelease: null,
    exclusions: null,
  };
  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  for (const r of sorted) {
    for (const k of r.keys) {
      const s = sectionForKey(k);
      if (s && !out[s]) out[s] = { at: r.at, by: r.by };
    }
  }
  return out;
}
