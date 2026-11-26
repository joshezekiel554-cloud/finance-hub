// Which rule applies to a customer (PURE).
//
//   1. An explicit customer_hold_rules row ALWAYS wins — including "never".
//   2. Otherwise, when the default rule is switched on in Settings and the
//      customer is in its scope (customer_type 'b2b'), they're treated as if
//      they had a rule with the default preset + DEFAULT_RULE_FLAGS.
//   3. Otherwise: no rule (standard checks only).
//
// Preset numbers always come from the live Settings table (config.presets).

import { DEFAULT_RULE_FLAGS, type HoldsConfig } from "./holds-settings.js";
import type { ResolvedHoldRule } from "./presets.js";

export type RuleSource = "explicit" | "default";
export type EffectiveRule = ResolvedHoldRule & { source: RuleSource };

/** The default rule as a resolved rule, or null when it's switched off. */
export function defaultRuleFor(config: Pick<HoldsConfig, "defaultRuleEnabled" | "defaultRulePreset" | "presets">): EffectiveRule | null {
  if (!config.defaultRuleEnabled) return null;
  return defaultRuleShape(config);
}

/** The default rule's shape regardless of the on/off switch (dry runs, UI). */
export function defaultRuleShape(config: Pick<HoldsConfig, "defaultRulePreset" | "presets">): EffectiveRule {
  return {
    preset: config.defaultRulePreset,
    ...config.presets[config.defaultRulePreset],
    ...DEFAULT_RULE_FLAGS,
    note: null,
    source: "default",
  };
}

/**
 * explicit rows + default-rule candidates → the rule each customer runs on.
 * `defaultCandidateIds` = customers in the default rule's scope (the caller
 * may include ids that also have a row; explicit still wins).
 */
export function buildEffectiveRules(
  explicit: ReadonlyMap<string, ResolvedHoldRule>,
  defaultCandidateIds: readonly string[],
  config: Pick<HoldsConfig, "defaultRuleEnabled" | "defaultRulePreset" | "presets">,
): Map<string, EffectiveRule> {
  const out = new Map<string, EffectiveRule>();
  for (const [id, r] of explicit) out.set(id, { ...r, source: "explicit" });
  const def = defaultRuleFor(config);
  if (def) {
    for (const id of defaultCandidateIds) {
      if (!out.has(id)) out.set(id, { ...def });
    }
  }
  return out;
}
