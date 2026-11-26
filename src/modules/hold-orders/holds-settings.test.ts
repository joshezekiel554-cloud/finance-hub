import { describe, expect, it } from "vitest";
import {
  HOLDS_CONFIG_DEFAULTS,
  HOLDS_SETTING_KEYS,
  diffHoldsConfig,
  invalidEmails,
  lastChangedBySection,
  mergeHoldsConfig,
  parseHoldsConfig,
  parsePresetOverrides,
  serializeHoldsConfig,
} from "./holds-settings.js";
import { PRESET_NUMBERS, describeRule, presetLabel, resolveHoldRule } from "./presets.js";
import { buildEffectiveRules, defaultRuleFor } from "./effective-rules.js";

describe("parseHoldsConfig", () => {
  it("empty settings → today's constants (and the operator's switch defaults)", () => {
    const c = parseHoldsConfig({});
    expect(c).toEqual(HOLDS_CONFIG_DEFAULTS);
    expect(c).toMatchObject({
      holdAlertLookbackDays: 3,
      overdueAlertLookbackDays: 3,
      warnDays: 7,
      cancelDays: 10,
      defaultRuleEnabled: false,
      defaultRulePreset: "standard_30_45",
      defaultRuleScope: "b2b",
      autoReleaseEmailsWarehouse: true,
      ruleHoldsRespectPromise: false,
      ruleOrderLookbackDays: 30,
      overdueWidgetLookbackDays: 30,
      defaultMinBalance: 50,
    });
    expect(c.presets).toEqual(PRESET_NUMBERS);
  });

  it("reads the shared finance keys + new keys", () => {
    const c = parseHoldsConfig({
      order_overdue_threshold_gbp: "2500",
      order_overdue_no_contact_days: "21",
      order_hold_alert_lookback_days: "5",
      order_hold_warn_days: "5",
      order_hold_cancel_days: "12",
      holds_default_rule_enabled: "true",
      holds_default_rule_preset: "vip_90_110",
      holds_auto_release_emails_warehouse: "false",
      holds_rule_holds_respect_promise: "1",
      order_hold_warehouse_recipients: "",
    });
    expect(c).toMatchObject({
      overdueThresholdGbp: 2500,
      noContactDays: 21,
      holdAlertLookbackDays: 5,
      warnDays: 5,
      cancelDays: 12,
      defaultRuleEnabled: true,
      defaultRulePreset: "vip_90_110",
      autoReleaseEmailsWarehouse: false,
      ruleHoldsRespectPromise: true,
      // blank recipient list = nobody, not the default
      warehouseRecipients: "",
    });
  });

  it("garbage / out-of-range values fall back to defaults", () => {
    const c = parseHoldsConfig({
      order_hold_alert_lookback_days: "abc",
      order_overdue_alert_lookback_days: "999",
      holds_default_rule_preset: "never",
      holds_default_rule_scope: "everyone",
      holds_default_rule_enabled: "maybe",
      order_overdue_threshold_gbp: "",
    });
    expect(c).toMatchObject({
      holdAlertLookbackDays: 3,
      overdueAlertLookbackDays: 3,
      defaultRulePreset: "standard_30_45",
      defaultRuleScope: "b2b",
      defaultRuleEnabled: false,
      overdueThresholdGbp: 1000,
    });
  });

  it("a hand-edited warn ≥ cancel pair keeps the ladder ordered", () => {
    const c = parseHoldsConfig({ order_hold_warn_days: "12", order_hold_cancel_days: "10" });
    expect(c.warnDays).toBe(12);
    expect(c.cancelDays).toBe(13);
  });
});

describe("preset overrides", () => {
  it("partial / invalid JSON entries fall back per preset", () => {
    const t = parsePresetOverrides(
      JSON.stringify({
        standard_30_45: { termsDays: 30, holdWhenInvoiceDaysOver: 60, minBalance: 100 },
        vip_90_110: { termsDays: 90, holdWhenInvoiceDaysOver: 50, minBalance: 0 }, // over < terms → ignored
        bogus: { termsDays: 1 },
      }),
    );
    expect(t.standard_30_45).toEqual({ termsDays: 30, holdWhenInvoiceDaysOver: 60, minBalance: 100 });
    expect(t.vip_90_110).toEqual(PRESET_NUMBERS.vip_90_110);
    expect(parsePresetOverrides("not json")).toEqual(PRESET_NUMBERS);
  });

  it("rules on a preset resolve the live table; custom keeps its numbers", () => {
    const table = parsePresetOverrides(JSON.stringify({ standard_30_45: { termsDays: 30, holdWhenInvoiceDaysOver: 50, minBalance: 75 } }));
    const flags = { autoStartLadder: false, autoReleaseOnPayment: true, notifyWarehouse: true };
    const std = resolveHoldRule({ preset: "standard_30_45", ...flags }, table);
    expect(std.ok && std.rule).toMatchObject({ holdWhenInvoiceDaysOver: 50, minBalance: 75 });
    const custom = resolveHoldRule({ preset: "custom", termsDays: 10, holdWhenInvoiceDaysOver: 20, ...flags }, table, 300);
    expect(custom.ok && custom.rule).toMatchObject({ termsDays: 10, holdWhenInvoiceDaysOver: 20, minBalance: 300 });
  });

  it("labels reflect the edited numbers", () => {
    const table = parsePresetOverrides(JSON.stringify({ standard_30_45: { termsDays: 30, holdWhenInvoiceDaysOver: 50, minBalance: 50 } }));
    expect(presetLabel("standard_30_45", table)).toBe("Standard 30/50");
    expect(presetLabel("standard_30_45")).toBe("Standard 30/45");
    expect(presetLabel("strict")).toBe("Strict (hold when past due)");
    expect(presetLabel("never", table)).toBe("Never hold automatically");
    expect(describeRule({ preset: "vip_90_110", termsDays: 90, holdWhenInvoiceDaysOver: 120, minBalance: 50 })).toBe("VIP 90/120");
  });
});

describe("mergeHoldsConfig (PATCH validation)", () => {
  const cur = HOLDS_CONFIG_DEFAULTS;
  it("accepts a valid partial patch", () => {
    const r = mergeHoldsConfig(cur, { warnDays: 5, defaultRuleEnabled: true });
    expect(r.ok && r.config).toMatchObject({ warnDays: 5, cancelDays: 10, defaultRuleEnabled: true });
  });
  it("merges a single preset into the table", () => {
    const r = mergeHoldsConfig(cur, { presets: { strict: { termsDays: 14, holdWhenInvoiceDaysOver: 20, minBalance: 0 } } });
    expect(r.ok && r.config.presets.strict).toEqual({ termsDays: 14, holdWhenInvoiceDaysOver: 20, minBalance: 0 });
    expect(r.ok && r.config.presets.vip_90_110).toEqual(PRESET_NUMBERS.vip_90_110);
  });
  it.each([
    [{ warnDays: 10 }, "warnDays"],
    [{ cancelDays: 61 }, "cancelDays"],
    [{ warnDays: 0 }, "warnDays"],
    [{ holdAlertLookbackDays: 31 }, "holdAlertLookbackDays"],
    [{ overdueThresholdGbp: -1 }, "overdueThresholdGbp"],
    [{ noContactDays: 1.5 }, "noContactDays"],
    [{ overdueRecipients: "a@x.com, not-an-email" }, "overdueRecipients"],
    [{ presets: { vip_90_110: { termsDays: 90, holdWhenInvoiceDaysOver: 80, minBalance: 0 } } }, "presets.vip_90_110.holdWhenInvoiceDaysOver"],
    [{ defaultRulePreset: "never" }, "defaultRulePreset"],
    [{ defaultRuleScope: "all" }, "defaultRuleScope"],
    [{ unknownKey: 1 }, ""],
  ])("rejects %j", (patch, field) => {
    const r = mergeHoldsConfig(cur, patch);
    expect(r.ok).toBe(false);
    if (!r.ok && field) expect(r.errors.map((e) => e.field)).toContain(field);
  });
  it("email list helper", () => {
    expect(invalidEmails("a@x.com, b@y.co.uk,,")).toEqual([]);
    expect(invalidEmails("a@x.com, nope")).toEqual(["nope"]);
  });
});

describe("serialize / diff", () => {
  it("round-trips", () => {
    const r = mergeHoldsConfig(HOLDS_CONFIG_DEFAULTS, { warnDays: 4, defaultRuleEnabled: true, presets: { strict: { termsDays: 7, holdWhenInvoiceDaysOver: 7, minBalance: 0 } } });
    if (!r.ok) throw new Error("bad");
    expect(parseHoldsConfig(serializeHoldsConfig(r.config))).toEqual(r.config);
  });
  it("diff lists only changed keys, before→after as stored strings", () => {
    const r = mergeHoldsConfig(HOLDS_CONFIG_DEFAULTS, { warnDays: 4, ruleHoldsRespectPromise: true });
    if (!r.ok) throw new Error("bad");
    expect(diffHoldsConfig(HOLDS_CONFIG_DEFAULTS, r.config)).toEqual([
      { key: HOLDS_SETTING_KEYS.warnDays, field: "warnDays", before: "7", after: "4" },
      { key: HOLDS_SETTING_KEYS.ruleHoldsRespectPromise, field: "ruleHoldsRespectPromise", before: "false", after: "true" },
    ]);
    expect(diffHoldsConfig(HOLDS_CONFIG_DEFAULTS, HOLDS_CONFIG_DEFAULTS)).toEqual([]);
  });
});

describe("lastChangedBySection", () => {
  it("newest row per section wins", () => {
    const out = lastChangedBySection([
      { at: "2026-11-01T00:00:00Z", by: "Shaya", keys: ["order_hold_warn_days"] },
      { at: "2026-11-20T00:00:00Z", by: "Josh", keys: ["order_hold_cancel_days", "holds_preset_overrides"] },
      { at: "2026-11-10T00:00:00Z", by: "Finance page", keys: ["order_overdue_threshold_gbp"] },
    ]);
    expect(out.ladder).toEqual({ at: "2026-11-20T00:00:00Z", by: "Josh" });
    expect(out.presets?.by).toBe("Josh");
    expect(out.standard?.by).toBe("Finance page");
    expect(out.autoRelease).toBeNull();
  });
});

describe("effective rules (default b2b rule)", () => {
  const explicitVip = new Map([
    ["c-vip", { preset: "vip_90_110" as const, termsDays: 90, holdWhenInvoiceDaysOver: 110, minBalance: 50, autoStartLadder: true, autoReleaseOnPayment: true, notifyWarehouse: false, note: null }],
    ["c-never", { preset: "never" as const, termsDays: 0, holdWhenInvoiceDaysOver: 0, minBalance: 0, autoStartLadder: false, autoReleaseOnPayment: true, notifyWarehouse: false, note: null }],
  ]);

  it("off → only explicit rules", () => {
    const m = buildEffectiveRules(explicitVip, ["c-b2b", "c-never"], HOLDS_CONFIG_DEFAULTS);
    expect([...m.keys()].sort()).toEqual(["c-never", "c-vip"]);
    expect(defaultRuleFor(HOLDS_CONFIG_DEFAULTS)).toBeNull();
  });

  it("on → rule-less b2b customers get the default preset (live numbers); explicit rows, incl. never, win", () => {
    const cfg = { ...HOLDS_CONFIG_DEFAULTS, defaultRuleEnabled: true, defaultRulePreset: "extended_60_75" as const };
    cfg.presets = { ...cfg.presets, extended_60_75: { termsDays: 60, holdWhenInvoiceDaysOver: 80, minBalance: 10 } };
    const m = buildEffectiveRules(explicitVip, ["c-b2b", "c-never"], cfg);
    expect(m.get("c-b2b")).toMatchObject({
      source: "default",
      preset: "extended_60_75",
      holdWhenInvoiceDaysOver: 80,
      notifyWarehouse: true,
      autoStartLadder: false,
      autoReleaseOnPayment: true,
    });
    expect(m.get("c-never")).toMatchObject({ preset: "never", source: "explicit" });
    expect(m.get("c-vip")?.source).toBe("explicit");
    expect(describeRule(m.get("c-b2b")!)).toBe("Default b2b rule (Extended 60/80)");
  });
});
