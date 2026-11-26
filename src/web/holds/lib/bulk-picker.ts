// Bulk customer picker (Customer rules → Select customers). Pure, unit-tested.

export type PickerRow = {
  id: string;
  name: string;
  email: string | null;
  rule: { label: string } | null;
  defaultScope: boolean;
};

export function filterRows<T extends Pick<PickerRow, "name" | "email">>(rows: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.email ?? "").toLowerCase().includes(needle));
}

/**
 * What the "current rule" column says. defaultScope comes from the server
 * (b2b AND hold_status active — on-hold / prepay accounts are never on the
 * default rule; the standard checks hold their orders).
 */
export function currentRuleLabel(
  row: Pick<PickerRow, "rule" | "defaultScope"> & { holdStatus?: string | null },
  defaultRuleOn: boolean,
): string {
  if (row.rule) return row.rule.label;
  if (row.defaultScope) return defaultRuleOn ? "Default rule" : "None (default rule is off)";
  if (row.holdStatus === "hold") return "None (account on hold)";
  if (row.holdStatus === "payment_upfront") return "None (payment upfront)";
  return "None";
}

export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Tick every visible row, or untick them all when they're all ticked already. */
export function toggleAllVisible(selected: ReadonlySet<string>, visible: ReadonlyArray<{ id: string }>): Set<string> {
  const next = new Set(selected);
  const allOn = visible.length > 0 && visible.every((r) => next.has(r.id));
  for (const r of visible) {
    if (allOn) next.delete(r.id);
    else next.add(r.id);
  }
  return next;
}

export function allVisibleTicked(selected: ReadonlySet<string>, visible: ReadonlyArray<{ id: string }>): boolean {
  return visible.length > 0 && visible.every((r) => selected.has(r.id));
}

/** Ticked customers that already have a rule (skipped unless overwrite). */
export function skippedCount(rows: ReadonlyArray<Pick<PickerRow, "id" | "rule">>, selected: ReadonlySet<string>, overwrite: boolean): number {
  if (overwrite) return 0;
  return rows.filter((r) => selected.has(r.id) && r.rule).length;
}

export const BULK_PICK_MAX = 1000;

export function applySummary(r: { applied: number; unchanged: number; skippedExisting: number; unknown: number }): string {
  const parts = [`Rule set on ${r.applied} customer${r.applied === 1 ? "" : "s"}`];
  if (r.unchanged) parts.push(`${r.unchanged} already had it`);
  if (r.skippedExisting) parts.push(`${r.skippedExisting} skipped (already had a rule)`);
  if (r.unknown) parts.push(`${r.unknown} not found`);
  return `${parts.join(" · ")}. Holds happen on the next orders sync.`;
}
