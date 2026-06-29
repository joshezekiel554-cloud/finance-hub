// Operator-triggered hold actions (order-hold-lifecycle Phase 3).
//
//   releaseHold  — "Good to send": clears the hold + emails the warehouse "OK
//                  to ship", sent as a REPLY on the original hold-alert Gmail
//                  thread (hold-release) so Inbox flips that thread to Done.
//   placeOnHold  — manually put an overdue-review order into the hold ladder
//                  (the overdue case doesn't auto-enter; the operator opts in).
//   getHoldHistory — the order's hold audit trail (the History drawer).

import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { orderReviewDismissals } from "../../db/schema/order-review-dismissals.js";
import { recordHoldTransition } from "./hold-alerts.js";
import { loadAppSettings } from "../statements/settings.js";
import { loadOrderTemplate, renderOrderTemplate } from "./templates.js";
import {
  loadInternalHoldRecipients,
  resolveHoldCustomerRecipients,
} from "./recipients.js";
import { reasonClause } from "./hold-ladder.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "orders.hold-actions" });

export type HoldActionResult =
  | { ok: true }
  | { ok: false; reason: string };

function toHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

// "Good to send" — release the hold + tell the warehouse to ship, in-thread.
// userId is the operator (string) or null for a board-driven action whose
// actor has no finance account (attribution then lives in a separate audit row
// written by the caller). The columns + recordHoldTransition already accept null.
export async function releaseHold(
  orderId: string,
  userId: string | null,
): Promise<HoldActionResult> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopifyOrderId: orders.shopifyOrderId,
      holdState: orders.holdState,
      holdAlertThreadId: orders.holdAlertThreadId,
      holdAlertMessageId: orders.holdAlertMessageId,
      customerId: orders.customerId,
      customerName: customers.displayName,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  const o = rows[0];
  if (!o) return { ok: false, reason: "not_found" };
  if (o.holdState !== "on_hold") return { ok: false, reason: "not_on_hold" };

  const orderNumber = o.orderNumber ?? `#${o.shopifyOrderId}`;
  const settings = await loadAppSettings();
  const recipients = loadInternalHoldRecipients(settings);

  if (!env.SHADOW_MODE && recipients) {
    const body = `Order ${orderNumber} for ${o.customerName ?? "the customer"} is now CLEARED — good to send. Please go ahead and ship it.`;
    const { sendEmail } = await import("../../integrations/gmail/send.js");
    try {
      await sendEmail({
        to: recipients,
        subject: `✅ CLEARED — order ${orderNumber} good to send`,
        html: toHtml(body),
        text: body,
        // Reply on the original hold-alert thread so Inbox flips THAT thread to
        // Done and drops the ⚠ treatment.
        threadId: o.holdAlertThreadId ?? undefined,
        inReplyTo: o.holdAlertMessageId ?? undefined,
        financeSendType: "hold-release",
        financeCustomerId: o.customerId ?? undefined,
      });
    } catch (err) {
      log.error({ err, orderId, orderNumber }, "release: warehouse email failed");
      // Don't block the state change on the email — the operator decided to
      // release; surface a soft warning instead.
    }
  }

  await db
    .update(orders)
    .set({
      holdState: "released",
      holdReleasedAt: new Date(),
      holdReleasedByUserId: userId,
    })
    .where(eq(orders.id, orderId));
  await recordHoldTransition({
    orderId,
    userId,
    action: "order.hold_released",
    before: { holdState: "on_hold" },
    after: { holdState: "released", via: "good_to_send" },
  });
  log.info({ orderId, orderNumber, userId }, "order hold released (good to send)");
  return { ok: true };
}

// Manually place an (overdue-review) order into the hold ladder.
// userId: operator string, or null for a board-driven action (see releaseHold).
export async function placeOnHold(
  orderId: string,
  userId: string | null,
): Promise<HoldActionResult> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopifyOrderId: orders.shopifyOrderId,
      total: orders.total,
      holdState: orders.holdState,
      customerId: orders.customerId,
      customerName: customers.displayName,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  const o = rows[0];
  if (!o) return { ok: false, reason: "not_found" };
  if (o.holdState === "on_hold") return { ok: false, reason: "already_on_hold" };

  const orderNumber = o.orderNumber ?? `#${o.shopifyOrderId}`;
  const now = new Date();
  const settings = await loadAppSettings();
  const recipients = loadInternalHoldRecipients(settings);

  let threadId: string | null = null;
  let messageId: string | null = null;
  if (!env.SHADOW_MODE && recipients) {
    // Manual overdue hold: render the operator-editable hold_alert template.
    // Vars we don't have here (item_count/payment_status/order_date/hold_status)
    // strip to blank via renderOrderTemplate — the template stays readable.
    const orderTotal = Number.isFinite(Number(o.total))
      ? `$${Number(o.total).toFixed(2)}`
      : "—";
    const tpl = loadOrderTemplate(settings, "hold_alert");
    const rendered = renderOrderTemplate(tpl, {
      order_number: orderNumber,
      customer_name: o.customerName ?? "(unknown customer)",
      reason_line:
        "Reason: this customer has a large overdue balance and hasn't been in contact.",
      order_total: orderTotal,
      hold_status: "overdue",
      customer_url: o.customerId
        ? `${env.PUBLIC_URL}/customers/${o.customerId}`
        : "—",
    });
    const { sendEmail } = await import("../../integrations/gmail/send.js");
    try {
      const r = await sendEmail({
        to: recipients,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        financeSendType: "hold-alert",
        financeCustomerId: o.customerId ?? undefined,
      });
      threadId = r.threadId || null;
      messageId = r.messageId || null;
    } catch (err) {
      log.error({ err, orderId, orderNumber }, "place-on-hold: warehouse email failed");
    }
  }

  await db
    .update(orders)
    .set({
      holdState: "on_hold",
      holdReason: "overdue_non_communicating",
      holdStartedAt: now,
      holdAlertedAt: now,
      holdAlertThreadId: threadId,
      holdAlertMessageId: messageId,
    })
    .where(eq(orders.id, orderId));
  await recordHoldTransition({
    orderId,
    userId,
    action: "order.hold_started",
    before: { holdState: o.holdState },
    after: { holdState: "on_hold", holdReason: "overdue_non_communicating", via: "manual" },
  });
  log.info({ orderId, orderNumber, userId }, "order placed on hold (manual, overdue)");
  return { ok: true };
}

// Manually place ANY (not-currently-held) order on hold from the Orders tab.
// INTERNAL-ONLY by default: fires the immediate warehouse hold-alert (so the
// team sees it) but, unless opts.customerLadder is set, leaves the order OUT of
// the Day-0/7/10 customer chase ladder (holdLadderEnabled=false → excluded by
// runHoldLadder). opts.note is the operator's optional short reason.
// userId: operator string, or null for a board-driven action (see releaseHold).
export async function manualHold(
  orderId: string,
  userId: string | null,
  opts: { note?: string | null; customerLadder?: boolean },
): Promise<HoldActionResult> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopifyOrderId: orders.shopifyOrderId,
      total: orders.total,
      holdState: orders.holdState,
      customerId: orders.customerId,
      customerName: customers.displayName,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  const o = rows[0];
  if (!o) return { ok: false, reason: "not_found" };
  if (o.holdState === "on_hold") return { ok: false, reason: "already_on_hold" };

  const orderNumber = o.orderNumber ?? `#${o.shopifyOrderId}`;
  const note = opts.note?.trim() || null;
  const customerLadder = opts.customerLadder === true;
  const now = new Date();
  const settings = await loadAppSettings();
  const recipients = loadInternalHoldRecipients(settings);

  let threadId: string | null = null;
  let messageId: string | null = null;
  if (!env.SHADOW_MODE && recipients) {
    // Immediate INTERNAL warehouse hold-alert — reuse the operator-editable
    // hold_alert template (vars we don't have strip to blank via render).
    const orderTotal = Number.isFinite(Number(o.total))
      ? `$${Number(o.total).toFixed(2)}`
      : "—";
    const tpl = loadOrderTemplate(settings, "hold_alert");
    const rendered = renderOrderTemplate(tpl, {
      order_number: orderNumber,
      customer_name: o.customerName ?? "(unknown customer)",
      reason_line: `Reason: ${note || "Manually placed on hold by the accounts team."}`,
      order_total: orderTotal,
      hold_status: "manual",
      customer_url: o.customerId
        ? `${env.PUBLIC_URL}/customers/${o.customerId}`
        : "—",
    });
    const { sendEmail } = await import("../../integrations/gmail/send.js");
    try {
      const r = await sendEmail({
        to: recipients,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        financeSendType: "hold-alert",
        financeCustomerId: o.customerId ?? undefined,
      });
      threadId = r.threadId || null;
      messageId = r.messageId || null;
    } catch (err) {
      // Best-effort: never block the state change on the email.
      log.error({ err, orderId, orderNumber }, "manual-hold: warehouse email failed");
    }
  }

  await db
    .update(orders)
    .set({
      holdState: "on_hold",
      holdReason: "manual",
      holdNote: note,
      holdLadderEnabled: customerLadder,
      holdStartedAt: now,
      holdAlertedAt: now,
      holdAlertThreadId: threadId,
      holdAlertMessageId: messageId,
    })
    .where(eq(orders.id, orderId));
  await recordHoldTransition({
    orderId,
    userId,
    action: "order.hold_started",
    before: { holdState: o.holdState },
    after: { holdState: "on_hold", holdReason: "manual", via: "manual", customerLadder },
  });
  log.info(
    { orderId, orderNumber, userId, customerLadder },
    "order placed on hold (manual)",
  );
  return { ok: true };
}

export type CancelResult =
  | { ok: true; shopifyCancelled: boolean; qboVoided: boolean; note: string }
  | { ok: false; reason: string };

// Cancel a held order: cancel it in Shopify + void the matching QBO invoice
// (docNumber == order number), mark holdState=cancelled. Operator-triggered
// (D3). Shopify cancel must succeed before we mark it; QBO void is best-effort
// (prepay orders have no QBO invoice). The warehouse already got the Day-10
// "cancel + restock" email; this does the system-side actions.
export async function cancelHoldOrder(
  orderId: string,
  userId: string | null,
): Promise<CancelResult> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopifyOrderId: orders.shopifyOrderId,
      total: orders.total,
      holdState: orders.holdState,
      holdReason: orders.holdReason,
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
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  const o = rows[0];
  if (!o) return { ok: false, reason: "not_found" };
  if (o.holdState === "cancelled") return { ok: false, reason: "already_cancelled" };

  const orderNumber = o.orderNumber ?? `#${o.shopifyOrderId}`;

  // 1) Cancel in Shopify (hard requirement — abort if it fails).
  if (!env.SHADOW_MODE) {
    try {
      const { ShopifyClient } = await import(
        "../../integrations/shopify/client.js"
      );
      // restock:false — inventory is auto-synced from the warehouse system, so
      // letting Shopify re-add line items here would double-count stock. The
      // warehouse physically returns items and the sync reflects it.
      await new ShopifyClient().cancelOrder(o.shopifyOrderId, {
        restock: false,
        reason: "other",
        notifyCustomer: false,
      });
    } catch (err) {
      log.error({ err, orderId, orderNumber }, "cancel: Shopify cancel failed");
      return { ok: false, reason: "shopify_cancel_failed" };
    }
  }

  // 2) Void the matching QBO invoice (best-effort; docNumber == order number,
  // minus Shopify's leading "#"). Prepay orders paid in Shopify have none.
  let qboVoided = false;
  let note = "Order cancelled in Shopify.";
  const docNumber = orderNumber.replace(/^#/, "");
  if (!env.SHADOW_MODE) {
    try {
      const { QboClient } = await import("../../integrations/qb/client.js");
      const qb = new QboClient();
      const inv = await qb.getInvoiceByDocNumber(docNumber);
      if (inv?.Id && inv?.SyncToken) {
        await qb.voidInvoice(inv.Id, inv.SyncToken);
        qboVoided = true;
        note = "Order cancelled in Shopify + QBO invoice voided.";
      } else {
        note = "Order cancelled in Shopify. No matching QBO invoice to void.";
      }
    } catch (err) {
      log.error(
        { err, orderId, orderNumber, docNumber },
        "cancel: QBO void failed (Shopify cancel already done)",
      );
      note = "Order cancelled in Shopify, but the QBO void failed — void it manually.";
    }
  }

  await db
    .update(orders)
    .set({ holdState: "cancelled", cancelledAt: new Date() })
    .where(eq(orders.id, orderId));
  await recordHoldTransition({
    orderId,
    userId,
    action: "order.hold_cancelled",
    before: { holdState: o.holdState },
    after: { holdState: "cancelled", shopifyCancelled: true, qboVoided },
  });
  log.info(
    { orderId, orderNumber, userId, qboVoided },
    "order cancelled (Shopify + QBO)",
  );

  // Best-effort customer cancellation email — AFTER the cancel + void + state
  // flip have all succeeded. A failed email must NEVER revert the cancel, so we
  // log + swallow. Customer-facing → uses the shared customer recipient helper
  // (incl. Yiddy sales@ CC) and the order-cancelled send type (Inbox: Waiting).
  if (!env.SHADOW_MODE) {
    try {
      const to = await resolveHoldCustomerRecipients(o);
      if (to) {
        const settings = await loadAppSettings();
        const orderTotal = Number.isFinite(Number(o.total))
          ? `$${Number(o.total).toFixed(2)}`
          : "the order value";
        const tpl = loadOrderTemplate(settings, "order_cancelled");
        const rendered = renderOrderTemplate(tpl, {
          order_number: orderNumber,
          customer_name: o.customerName ?? "there",
          order_total: orderTotal,
          reason_clause: reasonClause(o.holdReason),
          customer_url: o.customerId
            ? `${env.PUBLIC_URL}/customers/${o.customerId}`
            : "—",
        });
        const { sendEmail } = await import("../../integrations/gmail/send.js");
        await sendEmail({
          to: to.to,
          cc: to.cc || undefined,
          bcc: to.bcc || undefined,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          financeSendType: "order-cancelled",
          financeCustomerId: o.customerId ?? undefined,
        });
      } else {
        log.warn(
          { orderId, orderNumber },
          "cancel: no customer email — skipped cancellation notice",
        );
      }
    } catch (err) {
      log.error(
        { err, orderId, orderNumber },
        "cancel: customer cancellation email failed (cancel already committed)",
      );
    }
  }

  return { ok: true, shopifyCancelled: true, qboVoided, note };
}

// Permanently dismiss an overdue-balance row from the "Orders to review" widget
// (operator decided it needs no action). Idempotent — a repeat dismiss just
// refreshes the row. Writes an audit row. Does NOT touch holdState or Shopify.
export async function dismissOrderReview(
  orderId: string,
  userId: string | null,
): Promise<HoldActionResult> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!rows[0]) return { ok: false, reason: "not_found" };

  await db
    .insert(orderReviewDismissals)
    .values({ orderId, dismissedByUserId: userId })
    .onDuplicateKeyUpdate({
      set: { dismissedAt: new Date(), dismissedByUserId: userId },
    });
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "order.review_dismissed",
    entityType: "order",
    entityId: orderId,
    before: {},
    after: { reviewDismissed: true },
  });
  log.info({ orderId, userId }, "overdue review dismissed");
  return { ok: true };
}

export type HoldHistoryEntry = {
  occurredAt: string;
  action: string;
  userId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

// The order's hold audit trail, oldest first (drives the History drawer).
export async function getHoldHistory(
  orderId: string,
): Promise<HoldHistoryEntry[]> {
  const rows = await db
    .select({
      occurredAt: auditLog.occurredAt,
      action: auditLog.action,
      userId: auditLog.userId,
      before: auditLog.before,
      after: auditLog.after,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "order"), eq(auditLog.entityId, orderId)))
    .orderBy(asc(auditLog.occurredAt));
  return rows.map((r) => ({
    occurredAt:
      r.occurredAt instanceof Date
        ? r.occurredAt.toISOString()
        : String(r.occurredAt),
    action: r.action,
    userId: r.userId,
    before: r.before ?? null,
    after: r.after ?? null,
  }));
}
