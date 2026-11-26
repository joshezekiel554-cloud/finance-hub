// Bulk customer-rule picker (Hold Orders → Customer rules → Select customers).
//
//   candidates  — customer rows from a source (Shopify b2b tag, finance
//                 type b2b, no rule yet, on preset X), each with its current
//                 rule so the picker can show "VIP 90/110" / "default" / none
//   preview     — DRY RUN of one rule over the picked customers (no writes)
//   apply       — upsert that rule for the picked customers; customers that
//                 already have a rule are skipped unless overwrite. One
//                 audit_log row per customer actually changed (entity
//                 customer_hold_rule). NO email at apply time: holds + emails
//                 only ever come from the normal detection run
//                 (claim-then-send), same as a single rule save.

import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { customerHoldRules } from "../../db/schema/hold-rules.js";
import { auditLog } from "../../db/schema/audit.js";
import { describeRule, HOLD_RULE_PRESETS, type HoldRulePreset, type ResolvedHoldRule } from "./presets.js";
import { rowToRule, ruleRowValues } from "./rules-store.js";
import { planRuleHolds } from "./detection.js";
import { inDefaultRuleScope } from "./effective-rules.js";
import type { HoldsConfig } from "./holds-settings.js";

export const BULK_MAX_IDS = 1000;
const CANDIDATE_MAX = 3000;

export const CANDIDATE_SOURCES = ["shopify_b2b", "finance_b2b", "no_rule", "preset"] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

export type CandidateRow = {
  id: string;
  name: string;
  email: string | null;
  customerType: string | null;
  holdStatus: string | null;
  balance: string | null;
  overdueBalance: string | null;
  // customers.payment_terms (finance-owned, read-only here), e.g. "Net 60".
  paymentTerms: string | null;
  // Explicit rule, if any.
  rule: { preset: HoldRulePreset; label: string; graceDays: number } | null;
  // No explicit rule, in the default rule's scope (b2b). Whether that
  // default is actually ON is in the settings payload.
  defaultScope: boolean;
};

export async function loadCandidateRows(
  where: SQL | undefined,
  config: Pick<HoldsConfig, "presets">,
): Promise<CandidateRow[]> {
  const rows = await db
    .select({
      id: customers.id,
      name: customers.displayName,
      email: customers.primaryEmail,
      customerType: customers.customerType,
      holdStatus: customers.holdStatus,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
      paymentTerms: customers.paymentTerms,
      rule: customerHoldRules,
    })
    .from(customers)
    .leftJoin(customerHoldRules, eq(customerHoldRules.customerId, customers.id))
    .where(where)
    .orderBy(customers.displayName)
    .limit(CANDIDATE_MAX);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    customerType: r.customerType,
    holdStatus: r.holdStatus,
    balance: r.balance,
    overdueBalance: r.overdueBalance,
    paymentTerms: r.paymentTerms,
    rule: r.rule
      ? (() => {
          const resolved = rowToRule(r.rule, config.presets);
          return { preset: r.rule.preset, label: describeRule(resolved), graceDays: resolved.graceDays };
        })()
      : null,
    defaultScope: !r.rule && inDefaultRuleScope(r),
  }));
}

/**
 * WHERE for a non-Shopify source. "no_rule" is b2b customers only unless
 * `allTypes` (the picker's "include all customer types" toggle).
 */
export function candidateWhere(
  source: Exclude<CandidateSource, "shopify_b2b">,
  preset?: HoldRulePreset,
  allTypes = false,
): SQL | undefined {
  switch (source) {
    case "finance_b2b":
      return eq(customers.customerType, "b2b");
    case "no_rule":
      return allTypes
        ? isNull(customerHoldRules.customerId)
        : and(isNull(customerHoldRules.customerId), eq(customers.customerType, "b2b"));
    case "preset":
      return eq(customerHoldRules.preset, preset && HOLD_RULE_PRESETS.includes(preset) ? preset : "standard");
  }
}

/** Candidate rows for an explicit id list (Shopify-matched customers). */
export async function loadCandidateRowsByIds(ids: readonly string[], config: Pick<HoldsConfig, "presets">): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];
  for (let i = 0; i < ids.length && out.length < CANDIDATE_MAX; i += 1000) {
    out.push(...(await loadCandidateRows(inArray(customers.id, ids.slice(i, i + 1000)), config)));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type BulkTargets = {
  // Customers the rule would be written to.
  targets: string[];
  // Already had a rule, overwrite off.
  skippedExisting: string[];
  // Ids that aren't finance customers.
  unknown: string[];
  existing: Map<string, ResolvedHoldRule>;
  names: Map<string, string>;
};

/** PURE: who gets the rule. */
export function splitBulkTargets(
  ids: readonly string[],
  known: ReadonlySet<string>,
  existing: ReadonlyMap<string, unknown>,
  overwrite: boolean,
): { targets: string[]; skippedExisting: string[]; unknown: string[] } {
  const seen = new Set<string>();
  const targets: string[] = [];
  const skippedExisting: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!known.has(id)) unknown.push(id);
    else if (existing.has(id) && !overwrite) skippedExisting.push(id);
    else targets.push(id);
  }
  return { targets, skippedExisting, unknown };
}

export async function resolveBulkTargets(ids: readonly string[], overwrite: boolean): Promise<BulkTargets> {
  const uniq = Array.from(new Set(ids));
  if (uniq.length === 0) {
    return { targets: [], skippedExisting: [], unknown: [], existing: new Map(), names: new Map() };
  }
  const [custRows, ruleRows] = await Promise.all([
    db.select({ id: customers.id, name: customers.displayName }).from(customers).where(inArray(customers.id, uniq)),
    db.select().from(customerHoldRules).where(inArray(customerHoldRules.customerId, uniq)),
  ]);
  const existing = new Map(ruleRows.map((r) => [r.customerId, rowToRule(r)]));
  const names = new Map(custRows.map((c) => [c.id, c.name]));
  const split = splitBulkTargets(uniq, new Set(names.keys()), existing, overwrite);
  return { ...split, existing, names };
}

export type BulkPreview = {
  targets: number;
  skippedExisting: number;
  unknown: number;
  orderCount: number;
  customersHit: number;
  orders: Array<{ orderId: string; orderNumber: string | null; customerName: string | null; total: string | null; why: string }>;
};

export const BULK_PREVIEW_LIST_MAX = 100;

export async function previewBulkRule(args: {
  ids: readonly string[];
  rule: ResolvedHoldRule;
  overwrite: boolean;
  config: HoldsConfig;
  now?: Date;
}): Promise<BulkPreview> {
  const t = await resolveBulkTargets(args.ids, args.overwrite);
  const plan = await planRuleHolds(new Map(t.targets.map((id) => [id, args.rule])), args.config, args.now ?? new Date());
  return {
    targets: t.targets.length,
    skippedExisting: t.skippedExisting.length,
    unknown: t.unknown.length,
    orderCount: plan.planned.length,
    customersHit: new Set(plan.planned.map((p) => p.customerId)).size,
    orders: plan.planned.slice(0, BULK_PREVIEW_LIST_MAX).map((p) => ({
      orderId: p.orderId,
      orderNumber: p.orderNumber,
      customerName: p.customerName,
      total: p.total,
      why: p.why,
    })),
  };
}

function sameRule(a: ResolvedHoldRule, b: ResolvedHoldRule): boolean {
  return (
    a.preset === b.preset &&
    a.graceDays === b.graceDays &&
    a.minOverdue === b.minOverdue &&
    a.autoStartLadder === b.autoStartLadder &&
    a.autoReleaseOnPayment === b.autoReleaseOnPayment &&
    a.notifyWarehouse === b.notifyWarehouse &&
    (a.note ?? null) === (b.note ?? null)
  );
}

export type BulkApplyResult = {
  applied: number;
  unchanged: number;
  skippedExisting: number;
  unknown: number;
};

export async function applyBulkRule(args: {
  ids: readonly string[];
  rule: ResolvedHoldRule;
  overwrite: boolean;
  userId: string | null;
  actorEmail: string | null;
}): Promise<BulkApplyResult> {
  const t = await resolveBulkTargets(args.ids, args.overwrite);
  const changed = t.targets.filter((id) => {
    const before = t.existing.get(id);
    return !before || !sameRule(before, args.rule);
  });
  const values = ruleRowValues(args.rule, args.userId);
  for (let i = 0; i < changed.length; i += 200) {
    const chunk = changed.slice(i, i + 200);
    await db
      .insert(customerHoldRules)
      .values(chunk.map((customerId) => ({ customerId, ...values })))
      .onDuplicateKeyUpdate({ set: values });
    await db.insert(auditLog).values(
      chunk.map((customerId) => {
        const before = t.existing.get(customerId);
        return {
          id: nanoid(24),
          userId: args.userId,
          action: before ? "customer_hold_rule.updated" : "customer_hold_rule.created",
          entityType: "customer_hold_rule",
          entityId: customerId,
          before: before ? { ...before, customerId, customerName: t.names.get(customerId) ?? null } : {},
          after: { ...args.rule, actorEmail: args.actorEmail, via: "bulk" },
        };
      }),
    );
  }
  return {
    applied: changed.length,
    unchanged: t.targets.length - changed.length,
    skippedExisting: t.skippedExisting.length,
    unknown: t.unknown.length,
  };
}
