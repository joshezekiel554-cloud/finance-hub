// Operator-triggered hold actions (order-hold-lifecycle Phase 3).
//
//   releaseHold  — "Good to send": clears the hold + emails the warehouse "OK
//                  to ship", sent as a REPLY on the original hold-alert Gmail
//                  thread (hold-release) so Inbox flips that thread to Done.
//   placeOnHold  — manually put an overdue-review order into the hold ladder
//                  (the overdue case doesn't auto-enter; the operator opts in).
//   getHoldHistory — the order's hold audit trail (the History drawer).

import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { recordHoldTransition } from "./hold-alerts.js";
import { loadAppSettings } from "../statements/settings.js";
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
export async function releaseHold(
  orderId: string,
  userId: string,
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
  const recipients = (settings.order_hold_alert_recipients ?? "").trim();

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
export async function placeOnHold(
  orderId: string,
  userId: string,
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
  const recipients = (settings.order_hold_alert_recipients ?? "").trim();

  let threadId: string | null = null;
  let messageId: string | null = null;
  if (!env.SHADOW_MODE && recipients) {
    const body = `Please HOLD order ${orderNumber} for ${o.customerName ?? "the customer"}.

Reason: this customer has a large overdue balance and hasn't been in contact. Do NOT ship until the accounts team confirms it's clear. Reply here once held.`;
    const { sendEmail } = await import("../../integrations/gmail/send.js");
    try {
      const r = await sendEmail({
        to: recipients,
        subject: `⚠ HOLD ORDER — ${orderNumber} (${o.customerName ?? "customer"})`,
        html: toHtml(body),
        text: body,
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
  userId: string,
): Promise<CancelResult> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopifyOrderId: orders.shopifyOrderId,
      holdState: orders.holdState,
      customerId: orders.customerId,
    })
    .from(orders)
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
      await new ShopifyClient().cancelOrder(o.shopifyOrderId, {
        restock: true,
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
  return { ok: true, shopifyCancelled: true, qboVoided, note };
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
