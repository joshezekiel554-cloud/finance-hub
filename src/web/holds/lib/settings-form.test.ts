import { describe, expect, it } from "vitest";
import {
  defaultRuleBanner,
  draftFromConfig,
  draftToPatch,
  formatSettingValue,
  ladderTemplateWarning,
  sectionHasChanges,
} from "./settings-form";
import {
  allVisibleTicked,
  applySummary,
  currentRuleLabel,
  filterRows,
  skippedCount,
  toggleAllVisible,
  toggleId,
} from "./bulk-picker";
import { displayNumbers, NEW_RULE_DRAFT } from "./rule-form";
import { promiseLine } from "./view";
import { HOLDS_CONFIG_DEFAULTS } from "../../../modules/hold-orders/holds-settings";
import { parsePresetOverrides } from "../../../modules/hold-orders/holds-settings";

const cur = HOLDS_CONFIG_DEFAULTS;

describe("settings form", () => {
  it("untouched draft → valid, no changes", () => {
    const r = draftToPatch(draftFromConfig(cur), cur);
    expect(r).toMatchObject({ ok: true, changed: [], patch: {} });
  });

  it("patch carries only changed fields, typed", () => {
    const d = draftFromConfig(cur);
    d.fields.warnDays = "5";
    d.fields.defaultRuleEnabled = true;
    d.presets.relaxed.graceDays = "45";
    const r = draftToPatch(d, cur);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed.sort()).toEqual(["defaultRuleEnabled", "presets", "warnDays"]);
    expect(r.patch).toMatchObject({ warnDays: 5, defaultRuleEnabled: true });
    expect(r.patch.presets?.relaxed).toEqual({ graceDays: 45, minOverdue: 50 });
    expect(sectionHasChanges("ladder", r.changed)).toBe(true);
    expect(sectionHasChanges("autoRelease", r.changed)).toBe(false);
  });

  it("errors are keyed by field (same rules as the server)", () => {
    const d = draftFromConfig(cur);
    d.fields.warnDays = "10"; // not before cancel (10)
    d.fields.noContactDays = "";
    d.presets.strict.graceDays = "-1"; // below 0
    d.fields.teamRecipients = "info@feldart.com, nope";
    const r = draftToPatch(d, cur);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(
      ["noContactDays", "presets.strict.graceDays", "teamRecipients", "warnDays"].sort(),
    );
    expect(r.errors.noContactDays).toBe("Enter a number");
  });

  it("formats values for display", () => {
    expect(formatSettingValue("overdueThresholdGbp", cur)).toBe("£1,000");
    expect(formatSettingValue("warnDays", cur)).toBe("7 days");
    expect(formatSettingValue("autoReleaseEmailsWarehouse", cur)).toBe("On");
    expect(formatSettingValue("defaultRulePreset", cur)).toBe("Standard — 15 days overdue");
    expect(formatSettingValue("overdueRecipients", { ...cur, overdueRecipients: "" })).toBe("Nobody");
  });

  it("warns about stored templates with literal days only when the days changed", () => {
    expect(ladderTemplateWarning([], { warnDays: 5, cancelDays: 12 })).toBeNull();
    expect(ladderTemplateWarning(["hold_warning"], { warnDays: 7, cancelDays: 10 })).toBeNull();
    const w = ladderTemplateWarning(["hold_warning", "hold_cancel"], { warnDays: 5, cancelDays: 12 });
    expect(w).toMatch(/warning, cancel notice email templates still say/);
    expect(w).toMatch(/day 5 \/ day 12/);
    expect(w).toMatch(/\{\{days_until_cancel\}\}/);
  });

  it("default-rule banner until an admin turns it on", () => {
    expect(defaultRuleBanner(cur)).toBe("Default rule: not set up yet");
    expect(defaultRuleBanner({ defaultRuleEnabled: true })).toBeNull();
  });
});

describe("rule editor follows live preset numbers", () => {
  it("displayNumbers uses the Settings table", () => {
    const t = parsePresetOverrides(JSON.stringify({ standard: { graceDays: 20, minOverdue: 10 } }));
    expect(displayNumbers(NEW_RULE_DRAFT, t)).toEqual({ graceDays: 20, minOverdue: 10 });
    expect(displayNumbers(NEW_RULE_DRAFT)?.graceDays).toBe(15);
  });
});

describe("bulk picker", () => {
  const rows = [
    { id: "a", name: "Alpha Ltd", email: "a@alpha.com", rule: null, defaultScope: true },
    { id: "b", name: "Beta", email: null, rule: { label: "Relaxed — 30 days overdue" }, defaultScope: false },
    { id: "c", name: "Gamma", email: "buyer@gamma.co", rule: null, defaultScope: false },
  ];

  it("search by name or email", () => {
    expect(filterRows(rows, "gamma.co").map((r) => r.id)).toEqual(["c"]);
    expect(filterRows(rows, " ALPHA ").map((r) => r.id)).toEqual(["a"]);
    expect(filterRows(rows, "")).toHaveLength(3);
  });

  it("current rule column", () => {
    expect(currentRuleLabel(rows[0]!, false)).toBe("None (default rule is off)");
    expect(currentRuleLabel(rows[0]!, true)).toBe("Default rule");
    expect(currentRuleLabel(rows[1]!, true)).toBe("Relaxed — 30 days overdue");
    expect(currentRuleLabel(rows[2]!, true)).toBe("None");
  });

  it("tick / tick all visible / untick all", () => {
    let s = toggleId(new Set(), "a");
    expect([...s]).toEqual(["a"]);
    s = toggleAllVisible(s, rows);
    expect(allVisibleTicked(s, rows)).toBe(true);
    s = toggleAllVisible(s, rows);
    expect(s.size).toBe(0);
    // tick-all on a filtered view leaves hidden ticks alone
    s = toggleAllVisible(new Set(["b"]), [rows[0]!]);
    expect([...s].sort()).toEqual(["a", "b"]);
  });

  it("skipped count = ticked customers with a rule, unless overwrite", () => {
    const sel = new Set(["a", "b"]);
    expect(skippedCount(rows, sel, false)).toBe(1);
    expect(skippedCount(rows, sel, true)).toBe(0);
  });

  it("apply summary", () => {
    expect(applySummary({ applied: 3, unchanged: 1, skippedExisting: 2, unknown: 0 })).toBe(
      "Rule set on 3 customers · 1 already had it · 2 skipped (already had a rule). Holds happen on the next orders sync.",
    );
  });
});

describe("promise line", () => {
  it("date + note", () => {
    expect(promiseLine({ payBy: "2026-12-01", note: "wire Friday" })).toBe("Promised to pay by 1 Dec 2026 — wire Friday");
    expect(promiseLine({ payBy: "2026-12-01", note: null })).toBe("Promised to pay by 1 Dec 2026");
  });
});
