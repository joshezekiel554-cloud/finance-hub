// Customer-rule hold detection — runs in orders-sync right after today's
// standard detection (runOrderHoldAlerts). Evaluates every customer with an
// EXPLICIT rule, plus — only when an admin has switched it on in Settings —
// the b2b customers without a row (the default rule; see effective-rules.ts).
// Everyone else keeps the standard behaviour unchanged.
//
// For each rule customer whose rule would hold them today, every open,
// never-held order (holdState "none", unshipped, uncancelled, inside the
// Settings order window) goes on_hold with holdReason "customer_rule" and the
// why-line in holdNote (rule snapshot also in the audit row). Per rule:
//   notify_warehouse  → send the standard warehouse hold_alert email
//   auto_start_ladder → enter the Day-0/7/10 customer ladder
// Released orders are never re-held by a rule (see ordersRuleWouldHold).
//
// planRuleHolds() is the DRY-RUN half (no writes, no email) — the Settings
// preview and the bulk rule preview call it with draft config/rules.

import { and, eq, inArray } from "drizzle-orm";
import { affectedRows } from "./claim.js";
import { isPromiseActive } from "../promises/promise-state.js";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { loadAppSettings } from "../statements/settings.js";
import { recordHoldTransition } from "../orders/hold-alerts.js";
import { planHoldAlertEmail, sendPlannedEmail } from "../orders/hold-email-plan.js";
import { loadCandidateOrders, loadEffectiveRules, loadOpenInvoices } from "./rules-store.js";
import { evaluateCustomerRule, ordersRuleWouldHold, type RuleHit } from "./rule-engine.js";
import { parseHoldsConfig, type HoldsConfig } from "./holds-settings.js";
import type { ResolvedHoldRule } from "./presets.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "hold-orders.detection" });

export type RunCustomerRuleHoldsResult = {
  ruleCustomers: number;
  held: number;
  alerted: number;
};

export type PlannedRuleHold = {
  orderId: string;
  orderNumber: string | null;
  shopifyOrderId: string;
  total: string | null;
  holdState: string | null;
  customerId: string;
  customerName: string | null;
  why: string;
  rule: ResolvedHoldRule;
  hits: RuleHit[];
};

export type RuleHoldPlan = {
  ruleCustomers: number;
  planned: PlannedRuleHold[];
  // Customers skipped only because of an active promise (H9 on).
  skippedForPromise: number;
};

/**
 * DRY RUN: which orders would `rules` hold right now under `config`? Reads
 * only. `rules` is customerId → rule ("never" entries are ignored).
 */
export async function planRuleHolds(
  rules: ReadonlyMap<string, ResolvedHoldRule>,
  config: Pick<HoldsConfig, "ruleOrderLookbackDays" | "ruleHoldsRespectPromise">,
  now: Date = new Date(),
): Promise<RuleHoldPlan> {
  const active = [...rules.entries()].filter(([, r]) => r.preset !== "never");
  const plan: RuleHoldPlan = { ruleCustomers: active.length, planned: [], skippedForPromise: 0 };
  if (active.length === 0) return plan;

  const ids = active.map(([id]) => id);
  const custRows: Array<{ id: string; name: string | null; promisedPayBy: string | null }> = [];
  for (let i = 0; i < ids.length; i += 1000) {
    custRows.push(
      ...(await db
        .select({ id: customers.id, name: customers.displayName, promisedPayBy: customers.promisedPayBy })
        .from(customers)
        .where(inArray(customers.id, ids.slice(i, i + 1000)))),
    );
  }
  const [invoicesBy, ordersBy] = await Promise.all([
    loadOpenInvoices(ids),
    loadCandidateOrders(ids, now, config.ruleOrderLookbackDays),
  ]);
  const names = new Map(custRows.map((r) => [r.id, r.name]));
  const promises = new Map(custRows.map((r) => [r.id, r.promisedPayBy ?? null]));

  for (const [customerId, rule] of active) {
    const evaluation = evaluateCustomerRule(rule, invoicesBy.get(customerId) ?? [], now);
    const toHold = ordersRuleWouldHold(evaluation, ordersBy.get(customerId) ?? []);
    if (toHold.length === 0) continue;
    if (config.ruleHoldsRespectPromise && isPromiseActive(promises.get(customerId) ?? null, now)) {
      plan.skippedForPromise += 1;
      continue;
    }
    const why = evaluation.why ?? "Customer hold rule";
    for (const o of toHold) {
      plan.planned.push({
        orderId: o.orderId,
        orderNumber: o.orderNumber,
        shopifyOrderId: o.shopifyOrderId,
        total: o.total,
        holdState: o.holdState,
        customerId,
        customerName: names.get(customerId) ?? null,
        why,
        rule,
        hits: evaluation.hits.slice(0, 5),
      });
    }
  }
  return plan;
}

export async function runCustomerRuleHolds(now: Date = new Date()): Promise<RunCustomerRuleHoldsResult> {
  const settings = await loadAppSettings();
  const config = parseHoldsConfig(settings);
  const rules = await loadEffectiveRules(config);
  const plan = await planRuleHolds(rules, config, now);
  const result: RunCustomerRuleHoldsResult = { ruleCustomers: plan.ruleCustomers, held: 0, alerted: 0 };
  if (plan.skippedForPromise > 0) {
    log.info({ customers: plan.skippedForPromise }, "rule holds skipped: customer has an active promise (H9 switch on)");
  }

  for (const p of plan.planned) {
    const { rule, why, customerId } = p;
    // 1) CLAIM: only an order still in hold_state 'none' can be taken. A
    //    concurrent pass, or a person holding/releasing it since we loaded
    //    it, makes this match 0 rows → we do nothing (no email, no audit).
    const at = new Date();
    const claimed = affectedRows(
      await db
        .update(orders)
        .set({
          holdState: "on_hold",
          holdReason: "customer_rule",
          holdNote: why.slice(0, 500),
          holdLadderEnabled: rule.autoStartLadder,
          holdStartedAt: at,
          // Stamped either way: rule holds are never re-alerted by the
          // standard pass (notify_warehouse=false means "tell nobody").
          holdAlertedAt: at,
          holdAlertThreadId: null,
          holdAlertMessageId: null,
        })
        .where(and(eq(orders.id, p.orderId), eq(orders.holdState, "none"))),
    );
    if (claimed !== 1) {
      log.info({ orderId: p.orderId }, "rule hold: order changed since load — skipped");
      continue;
    }

    // 2) SEND (only the claimer gets here), then stamp the thread so the
    //    release can reply on it.
    let threadId: string | null = null;
    let messageId: string | null = null;
    if (rule.notifyWarehouse && !env.SHADOW_MODE) {
      const planned = planHoldAlertEmail(
        {
          orderId: p.orderId,
          orderNumber: p.orderNumber,
          shopifyOrderId: p.shopifyOrderId,
          total: p.total,
          customerId,
          customerName: p.customerName,
        },
        settings,
        { reasonLine: `Reason: ${why}`, holdStatus: "customer rule" },
      );
      if (planned) {
        try {
          const r = await sendPlannedEmail(planned);
          threadId = r.threadId;
          messageId = r.messageId;
          result.alerted += 1;
        } catch (err) {
          log.error({ err, orderId: p.orderId }, "rule hold: warehouse alert failed (order still held)");
        }
      }
    }
    if (threadId || messageId) {
      await db
        .update(orders)
        .set({ holdAlertedAt: new Date(), holdAlertThreadId: threadId, holdAlertMessageId: messageId })
        .where(eq(orders.id, p.orderId));
    }
    await recordHoldTransition({
      orderId: p.orderId,
      userId: null,
      action: "order.hold_started",
      before: { holdState: p.holdState },
      after: {
        holdState: "on_hold",
        holdReason: "customer_rule",
        via: "customer_rule",
        mode: rule.notifyWarehouse ? "notify" : "record_only",
        why,
        rule: { ...rule },
        hits: p.hits,
        startLadder: rule.autoStartLadder,
      },
    });
    result.held += 1;
    log.info({ orderId: p.orderId, customerId, why }, "order held by customer rule");
  }
  return result;
}
