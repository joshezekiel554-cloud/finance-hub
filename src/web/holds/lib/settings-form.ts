// Hold Orders → Settings form logic (pure, unit-tested). Labels + plain-English
// explanations per setting, draft <-> config, and the PATCH body. Validation
// is the SAME zod schema the server enforces (mergeHoldsConfig).

import {
  HOLDS_SETTINGS_SECTIONS,
  SECTION_FIELDS,
  diffHoldsConfig,
  mergeHoldsConfig,
  type HoldsConfig,
  type HoldsConfigField,
  type HoldsConfigPatch,
  type HoldsSettingsSection,
} from "../../../modules/hold-orders/holds-settings";
import {
  NUMBERED_PRESETS,
  presetLabel,
  type NumberedPreset,
  type PresetTable,
} from "../../../modules/hold-orders/presets";
import type { CandidateSource } from "../../../modules/hold-orders/bulk-rules";
import type { ExclusionKind } from "../../../modules/hold-orders/exclusions";

export type { CandidateSource, ExclusionKind };

export const SECTION_TITLES: Record<HoldsSettingsSection, string> = {
  standard: "Standard rules",
  presets: "Presets",
  flags: "“Possible hold” flags",
  ladder: "Email ladder",
  autoRelease: "Auto-release",
  exclusions: "Exclusions",
};

export const SECTION_INTROS: Record<HoldsSettingsSection, string> = {
  standard: "The checks every customer gets, plus the optional default rule for b2b customers without a rule of their own.",
  presets: "The numbers behind each preset. Customers on a preset follow these straight away; custom rules keep their own numbers.",
  flags: "What puts an open order on the At risk tab (and the finance dashboard's “Orders to review”) without holding it.",
  ladder: "The Day-0 / warning / cancel emails for held orders that chase the customer.",
  autoRelease: "What happens automatically when a held customer pays or promises to pay.",
  exclusions: "Who is carved out of the automatic checks. Change these on the customer page or in the customer's rule.",
};

export { HOLDS_SETTINGS_SECTIONS, SECTION_FIELDS };

export type FieldKind = "int" | "money" | "emails" | "bool" | "preset" | "scope";

export type FieldMeta = { label: string; help: string; kind: FieldKind; unit?: string };

export const FIELD_META: Record<Exclude<HoldsConfigField, "presets">, FieldMeta> = {
  overdueThresholdGbp: {
    label: "Overdue review threshold",
    help: "An order from a customer who owes at least this much overdue (and isn't in touch) is flagged for review.",
    kind: "money",
    unit: "£",
  },
  noContactDays: {
    label: "“Not in contact” after",
    help: "No email either way for this many days counts as not communicating.",
    kind: "int",
    unit: "days",
  },
  overdueRecipients: {
    label: "Review email goes to",
    help: "Who gets the “review this order” email. Comma-separated; leave blank to send nobody.",
    kind: "emails",
  },
  holdAlertLookbackDays: {
    label: "New-order window for hold alerts",
    help: "Orders from an on-hold or prepay-unpaid customer are held and the warehouse alerted only if they're this new. Stops old orders being re-alerted.",
    kind: "int",
    unit: "days",
  },
  overdueAlertLookbackDays: {
    label: "New-order window for review emails",
    help: "The overdue review email only goes out for orders this new.",
    kind: "int",
    unit: "days",
  },
  defaultRuleEnabled: {
    label: "Default rule for b2b customers",
    help: "When on, every b2b customer without a rule of their own is treated as if they had the preset below. A customer's own rule (even “never”) always wins.",
    kind: "bool",
  },
  defaultRulePreset: {
    label: "Default rule preset",
    help: "Which preset the default rule uses. It emails the warehouse when it holds, doesn't email the customer, and releases on payment.",
    kind: "preset",
  },
  defaultRuleScope: {
    label: "Who the default rule covers",
    help: "Customers whose finance type is B2B (set on the customer page / b2b import).",
    kind: "scope",
  },
  defaultMinOverdue: {
    label: "Default minimum overdue",
    help: "Used by custom rules that leave the minimum blank. Below this much overdue nothing is held.",
    kind: "money",
    unit: "$",
  },
  ruleOrderLookbackDays: {
    label: "Open-order window",
    help: "Rules and the At risk tab only look at open orders placed in this many days. Older unshipped orders are usually stale Shopify records.",
    kind: "int",
    unit: "days",
  },
  overdueWidgetLookbackDays: {
    label: "“Orders to review” list window",
    help: "How far back the overdue review list looks (At risk tab and the finance dashboard).",
    kind: "int",
    unit: "days",
  },
  warnDays: {
    label: "Warning email on day",
    help: "Days after the hold started that the customer gets the final warning. Must be before the cancel day.",
    kind: "int",
    unit: "days",
  },
  cancelDays: {
    label: "Cancel notice on day",
    help: "Days after the hold started that the warehouse + team are told to cancel and return to stock.",
    kind: "int",
    unit: "days",
  },
  warehouseRecipients: {
    label: "Warehouse emails",
    help: "Hold alerts, good-to-send and cancel notices. Comma-separated. Shared with finance Settings.",
    kind: "emails",
  },
  teamRecipients: {
    label: "Team emails",
    help: "Copied on hold alerts and cancel notices. Comma-separated. Shared with finance Settings.",
    kind: "emails",
  },
  autoReleaseEmailsWarehouse: {
    label: "Email the warehouse “good to send” on auto-release",
    help: "When a hold clears by itself (paid in QBO, account taken off hold), reply on the warehouse's alert thread — only if the warehouse was alerted about that hold.",
    kind: "bool",
  },
  ruleHoldsRespectPromise: {
    label: "A promise to pay stops new rule holds",
    help: "Off: a customer rule still holds new orders while a promise is active (the promise only pauses the customer emails). On: no new rule holds until the promised date passes.",
    kind: "bool",
  },
};

export const PRESET_NUMBER_LABELS = {
  graceDays: "Days overdue",
  minOverdue: "Min overdue ($)",
} as const;
export type PresetNumberField = keyof typeof PRESET_NUMBER_LABELS;

// ---- draft ------------------------------------------------------------------

export type ScalarField = Exclude<HoldsConfigField, "presets">;
export type SettingsDraft = {
  fields: Record<ScalarField, string | boolean>;
  presets: Record<NumberedPreset, Record<PresetNumberField, string>>;
};

export function draftFromConfig(c: HoldsConfig): SettingsDraft {
  const fields = {} as Record<ScalarField, string | boolean>;
  for (const f of Object.keys(FIELD_META) as ScalarField[]) {
    const v = c[f];
    fields[f] = typeof v === "boolean" ? v : String(v);
  }
  const presets = {} as SettingsDraft["presets"];
  for (const p of NUMBERED_PRESETS) {
    presets[p] = {
      graceDays: String(c.presets[p].graceDays),
      minOverdue: String(c.presets[p].minOverdue),
    };
  }
  return { fields, presets };
}

function num(s: string): number {
  return s.trim() === "" ? Number.NaN : Number(s);
}

/** Draft → candidate config (numbers parsed; NaN fails validation). */
export function draftToCandidate(d: SettingsDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of Object.keys(FIELD_META) as ScalarField[]) {
    const meta = FIELD_META[f];
    const v = d.fields[f];
    if (meta.kind === "bool") out[f] = Boolean(v);
    else if (meta.kind === "int" || meta.kind === "money") out[f] = num(String(v));
    else out[f] = String(v).trim();
  }
  const presets: Record<string, unknown> = {};
  for (const p of NUMBERED_PRESETS) {
    presets[p] = {
      graceDays: num(d.presets[p].graceDays),
      minOverdue: num(d.presets[p].minOverdue),
    };
  }
  out.presets = presets;
  return out;
}

export type DraftResult =
  | { ok: true; config: HoldsConfig; patch: HoldsConfigPatch; changed: HoldsConfigField[] }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate the draft against the server's schema and build the PATCH body
 * with only the changed fields. errors are keyed "warnDays" /
 * "presets.relaxed.minOverdue".
 */
export function draftToPatch(d: SettingsDraft, current: HoldsConfig): DraftResult {
  const merged = mergeHoldsConfig(current, draftToCandidate(d));
  if (!merged.ok) {
    const errors: Record<string, string> = {};
    for (const e of merged.errors) {
      const key = e.field || "_";
      if (!errors[key]) errors[key] = friendly(e.message);
    }
    return { ok: false, errors };
  }
  const diff = diffHoldsConfig(current, merged.config);
  const patch: Record<string, unknown> = {};
  for (const c of diff) patch[c.field] = merged.config[c.field];
  return { ok: true, config: merged.config, patch: patch as HoldsConfigPatch, changed: diff.map((c) => c.field) };
}

function friendly(msg: string): string {
  if (/Expected number, received nan/i.test(msg)) return "Enter a number";
  if (/Expected integer/i.test(msg)) return "Whole numbers only";
  const min = /greater than or equal to (\d+)/.exec(msg);
  if (min) return `Must be at least ${min[1]}`;
  const max = /less than or equal to (\d+)/.exec(msg);
  if (max) return `Must be ${max[1]} or less`;
  return msg;
}

export function sectionHasChanges(section: HoldsSettingsSection, changed: readonly HoldsConfigField[]): boolean {
  return SECTION_FIELDS[section].some((f) => changed.includes(f));
}

/** "£1,000" / "14 days" / "On" — the read-only + "Default:" display. */
export function formatSettingValue(field: ScalarField, c: HoldsConfig, table: PresetTable = c.presets): string {
  const meta = FIELD_META[field];
  const v = c[field];
  switch (meta.kind) {
    case "bool":
      return v ? "On" : "Off";
    case "money":
      return `${meta.unit ?? ""}${Number(v).toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
    case "int":
      return `${String(v)}${meta.unit ? ` ${meta.unit}` : ""}`;
    case "preset":
      return presetLabel(v as NumberedPreset, table);
    case "scope":
      return "B2B customers (finance type)";
    case "emails":
      return String(v).trim() || "Nobody";
  }
}

const LADDER_TEMPLATE_NAMES: Record<string, string> = {
  hold_notice: "Day-0 notice",
  hold_warning: "warning",
  hold_cancel: "cancel notice",
};

/**
 * Warn when operator-edited ladder templates still say "3 days" / "day 7" /
 * "day 10" literally but the (draft) days are no longer 7/10. Stored text is
 * never rewritten for them; they fix it in finance Settings → order emails
 * (the defaults use {{warn_day}} / {{cancel_day}} / {{days_until_cancel}}).
 */
export function ladderTemplateWarning(
  literals: readonly string[],
  days: { warnDays: number; cancelDays: number },
): string | null {
  if (literals.length === 0) return null;
  if (days.warnDays === 7 && days.cancelDays === 10) return null;
  const names = literals.map((k) => LADDER_TEMPLATE_NAMES[k] ?? k).join(", ");
  return `The edited ${names} email template${literals.length === 1 ? "" : "s"} still say${literals.length === 1 ? "s" : ""} “3 days” / “day 7” / “day 10” in words, but the ladder is now day ${days.warnDays} / day ${days.cancelDays}. Update the text in finance Settings → order emails (use {{days_until_cancel}}, {{warn_day}}, {{cancel_day}}).`;
}

/** The warning banner for Settings + the customer rules list. */
export function defaultRuleBanner(values: Pick<HoldsConfig, "defaultRuleEnabled">): string | null {
  return values.defaultRuleEnabled ? null : "Default rule: not set up yet";
}

export const EXCLUSION_LABELS: Record<ExclusionKind, { title: string; help: string }> = {
  never: { title: "Rule: never hold automatically", help: "No rule holds and no overdue review flag. Manual and account holds still apply." },
  payment_upfront: { title: "Payment upfront", help: "Prepay customers: each order is held until it's paid in Shopify." },
  account_hold: { title: "Account on hold", help: "Every new order is held." },
  ladder_off: { title: "Held orders with customer emails off", help: "These holds never email the customer." },
  autopilot_off: { title: "Autopilot excluded", help: "Left out of the overdue review flag." },
};

export const CANDIDATE_SOURCE_LABELS: Record<CandidateSource, string> = {
  shopify_b2b: "Tagged b2b in Shopify",
  finance_b2b: "Finance type = B2B",
  no_rule: "Has no rule yet",
  preset: "On preset…",
};
