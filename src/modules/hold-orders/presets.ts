// Customer hold-rule presets (Hold Orders app). PURE — imported by both the
// server (rules engine, routes) and the Hold Orders SPA (rules editor), so it
// must not import anything Node- or DB-specific.
//
// Semantics of a rule (operator decision 2026-11-26 — rules are OVERDUE-based):
//   - Days overdue = whole days since an invoice's DUE DATE (invoices.due_date,
//     which QBO derives from the customer's terms). When an invoice has no due
//     date we derive it as issue_date + the customer's terms days; with no
//     terms either, the invoice is treated as not overdue.
//   - An order is held by a rule when the customer has AT LEAST ONE open
//     Feldart-book invoice (balance > 0, not void/paid/draft, not a 2030
//     placeholder, not under TJ dispute verification) that is STRICTLY more
//     than `graceDays` overdue, AND the customer's total OVERDUE balance (open
//     balance on invoices past their due date) is ≥ `minOverdue`.
//   - Terms are NOT part of the rule. They live on the finance customer record
//     (customers.payment_terms, pushed to QBO) and are shown read-only — see
//     terms.ts.
//   - "never": this customer is never auto-held by the customer-rule engine,
//     and is also excluded from the standard overdue-review flag. It does NOT
//     stop manual holds, and does NOT stop the two account-state holds
//     (customer on hold / payment-upfront unpaid).
//   - Preset numbers are LIVE: admins edit them in Hold Orders → Settings
//     (app setting holds_preset_overrides). A preset row resolves the current
//     numbers at evaluation time, so editing "Standard" moves every Standard
//     customer. Custom rows keep their own numbers.

export const HOLD_RULE_PRESETS = ["strict", "standard", "relaxed", "never", "custom"] as const;

export type HoldRulePreset = (typeof HOLD_RULE_PRESETS)[number];

export type HoldRuleNumbers = {
  // Hold once an invoice is MORE than this many days past its due date.
  graceDays: number;
  // ...and the customer's overdue balance is at least this much.
  minOverdue: number;
};

// Presets that carry numbers (everything except "never" and "custom").
export const NUMBERED_PRESETS = ["strict", "standard", "relaxed"] as const;
export type NumberedPreset = (typeof NUMBERED_PRESETS)[number];
export type PresetTable = Record<NumberedPreset, HoldRuleNumbers>;

export function isNumberedPreset(p: string): p is NumberedPreset {
  return (NUMBERED_PRESETS as readonly string[]).includes(p);
}

// Small leftovers (a few dollars of short-pay) shouldn't stop shipments; $50
// matches the hub signals' "worth chasing" floor. Default only — editable in
// Settings (holds_default_min_balance, now read as the min OVERDUE amount).
export const DEFAULT_RULE_MIN_OVERDUE = 50;

// The BUILT-IN preset numbers = the defaults behind the Settings overrides.
export const PRESET_NUMBERS: PresetTable = {
  strict: { graceDays: 0, minOverdue: DEFAULT_RULE_MIN_OVERDUE },
  standard: { graceDays: 15, minOverdue: DEFAULT_RULE_MIN_OVERDUE },
  relaxed: { graceDays: 30, minOverdue: DEFAULT_RULE_MIN_OVERDUE },
};

const PRESET_NAMES: Record<NumberedPreset, string> = {
  strict: "Strict",
  standard: "Standard",
  relaxed: "Relaxed",
};

export const PRESET_LABELS: Record<HoldRulePreset, string> = {
  strict: "Strict — hold as soon as overdue",
  standard: "Standard — 15 days overdue",
  relaxed: "Relaxed — 30 days overdue",
  never: "Never hold automatically",
  custom: "Custom",
};

/** "as soon as overdue" / "15 days overdue". */
export function graceText(graceDays: number): string {
  if (graceDays <= 0) return "as soon as overdue";
  return `${graceDays} day${graceDays === 1 ? "" : "s"} overdue`;
}

function numberedLabel(preset: NumberedPreset, n: Pick<HoldRuleNumbers, "graceDays">): string {
  const name = PRESET_NAMES[preset];
  return n.graceDays <= 0 ? `${name} — hold as soon as overdue` : `${name} — ${graceText(n.graceDays)}`;
}

/** Dropdown label for a preset, built from the live (possibly edited) numbers. */
export function presetLabel(preset: HoldRulePreset, table: PresetTable = PRESET_NUMBERS): string {
  if (!isNumberedPreset(preset)) return PRESET_LABELS[preset];
  return numberedLabel(preset, table[preset]);
}

// Old (v1/v2) preset names → new ones. Used to read stored settings that
// predate the overdue model (e.g. holds_default_rule_preset).
const LEGACY_PRESETS: Record<string, HoldRulePreset> = {
  standard_30_45: "standard",
  extended_60_75: "standard",
  vip_90_110: "custom",
  strict: "strict",
  never: "never",
  custom: "custom",
};

/** A stored preset value (new or legacy) → a current preset, or null. */
export function normalisePreset(v: string | null | undefined): HoldRulePreset | null {
  if (!v) return null;
  if ((HOLD_RULE_PRESETS as readonly string[]).includes(v)) return v as HoldRulePreset;
  return LEGACY_PRESETS[v] ?? null;
}

export type HoldRuleInput = {
  preset: HoldRulePreset;
  // Only read for "custom"; presets use the live preset numbers.
  graceDays?: number | null;
  minOverdue?: number | null;
  autoStartLadder: boolean;
  autoReleaseOnPayment: boolean;
  notifyWarehouse: boolean;
  note?: string | null;
};

export type ResolvedHoldRule = HoldRuleNumbers & {
  preset: HoldRulePreset;
  autoStartLadder: boolean;
  autoReleaseOnPayment: boolean;
  notifyWarehouse: boolean;
  note: string | null;
};

export type RuleValidation =
  | { ok: true; rule: ResolvedHoldRule }
  | { ok: false; error: string };

export const MAX_GRACE_DAYS = 365;
export const MAX_MIN_OVERDUE = 100_000;

/**
 * Presets → concrete numbers from `table` (the live preset numbers; defaults
 * to the built-ins); custom → validated user numbers (a blank minimum falls
 * back to `defaultMinOverdue`).
 */
export function resolveHoldRule(
  input: HoldRuleInput,
  table: PresetTable = PRESET_NUMBERS,
  defaultMinOverdue: number = DEFAULT_RULE_MIN_OVERDUE,
): RuleValidation {
  const common = {
    preset: input.preset,
    autoStartLadder: input.autoStartLadder,
    autoReleaseOnPayment: input.autoReleaseOnPayment,
    notifyWarehouse: input.notifyWarehouse,
    note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
  };
  if (input.preset === "never") {
    return { ok: true, rule: { ...common, graceDays: 0, minOverdue: 0 } };
  }
  if (input.preset !== "custom") {
    return { ok: true, rule: { ...common, ...table[input.preset] } };
  }
  const grace = input.graceDays;
  const min = input.minOverdue ?? defaultMinOverdue;
  if (grace == null || !Number.isInteger(grace) || grace < 0 || grace > MAX_GRACE_DAYS) {
    return { ok: false, error: `Days overdue must be a whole number (0–${MAX_GRACE_DAYS}).` };
  }
  if (!Number.isFinite(min) || min < 0 || min > MAX_MIN_OVERDUE) {
    return { ok: false, error: "Minimum overdue must be between $0 and $100,000." };
  }
  return { ok: true, rule: { ...common, graceDays: grace, minOverdue: Math.round(min * 100) / 100 } };
}

/**
 * "Standard — 15 days overdue" or "Custom — 20 days overdue (min $200)" —
 * shown in why-held lines. A rule supplied by the default b2b rule reads
 * "Default b2b rule (Standard — 15 days overdue)".
 */
export function describeRule(
  rule: Pick<ResolvedHoldRule, "preset" | "graceDays" | "minOverdue"> & { source?: "explicit" | "default" },
): string {
  let label: string;
  if (rule.preset === "never") label = PRESET_LABELS.never;
  else if (rule.preset !== "custom") label = numberedLabel(rule.preset, rule);
  else {
    const min = rule.minOverdue !== DEFAULT_RULE_MIN_OVERDUE ? ` (min $${rule.minOverdue.toFixed(0)})` : "";
    label = `Custom — ${graceText(rule.graceDays)}${min}`;
  }
  return rule.source === "default" ? `Default b2b rule (${label})` : label;
}
