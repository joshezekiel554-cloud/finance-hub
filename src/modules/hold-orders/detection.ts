// Customer-rule hold detection — runs in orders-sync right after today's
// standard detection (runOrderHoldAlerts). Only customers with an EXPLICIT
// rule are evaluated; everyone else keeps the standard behaviour unchanged.
//
// For each rule customer whose rule would hold them today, every open,
// never-held order (holdState "none", unshipped, uncancelled, last 30 days)
// goes on_hold with holdReason "customer_rule" and the why-line in holdNote
// (rule snapshot also in the audit row). Per rule:
//   notify_warehouse  → send the standard warehouse hold_alert email
//   auto_start_ladder → enter the Day-0/7/10 customer ladder
// Released orders are never re-held by a rule (see ordersRuleWouldHold).

import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { loadAppSettings } from "../statements/settings.js";
import { recordHoldTransition } from "../orders/hold-alerts.js";
import { planHoldAlertEmail, sendPlannedEmail } from "../orders/hold-email-plan.js";
import { loadCandidateOrders, loadOpenInvoices, loadRulesFor } from "./rules-store.js";
import { evaluateCustomerRule, ordersRuleWouldHold } from "./rule-engine.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "hold-orders.detection" });

export type RunCustomerRuleHoldsResult = {
  ruleCustomers: number;
  held: number;
  alerted: number;
};

export async function runCustomerRuleHolds(now: Date = new Date()): Promise<RunCustomerRuleHoldsResult> {
  const rules = await loadRulesFor();
  const active = [...rules.entries()].filter(([, r]) => r.preset !== "never");
  const result: RunCustomerRuleHoldsResult = { ruleCustomers: active.length, held: 0, alerted: 0 };
  if (active.length === 0) return result;

  const ids = active.map(([id]) => id);
  const [invoicesBy, ordersBy, names] = await Promise.all([
    loadOpenInvoices(ids),
    loadCandidateOrders(ids, now),
    db
      .select({ id: customers.id, name: customers.displayName })
      .from(customers)
      .where(inArray(customers.id, ids))
      .then((rows) => new Map(rows.map((r) => [r.id, r.name]))),
  ]);

  const settings = await loadAppSettings();
  for (const [customerId, rule] of active) {
    const evaluation = evaluateCustomerRule(rule, invoicesBy.get(customerId) ?? [], now);
    const toHold = ordersRuleWouldHold(evaluation, ordersBy.get(customerId) ?? []);
    if (toHold.length === 0) continue;
    const why = evaluation.why ?? "Customer hold rule";

    for (const o of toHold) {
      let threadId: string | null = null;
      let messageId: string | null = null;
      if (rule.notifyWarehouse && !env.SHADOW_MODE) {
        const planned = planHoldAlertEmail(
          {
            orderId: o.orderId,
            orderNumber: o.orderNumber,
            shopifyOrderId: o.shopifyOrderId,
            total: o.total,
            customerId,
            customerName: names.get(customerId) ?? null,
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
            log.error({ err, orderId: o.orderId }, "rule hold: warehouse alert failed (order still held)");
          }
        }
      }
      const at = new Date();
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
          holdAlertThreadId: threadId,
          holdAlertMessageId: messageId,
        })
        .where(eq(orders.id, o.orderId));
      await recordHoldTransition({
        orderId: o.orderId,
        userId: null,
        action: "order.hold_started",
        before: { holdState: o.holdState },
        after: {
          holdState: "on_hold",
          holdReason: "customer_rule",
          via: "customer_rule",
          mode: rule.notifyWarehouse ? "notify" : "record_only",
          why,
          rule: { ...rule },
          hits: evaluation.hits.slice(0, 5),
          startLadder: rule.autoStartLadder,
        },
      });
      result.held += 1;
      log.info({ orderId: o.orderId, customerId, why }, "order held by customer rule");
    }
  }
  return result;
}
