// Rules editor form state (pure). Preset numbers come from the SAME module
// the server resolves rules with, so the editor can't show stale numbers.
// Rules are overdue-based: the admin picks how many days PAST DUE before a
// hold (grace) and the minimum overdue amount. Terms are NOT edited here —
// they're the customer's payment_terms from finance (shown read-only).

import {
  DEFAULT_RULE_MIN_OVERDUE,
  PRESET_NUMBERS,
  resolveHoldRule,
  type HoldRulePreset,
  type HoldRuleNumbers,
  type PresetTable,
} from "../../../modules/hold-orders/presets";

export type RuleDraft = {
  preset: HoldRulePreset;
  graceDays: string;
  minOverdue: string;
  autoStartLadder: boolean;
  autoReleaseOnPayment: boolean;
  notifyWarehouse: boolean;
  note: string;
};

export const NEW_RULE_DRAFT: RuleDraft = {
  preset: "standard",
  graceDays: String(PRESET_NUMBERS.standard.graceDays),
  minOverdue: String(DEFAULT_RULE_MIN_OVERDUE),
  // New rules don't email customers unless someone opts in.
  autoStartLadder: false,
  autoReleaseOnPayment: true,
  notifyWarehouse: true,
  note: "",
};

export function draftFromRule(r: {
  preset: HoldRulePreset;
  graceDays: number;
  minOverdue: number;
  autoStartLadder: boolean;
  autoReleaseOnPayment: boolean;
  notifyWarehouse: boolean;
  note: string | null;
}): RuleDraft {
  return {
    preset: r.preset,
    graceDays: String(r.graceDays),
    minOverdue: String(r.minOverdue),
    autoStartLadder: r.autoStartLadder,
    autoReleaseOnPayment: r.autoReleaseOnPayment,
    notifyWarehouse: r.notifyWarehouse,
    note: r.note ?? "",
  };
}

/**
 * Numbers to DISPLAY for a preset (custom → whatever's typed). `table` = the
 * live preset numbers from Settings (falls back to the built-ins).
 */
export function displayNumbers(d: RuleDraft, table: PresetTable = PRESET_NUMBERS): HoldRuleNumbers | null {
  if (d.preset === "never") return null;
  if (d.preset !== "custom") return table[d.preset];
  return { graceDays: Number(d.graceDays), minOverdue: Number(d.minOverdue) };
}

function intOrNull(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}

/** Wire body for PUT /rules/:id and /rules/preview, or a validation error. */
export function draftToBody(
  d: RuleDraft,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body = {
    preset: d.preset,
    graceDays: d.preset === "custom" ? intOrNull(d.graceDays) : null,
    minOverdue: d.preset === "custom" && d.minOverdue.trim() !== "" ? Number(d.minOverdue) : null,
    autoStartLadder: d.autoStartLadder,
    autoReleaseOnPayment: d.autoReleaseOnPayment,
    notifyWarehouse: d.notifyWarehouse,
    note: d.note.trim() || null,
  };
  const check = resolveHoldRule(body);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, body };
}
