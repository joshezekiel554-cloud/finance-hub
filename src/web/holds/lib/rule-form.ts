// Rules editor form state (pure). Preset numbers come from the SAME module
// the server resolves rules with, so the editor can't show stale numbers.

import {
  DEFAULT_RULE_MIN_BALANCE,
  PRESET_NUMBERS,
  resolveHoldRule,
  type HoldRulePreset,
  type HoldRuleNumbers,
  type PresetTable,
} from "../../../modules/hold-orders/presets";

export type RuleDraft = {
  preset: HoldRulePreset;
  termsDays: string;
  holdWhenInvoiceDaysOver: string;
  minBalance: string;
  autoStartLadder: boolean;
  autoReleaseOnPayment: boolean;
  notifyWarehouse: boolean;
  note: string;
};

export const NEW_RULE_DRAFT: RuleDraft = {
  preset: "standard_30_45",
  termsDays: "30",
  holdWhenInvoiceDaysOver: "45",
  minBalance: String(DEFAULT_RULE_MIN_BALANCE),
  // New rules don't email customers unless someone opts in.
  autoStartLadder: false,
  autoReleaseOnPayment: true,
  notifyWarehouse: true,
  note: "",
};

export function draftFromRule(r: {
  preset: HoldRulePreset;
  termsDays: number;
  holdWhenInvoiceDaysOver: number;
  minBalance: number;
  autoStartLadder: boolean;
  autoReleaseOnPayment: boolean;
  notifyWarehouse: boolean;
  note: string | null;
}): RuleDraft {
  return {
    preset: r.preset,
    termsDays: String(r.termsDays),
    holdWhenInvoiceDaysOver: String(r.holdWhenInvoiceDaysOver),
    minBalance: String(r.minBalance),
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
  return {
    termsDays: Number(d.termsDays),
    holdWhenInvoiceDaysOver: Number(d.holdWhenInvoiceDaysOver),
    minBalance: Number(d.minBalance),
  };
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
    termsDays: d.preset === "custom" ? intOrNull(d.termsDays) : null,
    holdWhenInvoiceDaysOver: d.preset === "custom" ? intOrNull(d.holdWhenInvoiceDaysOver) : null,
    minBalance: d.preset === "custom" && d.minBalance.trim() !== "" ? Number(d.minBalance) : null,
    autoStartLadder: d.autoStartLadder,
    autoReleaseOnPayment: d.autoReleaseOnPayment,
    notifyWarehouse: d.notifyWarehouse,
    note: d.note.trim() || null,
  };
  const check = resolveHoldRule(body);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, body };
}
