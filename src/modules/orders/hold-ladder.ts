// Hold email ladder (order-hold-lifecycle Phase 2).
//
// While an order is on_hold, escalate by email:
//   Day 0  — Email 1 → CUSTOMER: "your order is on hold pending payment /
//            overdue balance settled." (financeSendType "hold-chase" → Waiting)
//   Day 7  — Email 2 → CUSTOMER: "resolve within 3 days or the order is
//            cancelled + items returned to stock." ("hold-chase")
//   Day 10 — Email 3 → INTERNAL (warehouse list): "cancel order, return to
//            stock." ("hold-cancel" → Waiting + Cancelled chip)
//
// Each stage fires at-most-once (sent-markers on the order) and only while the
// order is still on_hold — the auto-clear pass (releaseResolvedHolds) releases
// resolved holds first, so a customer who pays mid-ladder stops getting chased.
// Day-10 only NOTIFIES; the actual cancel is an operator button (Phase 5).

import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { loadAppSettings } from "../statements/settings.js";
import { recordHoldTransition } from "./hold-alerts.js";
import {
  loadOrderTemplate,
  renderOrderTemplate,
} from "./templates.js";
import {
  loadInternalHoldRecipients,
  resolveHoldCustomerRecipients,
} from "./recipients.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "orders.hold-ladder" });

export const HOLD_WARN_DAYS = 7;
export const HOLD_CANCEL_DAYS = 10;

type LadderReason = string | null;

// Customer-facing "why it's held" + "what to do" clauses, by reason.
export function reasonClause(reason: LadderReason): string {
  if (reason === "payment_upfront_unpaid") {
    return "pending payment for this order";
  }
  return "pending settlement of your overdue account balance";
}
export function actionClause(reason: LadderReason): string {
  if (reason === "payment_upfront_unpaid") {
    return "complete payment for the order";
  }
  return "settle your outstanding balance (or contact us to arrange it)";
}

function fmtMoney(total: string | null): string {
  const n = Number(total);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "the order value";
}

function daysSince(d: Date | null): number {
  if (!d) return 0;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

export type RunHoldLadderResult = {
  onHold: number;
  notices: number;
  warnings: number;
  cancelNotices: number;
};

export async function runHoldLadder(): Promise<RunHoldLadderResult> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopifyOrderId: orders.shopifyOrderId,
      total: orders.total,
      holdReason: orders.holdReason,
      holdStartedAt: orders.holdStartedAt,
      holdNoticeAt: orders.holdNoticeAt,
      holdWarnedAt: orders.holdWarnedAt,
      holdCancelNotifiedAt: orders.holdCancelNotifiedAt,
      customerId: orders.customerId,
      customerName: customers.displayName,
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
      invoiceToEmails: customers.invoiceToEmails,
      invoiceCcEmails: customers.invoiceCcEmails,
      invoiceBccEmails: customers.invoiceBccEmails,
      statementToEmails: customers.statementToEmails,
      statementCcEmails: customers.statementCcEmails,
      statementBccEmails: customers.statementBccEmails,
      tags: customers.tags,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.holdState, "on_hold"))
    .limit(500);

  const result: RunHoldLadderResult = {
    onHold: rows.length,
    notices: 0,
    warnings: 0,
    cancelNotices: 0,
  };
  if (rows.length === 0) return result;

  if (env.SHADOW_MODE) {
    log.info(
      { onHold: rows.length, reason: "shadow_mode" },
      "hold ladder: shadow mode, not sending",
    );
    return result;
  }

  const settings = await loadAppSettings();
  const internalRecipients = loadInternalHoldRecipients(settings);
  const noticeTpl = loadOrderTemplate(settings, "hold_notice");
  const warningTpl = loadOrderTemplate(settings, "hold_warning");
  const cancelTpl = loadOrderTemplate(settings, "hold_cancel");
  const { sendEmail } = await import("../../integrations/gmail/send.js");

  for (const r of rows) {
    const orderNumber = r.orderNumber ?? `#${r.shopifyOrderId}`;
    const ageDays = daysSince(r.holdStartedAt);
    const vars: Record<string, string> = {
      order_number: orderNumber,
      customer_name: r.customerName ?? "there",
      order_total: fmtMoney(r.total),
      reason_clause: reasonClause(r.holdReason),
      action_clause: actionClause(r.holdReason),
      age_days: String(ageDays),
      customer_url: r.customerId
        ? `${env.PUBLIC_URL}/customers/${r.customerId}`
        : "—",
    };

    try {
      // Day 0 — customer notice (Email 1).
      if (!r.holdNoticeAt) {
        const to = await resolveHoldCustomerRecipients(r);
        if (!to) {
          log.warn({ orderId: r.id }, "hold ladder: no customer email — skip notice");
        } else {
          const rendered = renderOrderTemplate(noticeTpl, vars);
          await sendEmail({
            to: to.to,
            cc: to.cc || undefined,
            bcc: to.bcc || undefined,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            financeSendType: "hold-chase",
            financeCustomerId: r.customerId ?? undefined,
          });
          await db.update(orders).set({ holdNoticeAt: new Date() }).where(eq(orders.id, r.id));
          await recordHoldTransition({
            orderId: r.id,
            userId: null,
            action: "order.hold_notice_sent",
            before: {},
            after: { stage: "notice" },
          });
          result.notices += 1;
        }
        continue;
      }

      // Day 7 — customer final warning (Email 2).
      if (ageDays >= HOLD_WARN_DAYS && !r.holdWarnedAt) {
        const to = await resolveHoldCustomerRecipients(r);
        if (to) {
          const rendered = renderOrderTemplate(warningTpl, vars);
          await sendEmail({
            to: to.to,
            cc: to.cc || undefined,
            bcc: to.bcc || undefined,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            financeSendType: "hold-chase",
            financeCustomerId: r.customerId ?? undefined,
          });
          await db.update(orders).set({ holdWarnedAt: new Date() }).where(eq(orders.id, r.id));
          await recordHoldTransition({
            orderId: r.id,
            userId: null,
            action: "order.hold_warning_sent",
            before: {},
            after: { stage: "warning", ageDays },
          });
          result.warnings += 1;
        }
        continue;
      }

      // Day 10 — internal cancel notice (Email 3).
      if (
        ageDays >= HOLD_CANCEL_DAYS &&
        r.holdWarnedAt &&
        !r.holdCancelNotifiedAt &&
        internalRecipients
      ) {
        const rendered = renderOrderTemplate(cancelTpl, vars);
        await sendEmail({
          to: internalRecipients,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          financeSendType: "hold-cancel",
          financeCustomerId: r.customerId ?? undefined,
        });
        await db
          .update(orders)
          .set({ holdCancelNotifiedAt: new Date() })
          .where(eq(orders.id, r.id));
        await recordHoldTransition({
          orderId: r.id,
          userId: null,
          action: "order.hold_cancel_notified",
          before: {},
          after: { stage: "cancel_notice", ageDays },
        });
        result.cancelNotices += 1;
      }
    } catch (err) {
      log.error(
        { err, orderId: r.id, orderNumber },
        "hold ladder: send failed for one order — will retry next run",
      );
    }
  }

  return result;
}
