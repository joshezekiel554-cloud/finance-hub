// Customer hold rules — persistence + data loading for the rules engine.
// Every write is audit-logged (entity "customer_hold_rule", before/after).

import { and, eq, gt, gte, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customerHoldRules, type CustomerHoldRule } from "../../db/schema/hold-rules.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { orders } from "../../db/schema/catalog.js";
import { auditLog } from "../../db/schema/audit.js";
import { isNumberedPreset, type PresetTable, type ResolvedHoldRule } from "./presets.js";
import { parseTermsDays } from "./terms.js";
import { buildEffectiveRules, type EffectiveRule } from "./effective-rules.js";
import { HOLDS_CONFIG_DEFAULTS, type HoldsConfig } from "./holds-settings.js";
import {
  evaluateCustomerRule,
  ordersRuleWouldHold,
  type RuleEvaluation,
  type RuleInvoice,
  type RuleOrder,
} from "./rule-engine.js";

// Default window for open orders a rule looks at (same window as the
// dashboard hold widgets). Older still-unfulfilled orders are almost always
// stale Shopify records, not parcels waiting at the warehouse. Live value:
// Settings → holds_rule_order_lookback_days.
export const RULE_ORDER_LOOKBACK_DAYS = HOLDS_CONFIG_DEFAULTS.ruleOrderLookbackDays;

/**
 * Row → rule. With `presets` (the live Settings table), a preset row takes
 * the CURRENT preset numbers rather than the snapshot stored on the row, so
 * editing a preset moves every customer on it. Custom/never rows keep theirs.
 */
export function rowToRule(row: CustomerHoldRule, presets?: PresetTable): ResolvedHoldRule {
  const live = presets && isNumberedPreset(row.preset) ? presets[row.preset] : null;
  return {
    preset: row.preset,
    graceDays: live ? live.graceDays : row.graceDays,
    minOverdue: live ? live.minOverdue : Number(row.minOverdue),
    autoStartLadder: row.autoStartLadder,
    autoReleaseOnPayment: row.autoReleaseOnPayment,
    notifyWarehouse: row.notifyWarehouse,
    note: row.note,
  };
}

export type StoredRule = ResolvedHoldRule & {
  customerId: string;
  customerName: string | null;
  // Read-only customer context for the rules list / editor header.
  paymentTerms: string | null;
  balance: string | null;
  overdueBalance: string | null;
  setByUserId: string | null;
  setAt: string;
  updatedAt: string;
};

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

export async function getRule(customerId: string, presets?: PresetTable): Promise<StoredRule | null> {
  const rows = await db
    .select({
      rule: customerHoldRules,
      customerName: customers.displayName,
      paymentTerms: customers.paymentTerms,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
    })
    .from(customerHoldRules)
    .leftJoin(customers, eq(customers.id, customerHoldRules.customerId))
    .where(eq(customerHoldRules.customerId, customerId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...rowToRule(r.rule, presets),
    customerId: r.rule.customerId,
    customerName: r.customerName,
    paymentTerms: r.paymentTerms ?? null,
    balance: r.balance ?? null,
    overdueBalance: r.overdueBalance ?? null,
    setByUserId: r.rule.setByUserId,
    setAt: iso(r.rule.setAt),
    updatedAt: iso(r.rule.updatedAt),
  };
}

export async function listRules(presets?: PresetTable): Promise<StoredRule[]> {
  const rows = await db
    .select({
      rule: customerHoldRules,
      customerName: customers.displayName,
      paymentTerms: customers.paymentTerms,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
    })
    .from(customerHoldRules)
    .leftJoin(customers, eq(customers.id, customerHoldRules.customerId))
    .limit(5000);
  return rows
    .map((r) => ({
      ...rowToRule(r.rule, presets),
      customerId: r.rule.customerId,
      customerName: r.customerName,
      paymentTerms: r.paymentTerms ?? null,
      balance: r.balance ?? null,
      overdueBalance: r.overdueBalance ?? null,
      setByUserId: r.rule.setByUserId,
      setAt: iso(r.rule.setAt),
      updatedAt: iso(r.rule.updatedAt),
    }))
    .sort((a, b) => (a.customerName ?? "").localeCompare(b.customerName ?? ""));
}

/** Explicit rules for a set of customers (or all), resolved on `presets`. */
export async function loadRulesFor(
  customerIds?: readonly string[],
  presets?: PresetTable,
): Promise<Map<string, ResolvedHoldRule>> {
  if (customerIds && customerIds.length === 0) return new Map();
  const rows = customerIds
    ? await db
        .select()
        .from(customerHoldRules)
        .where(inArray(customerHoldRules.customerId, [...customerIds]))
    : await db.select().from(customerHoldRules).limit(5000);
  return new Map(rows.map((r) => [r.customerId, rowToRule(r, presets)]));
}

/**
 * Customers in the default rule's scope that have NO explicit row: scope
 * "b2b" = customer_type 'b2b' AND hold_status 'active' (on-hold / prepay
 * accounts are the standard pass's job — see inDefaultRuleScope in
 * effective-rules.ts, which this mirrors). Optionally limited to `customerIds`.
 */
export async function loadDefaultRuleCustomerIds(customerIds?: readonly string[]): Promise<string[]> {
  if (customerIds && customerIds.length === 0) return [];
  const conds = [
    eq(customers.customerType, "b2b"),
    eq(customers.holdStatus, "active"),
    isNull(customerHoldRules.customerId),
  ];
  if (customerIds) conds.push(inArray(customers.id, [...customerIds]));
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .leftJoin(customerHoldRules, eq(customerHoldRules.customerId, customers.id))
    .where(and(...conds))
    .limit(5000);
  return rows.map((r) => r.id);
}

/**
 * The rule every customer actually runs on today: explicit rows (live preset
 * numbers) + the default b2b rule when it's switched on. See
 * effective-rules.ts for precedence.
 */
export async function loadEffectiveRules(
  config: HoldsConfig,
  customerIds?: readonly string[],
): Promise<Map<string, EffectiveRule>> {
  const explicit = await loadRulesFor(customerIds, config.presets);
  const defaultIds = config.defaultRuleEnabled ? await loadDefaultRuleCustomerIds(customerIds) : [];
  return buildEffectiveRules(explicit, defaultIds, config);
}

/** Column values for an upsert (shared by single + bulk writes). */
export function ruleRowValues(rule: ResolvedHoldRule, userId: string | null) {
  return {
    preset: rule.preset,
    graceDays: rule.graceDays,
    minOverdue: rule.minOverdue.toFixed(2),
    autoStartLadder: rule.autoStartLadder,
    autoReleaseOnPayment: rule.autoReleaseOnPayment,
    notifyWarehouse: rule.notifyWarehouse,
    note: rule.note,
    setByUserId: userId,
    setAt: new Date(),
  };
}

export async function upsertRule(args: {
  customerId: string;
  rule: ResolvedHoldRule;
  userId: string | null;
  actorEmail: string | null;
  via?: string;
}): Promise<{ ok: true } | { ok: false; reason: "customer_not_found" }> {
  const cust = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, args.customerId))
    .limit(1);
  if (!cust[0]) return { ok: false, reason: "customer_not_found" };

  const before = await getRule(args.customerId);
  const values = ruleRowValues(args.rule, args.userId);
  await db
    .insert(customerHoldRules)
    .values({ customerId: args.customerId, ...values })
    .onDuplicateKeyUpdate({ set: values });
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId: args.userId,
    action: before ? "customer_hold_rule.updated" : "customer_hold_rule.created",
    entityType: "customer_hold_rule",
    entityId: args.customerId,
    before: before ? { ...before } : {},
    after: { ...args.rule, actorEmail: args.actorEmail, ...(args.via ? { via: args.via } : {}) },
  });
  return { ok: true };
}

export async function deleteRule(args: {
  customerId: string;
  userId: string | null;
  actorEmail: string | null;
}): Promise<{ ok: true; existed: boolean }> {
  const before = await getRule(args.customerId);
  if (!before) return { ok: true, existed: false };
  await db.delete(customerHoldRules).where(eq(customerHoldRules.customerId, args.customerId));
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId: args.userId,
    action: "customer_hold_rule.deleted",
    entityType: "customer_hold_rule",
    entityId: args.customerId,
    before: { ...before },
    after: { deleted: true, actorEmail: args.actorEmail },
  });
  return { ok: true, existed: true };
}

/** Open-balance invoices per customer (filtering beyond balance>0 is the engine's). */
export async function loadOpenInvoices(
  customerIds: readonly string[],
): Promise<Map<string, RuleInvoice[]>> {
  const out = new Map<string, RuleInvoice[]>();
  if (customerIds.length === 0) return out;
  for (let i = 0; i < customerIds.length; i += 1000) {
    const chunk = customerIds.slice(i, i + 1000);
    const rows = await db
      .select({
        customerId: invoices.customerId,
        docNumber: invoices.docNumber,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        balance: invoices.balance,
        status: invoices.status,
        origin: invoices.origin,
        disputeState: invoices.disputeState,
      })
      .from(invoices)
      .where(and(inArray(invoices.customerId, [...chunk]), gt(invoices.balance, "0")));
    for (const r of rows) {
      const list = out.get(r.customerId) ?? [];
      list.push({
        docNumber: r.docNumber,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        balance: r.balance,
        status: r.status,
        origin: r.origin,
        disputeState: r.disputeState,
      });
      out.set(r.customerId, list);
    }
  }
  return out;
}

export type CustomerTerms = { days: number | null; label: string | null };

/** customers.payment_terms per customer (finance-owned; pushed to QBO). */
export async function loadCustomerTerms(customerIds: readonly string[]): Promise<Map<string, CustomerTerms>> {
  const out = new Map<string, CustomerTerms>();
  for (let i = 0; i < customerIds.length; i += 1000) {
    const chunk = customerIds.slice(i, i + 1000);
    const rows = await db
      .select({ id: customers.id, terms: customers.paymentTerms })
      .from(customers)
      .where(inArray(customers.id, [...chunk]));
    for (const r of rows) out.set(r.id, { days: parseTermsDays(r.terms), label: r.terms?.trim() || null });
  }
  return out;
}

export type CustomerContext = {
  paymentTerms: string | null;
  balance: string | null;
  overdueBalance: string | null;
};

/** Read-only customer facts for the rule editor header. */
export async function loadCustomerContext(customerId: string): Promise<CustomerContext | null> {
  const rows = await db
    .select({ paymentTerms: customers.paymentTerms, balance: customers.balance, overdueBalance: customers.overdueBalance })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return rows[0] ?? null;
}

export type CandidateOrder = RuleOrder & {
  customerId: string;
  shopifyOrderId: string;
  orderDate: Date | null;
};

/** Recent, uncancelled orders per customer (any hold state — the engine filters). */
export async function loadCandidateOrders(
  customerIds: readonly string[],
  now: Date = new Date(),
  lookbackDays: number = RULE_ORDER_LOOKBACK_DAYS,
): Promise<Map<string, CandidateOrder[]>> {
  const out = new Map<string, CandidateOrder[]>();
  if (customerIds.length === 0) return out;
  const cutoff = new Date(now.getTime() - lookbackDays * 86_400_000);
  for (let i = 0; i < customerIds.length; i += 1000) {
    const chunk = customerIds.slice(i, i + 1000);
    const rows = await db
      .select({
        orderId: orders.id,
        customerId: orders.customerId,
        orderNumber: orders.orderNumber,
        shopifyOrderId: orders.shopifyOrderId,
        total: orders.total,
        holdState: orders.holdState,
        cancelledAt: orders.cancelledAt,
        fulfillmentStatus: orders.fulfillmentStatus,
        shipmentStatus: orders.shipmentStatus,
        orderDate: orders.orderDate,
      })
      .from(orders)
      .where(
        and(
          inArray(orders.customerId, [...chunk]),
          isNull(orders.cancelledAt),
          gte(orders.orderDate, cutoff),
        ),
      );
    for (const r of rows) {
      if (!r.customerId) continue;
      const list = out.get(r.customerId) ?? [];
      list.push({ ...r, customerId: r.customerId });
      out.set(r.customerId, list);
    }
  }
  return out;
}

export type RulePreview = {
  evaluation: RuleEvaluation;
  orders: Array<{ orderId: string; orderNumber: string | null; total: string | null }>;
};

/** "Would hold these N orders today" for an (unsaved) rule on one customer. */
export async function previewRule(
  customerId: string,
  rule: ResolvedHoldRule,
  now: Date = new Date(),
  lookbackDays: number = RULE_ORDER_LOOKBACK_DAYS,
): Promise<RulePreview> {
  const [inv, ord, terms] = await Promise.all([
    loadOpenInvoices([customerId]),
    loadCandidateOrders([customerId], now, lookbackDays),
    loadCustomerTerms([customerId]),
  ]);
  const evaluation = evaluateCustomerRule(rule, inv.get(customerId) ?? [], now, terms.get(customerId));
  const hit = ordersRuleWouldHold(evaluation, ord.get(customerId) ?? []);
  return {
    evaluation,
    orders: hit.map((o) => ({ orderId: o.orderId, orderNumber: o.orderNumber, total: o.total })),
  };
}
