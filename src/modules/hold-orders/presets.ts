// Customer hold-rule presets (Hold Orders app). PURE — imported by both the
// server (rules engine, routes) and the Hold Orders SPA (rules editor), so it
// must not import anything Node- or DB-specific.
//
// Semantics of a rule (documented once, here):
//   - Age of an invoice = whole days since its INVOICE DATE (QBO TxnDate,
//     invoices.issue_date). Operator example "terms 90, unpaid over 110 →
//     hold" reads naturally as "an invoice more than 110 days old is still
//     unpaid". When an invoice has no issue date we derive it as
//     due_date − terms_days.
//   - An order is held by a rule when the customer has AT LEAST ONE open
//     Feldart-book invoice (balance > 0, not void/paid/draft, not a 2030
//     placeholder, not under TJ dispute verification) whose age is STRICTLY
//     greater than holdWhenInvoiceDaysOver, AND the customer's total open
//     balance across those open invoices is ≥ minBalance.
//   - termsDays is informational for the editor ("terms 90") + the fallback
//     invoice-date derivation; the hold trigger is holdWhenInvoiceDaysOver.
//   - "never": this customer is never auto-held by the customer-rule engine,
//     and is also excluded from the standard overdue-review flag (the
//     "large overdue + not communicating" alert / at-risk list). It does NOT
//     stop manual holds, and does NOT stop the two account-state holds
//     (customer on hold / payment-upfront unpaid) — those are about the
//     account's status, not invoice age.

export const HOLD_RULE_PRESETS = [
  "standard_30_45",
  "extended_60_75",
  "vip_90_110",
  "strict",
  "never",
  "custom",
] as const;

export type HoldRulePreset = (typeof HOLD_RULE_PRESETS)[number];

export type HoldRuleNumbers = {
  termsDays: number;
  holdWhenInvoiceDaysOver: number;
  minBalance: number;
};

// Small leftovers (a few dollars of short-pay) shouldn't stop shipments; $50
// matches the hub signals' "worth chasing" floor.
export const DEFAULT_RULE_MIN_BALANCE = 50;

export const PRESET_NUMBERS: Record<
  Exclude<HoldRulePreset, "custom" | "never">,
  HoldRuleNumbers
> = {
  standard_30_45: { termsDays: 30, holdWhenInvoiceDaysOver: 45, minBalance: DEFAULT_RULE_MIN_BALANCE },
  extended_60_75: { termsDays: 60, holdWhenInvoiceDaysOver: 75, minBalance: DEFAULT_RULE_MIN_BALANCE },
  vip_90_110: { termsDays: 90, holdWhenInvoiceDaysOver: 110, minBalance: DEFAULT_RULE_MIN_BALANCE },
  // Strict: hold the moment a 30-day invoice is past due, any balance.
  strict: { termsDays: 30, holdWhenInvoiceDaysOver: 30, minBalance: 0 },
};

export const PRESET_LABELS: Record<HoldRulePreset, string> = {
  standard_30_45: "Standard 30/45",
  extended_60_75: "Extended 60/75",
  vip_90_110: "VIP 90/110",
  strict: "Strict (hold when past due)",
  never: "Never hold automatically",
  custom: "Custom",
};

export type HoldRuleInput = {
  preset: HoldRulePreset;
  // Only read for "custom"; presets override with their fixed numbers.
  termsDays?: number | null;
  holdWhenInvoiceDaysOver?: number | null;
  minBalance?: number | null;
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

const MAX_DAYS = 730;

/** Presets → concrete numbers; custom → validated user numbers. */
export function resolveHoldRule(input: HoldRuleInput): RuleValidation {
  const common = {
    preset: input.preset,
    autoStartLadder: input.autoStartLadder,
    autoReleaseOnPayment: input.autoReleaseOnPayment,
    notifyWarehouse: input.notifyWarehouse,
    note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
  };
  if (input.preset === "never") {
    // Numbers are irrelevant; store zeros so the row is well-formed.
    return { ok: true, rule: { ...common, termsDays: 0, holdWhenInvoiceDaysOver: 0, minBalance: 0 } };
  }
  if (input.preset !== "custom") {
    return { ok: true, rule: { ...common, ...PRESET_NUMBERS[input.preset] } };
  }
  const terms = input.termsDays;
  const over = input.holdWhenInvoiceDaysOver;
  const min = input.minBalance ?? DEFAULT_RULE_MIN_BALANCE;
  if (terms == null || !Number.isInteger(terms) || terms < 0 || terms > MAX_DAYS) {
    return { ok: false, error: "Terms must be a whole number of days (0–730)." };
  }
  if (over == null || !Number.isInteger(over) || over < 0 || over > MAX_DAYS) {
    return { ok: false, error: "Hold-after days must be a whole number (0–730)." };
  }
  if (over < terms) {
    return { ok: false, error: "Hold-after days can't be less than the terms." };
  }
  if (!Number.isFinite(min) || min < 0) {
    return { ok: false, error: "Minimum balance must be zero or more." };
  }
  return {
    ok: true,
    rule: { ...common, termsDays: terms, holdWhenInvoiceDaysOver: over, minBalance: Math.round(min * 100) / 100 },
  };
}

/** "VIP 90/110" or "Custom 45/60 (min $200)" — shown in why-held lines. */
export function describeRule(rule: Pick<ResolvedHoldRule, "preset" | "termsDays" | "holdWhenInvoiceDaysOver" | "minBalance">): string {
  if (rule.preset === "never") return PRESET_LABELS.never;
  if (rule.preset !== "custom") return PRESET_LABELS[rule.preset];
  const min = rule.minBalance > 0 ? ` (min $${rule.minBalance.toFixed(0)})` : "";
  return `Custom ${rule.termsDays}/${rule.holdWhenInvoiceDaysOver}${min}`;
}
