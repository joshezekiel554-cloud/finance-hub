// Settings DRY RUN: "with these settings, today we'd hold N orders and flag
// N orders". Runs the same detection/flag logic the real passes use, against
// a draft config. Reads only — no state change, no email, no audit.
//
//   hold = customer-rule holds (explicit rules + the default rule when the
//          draft switches it on; planRuleHolds) ∪ standard account-state
//          holds (customer on hold / prepay unpaid) inside the draft
//          new-order window (findHoldAlertCandidates)
//   flag = the overdue "Orders to review" list under the draft threshold /
//          no-contact days / list window (listFlaggedOverdueOrders)

import { classifyOrderHoldAlert, findHoldAlertCandidates } from "../orders/hold-alerts.js";
import { listFlaggedOverdueOrders } from "../orders/overdue-alerts.js";
import { planRuleHolds } from "./detection.js";
import { loadEffectiveRules } from "./rules-store.js";
import type { HoldsConfig } from "./holds-settings.js";

export type PreviewOrder = {
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  reason: string;
};

export type DryRunCounts = {
  hold: { count: number; orders: PreviewOrder[] };
  flag: { count: number; orders: PreviewOrder[] };
};

export const PREVIEW_LIST_MAX = 25;

export async function dryRunHoldsConfig(config: HoldsConfig, now: Date = new Date()): Promise<DryRunCounts> {
  const hold = new Map<string, PreviewOrder>();

  const rules = await loadEffectiveRules(config);
  const plan = await planRuleHolds(rules, config, now);
  for (const p of plan.planned) {
    hold.set(p.orderId, { orderId: p.orderId, orderNumber: p.orderNumber, customerName: p.customerName, reason: p.why });
  }

  const standard = await findHoldAlertCandidates(config.holdAlertLookbackDays, now);
  for (const { order: o, holdStatus, customerName } of standard) {
    if (o.holdState === "on_hold" || hold.has(o.id)) continue;
    const reason = classifyOrderHoldAlert({ cancelledAt: o.cancelledAt, holdStatus, financialStatus: o.financialStatus });
    if (!reason) continue;
    hold.set(o.id, {
      orderId: o.id,
      orderNumber: o.orderNumber ?? `#${o.shopifyOrderId}`,
      customerName,
      reason: reason === "customer_on_hold" ? "Customer account is on hold" : "Payment upfront — order not paid yet",
    });
  }

  const flagged = await listFlaggedOverdueOrders(500, {
    thresholdGbp: config.overdueThresholdGbp,
    noContactDays: config.noContactDays,
    lookbackDays: config.overdueWidgetLookbackDays,
  });
  const flag = flagged
    .filter((f) => !hold.has(f.orderId))
    .map((f) => ({
      orderId: f.orderId,
      orderNumber: f.orderNumber,
      customerName: f.customerName,
      reason: `$${Number(f.overdueBalance).toFixed(2)} overdue and not in contact`,
    }));

  const holdList = [...hold.values()];
  return {
    hold: { count: holdList.length, orders: holdList.slice(0, PREVIEW_LIST_MAX) },
    flag: { count: flag.length, orders: flag.slice(0, PREVIEW_LIST_MAX) },
  };
}
