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
import { resolveRecipients } from "../customer-emails/recipients.js";
import { loadAppSettings } from "../statements/settings.js";
import { recordHoldTransition } from "./hold-alerts.js";
import { renderTemplate } from "../email-compose/index.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "orders.hold-ladder" });

export const HOLD_WARN_DAYS = 7;
export const HOLD_CANCEL_DAYS = 10;
const YIDDY_SALES_CC = "sales@feldart.com";

const NOTICE_SUBJECT = "Your Feldart order {{order_number}} is on hold";
const NOTICE_BODY = `Hi {{customer_name}},

Your recent order {{order_number}} ({{order_total}}) is currently ON HOLD and won't be shipped {{reason_clause}}.

To release it, please {{action_clause}}. Once that's done we'll send it straight out.

If you've already sorted this, thank you — please ignore this message.

Many thanks,
Feldart Accounts`;

const WARNING_SUBJECT = "Action needed — order {{order_number}} still on hold";
const WARNING_BODY = `Hi {{customer_name}},

Order {{order_number}} ({{order_total}}) is still on hold {{reason_clause}}.

Please note: if this isn't resolved within the next 3 days, the order will be cancelled and the items returned to stock.

To keep the order, please {{action_clause}} as soon as possible.

Many thanks,
Feldart Accounts`;

const CANCEL_SUBJECT = "CANCEL order {{order_number}} — return items to stock";
const CANCEL_BODY = `Order {{order_number}} for {{customer_name}} has been on hold for {{age_days}} days with no resolution.

Please CANCEL this order and return the items to stock.

Reason it was held: {{reason_clause}}
Order total: {{order_total}}

Customer record: {{customer_url}}`;

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

function toHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
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
  const warehouseRecipients = (settings.order_hold_alert_recipients ?? "").trim();
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
        const to = await resolveCustomerTo(r);
        if (!to) {
          log.warn({ orderId: r.id }, "hold ladder: no customer email — skip notice");
        } else {
          await sendEmail({
            to: to.to,
            cc: to.cc || undefined,
            bcc: to.bcc || undefined,
            subject: renderTemplate(NOTICE_SUBJECT, vars),
            html: toHtml(renderTemplate(NOTICE_BODY, vars)),
            text: renderTemplate(NOTICE_BODY, vars),
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
        const to = await resolveCustomerTo(r);
        if (to) {
          await sendEmail({
            to: to.to,
            cc: to.cc || undefined,
            bcc: to.bcc || undefined,
            subject: renderTemplate(WARNING_SUBJECT, vars),
            html: toHtml(renderTemplate(WARNING_BODY, vars)),
            text: renderTemplate(WARNING_BODY, vars),
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
        warehouseRecipients
      ) {
        await sendEmail({
          to: warehouseRecipients,
          subject: renderTemplate(CANCEL_SUBJECT, vars),
          html: toHtml(renderTemplate(CANCEL_BODY, vars)),
          text: renderTemplate(CANCEL_BODY, vars),
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

// Resolve the customer's statement recipients (+ sales@ cc for Yiddy-tagged, per
// the operator). Returns null when there's no usable TO address.
async function resolveCustomerTo(r: {
  primaryEmail: string | null;
  billingEmails: string[] | null;
  invoiceToEmails: string[] | null;
  invoiceCcEmails: string[] | null;
  invoiceBccEmails: string[] | null;
  statementToEmails: string[] | null;
  statementCcEmails: string[] | null;
  statementBccEmails: string[] | null;
  tags: string[] | null;
}): Promise<{ to: string; cc: string; bcc: string } | null> {
  const resolved = await resolveRecipients("statement", r);
  const to = resolved.to.length
    ? resolved.to
    : r.primaryEmail
      ? [r.primaryEmail]
      : [];
  if (to.length === 0) return null;

  const cc = [...resolved.cc];
  const isYiddy = (r.tags ?? []).some((t) => t.trim().toLowerCase() === "yiddy");
  if (isYiddy) {
    const present = new Set(
      [...to, ...cc, ...resolved.bcc].map((e) => e.toLowerCase()),
    );
    if (!present.has(YIDDY_SALES_CC)) cc.push(YIDDY_SALES_CC);
  }

  return { to: to.join(","), cc: cc.join(","), bcc: resolved.bcc.join(",") };
}
