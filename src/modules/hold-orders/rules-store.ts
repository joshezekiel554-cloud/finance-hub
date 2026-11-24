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
import type { ResolvedHoldRule } from "./presets.js";
import {
  evaluateCustomerRule,
  ordersRuleWouldHold,
  type RuleEvaluation,
  type RuleInvoice,
  type RuleOrder,
} from "./rule-engine.js";

// Rules look at open orders from this far back (same window as the
// dashboard hold widgets). Older still-unfulfilled orders are almost always
// stale Shopify records, not parcels waiting at the warehouse.
export const RULE_ORDER_LOOKBACK_DAYS = 30;

export function rowToRule(row: CustomerHoldRule): ResolvedHoldRule {
  return {
    preset: row.preset,
    termsDays: row.termsDays,
    holdWhenInvoiceDaysOver: row.holdWhenInvoiceDaysOver,
    minBalance: Number(row.minBalance),
    autoStartLadder: row.autoStartLadder,
    autoReleaseOnPayment: row.autoReleaseOnPayment,
    notifyWarehouse: row.notifyWarehouse,
    note: row.note,
  };
}

export type StoredRule = ResolvedHoldRule & {
  customerId: string;
  customerName: string | null;
  setByUserId: string | null;
  setAt: string;
  updatedAt: string;
};

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

export async function getRule(customerId: string): Promise<StoredRule | null> {
  const rows = await db
    .select({ rule: customerHoldRules, customerName: customers.displayName })
    .from(customerHoldRules)
    .leftJoin(customers, eq(customers.id, customerHoldRules.customerId))
    .where(eq(customerHoldRules.customerId, customerId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...rowToRule(r.rule),
    customerId: r.rule.customerId,
    customerName: r.customerName,
    setByUserId: r.rule.setByUserId,
    setAt: iso(r.rule.setAt),
    updatedAt: iso(r.rule.updatedAt),
  };
}

export async function listRules(): Promise<StoredRule[]> {
  const rows = await db
    .select({ rule: customerHoldRules, customerName: customers.displayName })
    .from(customerHoldRules)
    .leftJoin(customers, eq(customers.id, customerHoldRules.customerId))
    .limit(2000);
  return rows
    .map((r) => ({
      ...rowToRule(r.rule),
      customerId: r.rule.customerId,
      customerName: r.customerName,
      setByUserId: r.rule.setByUserId,
      setAt: iso(r.rule.setAt),
      updatedAt: iso(r.rule.updatedAt),
    }))
    .sort((a, b) => (a.customerName ?? "").localeCompare(b.customerName ?? ""));
}

/** Rules for a set of customers (the detection job / board / auto-release). */
export async function loadRulesFor(
  customerIds?: readonly string[],
): Promise<Map<string, ResolvedHoldRule>> {
  if (customerIds && customerIds.length === 0) return new Map();
  const rows = customerIds
    ? await db
        .select()
        .from(customerHoldRules)
        .where(inArray(customerHoldRules.customerId, [...customerIds]))
    : await db.select().from(customerHoldRules).limit(5000);
  return new Map(rows.map((r) => [r.customerId, rowToRule(r)]));
}

export async function upsertRule(args: {
  customerId: string;
  rule: ResolvedHoldRule;
  userId: string | null;
  actorEmail: string | null;
}): Promise<{ ok: true } | { ok: false; reason: "customer_not_found" }> {
  const cust = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, args.customerId))
    .limit(1);
  if (!cust[0]) return { ok: false, reason: "customer_not_found" };

  const before = await getRule(args.customerId);
  const values = {
    preset: args.rule.preset,
    termsDays: args.rule.termsDays,
    holdWhenInvoiceDaysOver: args.rule.holdWhenInvoiceDaysOver,
    minBalance: args.rule.minBalance.toFixed(2),
    autoStartLadder: args.rule.autoStartLadder,
    autoReleaseOnPayment: args.rule.autoReleaseOnPayment,
    notifyWarehouse: args.rule.notifyWarehouse,
    note: args.rule.note,
    setByUserId: args.userId,
    setAt: new Date(),
  };
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
    after: { ...args.rule, actorEmail: args.actorEmail },
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
    .where(and(inArray(invoices.customerId, [...customerIds]), gt(invoices.balance, "0")));
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
  return out;
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
): Promise<Map<string, CandidateOrder[]>> {
  const out = new Map<string, CandidateOrder[]>();
  if (customerIds.length === 0) return out;
  const cutoff = new Date(now.getTime() - RULE_ORDER_LOOKBACK_DAYS * 86_400_000);
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
        inArray(orders.customerId, [...customerIds]),
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
): Promise<RulePreview> {
  const [inv, ord] = await Promise.all([
    loadOpenInvoices([customerId]),
    loadCandidateOrders([customerId], now),
  ]);
  const evaluation = evaluateCustomerRule(rule, inv.get(customerId) ?? [], now);
  const hit = ordersRuleWouldHold(evaluation, ord.get(customerId) ?? []);
  return {
    evaluation,
    orders: hit.map((o) => ({ orderId: o.orderId, orderNumber: o.orderNumber, total: o.total })),
  };
}
