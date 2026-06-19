// Order-hold alerts.
//
// Run at the end of every orders-sync. Surfaces two violation cases as a loud
// email so the warehouse can physically hold the parcel:
//
//   1. customer_on_hold        — an order came through for a customer whose
//                                hold_status is "hold". They shouldn't be able
//                                to order at all; if one slips through, hold it.
//   2. payment_upfront_unpaid  — a payment-upfront (prepay) customer's order is
//                                not yet paid in Shopify. Ship only once paid.
//
// The email carries `X-Feldart-Finance-Send: hold-alert`, so the sibling Inbox
// app routes it to To-Do with a loud "⚠ HOLD ORDER" badge + an always-on team
// ping. Recipients are the merged warehouse + accounts-team lists
// (loadInternalHoldRecipients), tweakable in /settings, and the body comes from
// the operator-editable hold_alert template (ORDER_EMAIL_DEFAULTS).
//
// Decoupled (order-email-templates spec §5): an order is flipped to on_hold for
// every qualifying order REGARDLESS of whether recipients are configured — a
// missing recipient list never means "no hold". The alert email is sent only
// when recipients exist. At-most-once: hold_alerted_at is stamped only after a
// successful send, so an un-emailed hold retries the alert next run without
// re-flipping the state. We only look at orders from the last few days so the
// first sync (which back-fills ~30 days of history) can't blast alerts.

import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { orders, type Order } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { loadAppSettings } from "../statements/settings.js";
import { loadOrderTemplate, renderOrderTemplate } from "./templates.js";
import { loadInternalHoldRecipients } from "./recipients.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "orders.hold-alerts" });

// Don't back-blast historical orders: only orders newer than this are eligible
// for a (first-time) alert. Generous enough to catch a "customer put on hold
// after they ordered" case on the next sync.
export const HOLD_ALERT_MAX_AGE_DAYS = 3;

// Shopify financial_status values that mean "money is in" — anything else (incl.
// null/pending/authorized/partially_paid) counts as not-yet-paid for a prepay
// customer.
const PAID_FINANCIAL_STATUSES = new Set([
  "paid",
  "refunded",
  "partially_refunded",
  "voided",
]);

export function isPaymentPending(financialStatus: string | null): boolean {
  const s = (financialStatus ?? "").trim().toLowerCase();
  if (!s) return true;
  return !PAID_FINANCIAL_STATUSES.has(s);
}

// "Still holdable" = not yet shipped/fulfilled and not carrier-delivered. Used
// by the dashboard widgets so we only surface orders the operator can actually
// still hold (a fulfilled/delivered order is moot). NOT applied to the email
// alerts — those fire regardless, since a prepay order that shipped unpaid is
// exactly when you most want to know.
export function unshippedOrderSql(): SQL {
  return sql`(${orders.fulfillmentStatus} IS NULL OR LOWER(${orders.fulfillmentStatus}) NOT IN ('fulfilled','restocked'))
    AND (${orders.shipmentStatus} IS NULL OR LOWER(${orders.shipmentStatus}) <> 'delivered')`;
}

export type HoldAlertReason = "customer_on_hold" | "payment_upfront_unpaid";

// Pure decision — exported for unit testing. Returns the reason an order should
// be held, or null if it's fine. Cancelled orders never alert.
export function classifyOrderHoldAlert(args: {
  cancelledAt: Date | string | null;
  holdStatus: string | null;
  financialStatus: string | null;
}): HoldAlertReason | null {
  if (args.cancelledAt) return null;
  if (args.holdStatus === "hold") return "customer_on_hold";
  if (args.holdStatus === "payment_upfront" && isPaymentPending(args.financialStatus)) {
    return "payment_upfront_unpaid";
  }
  return null;
}

// Does the stored hold reason STILL apply given the customer/order's current
// state? Used by the auto-clear pass — when it no longer applies, the order is
// auto-released. overdueThresholdGbp is only consulted for the overdue reason.
export function holdReasonStillApplies(args: {
  reason: string | null;
  holdStatus: string | null;
  financialStatus: string | null;
  overdueBalance: string | null;
  overdueThresholdGbp: number;
}): boolean {
  switch (args.reason) {
    case "customer_on_hold":
      return args.holdStatus === "hold";
    case "payment_upfront_unpaid":
      return (
        args.holdStatus === "payment_upfront" &&
        isPaymentPending(args.financialStatus)
      );
    case "overdue_non_communicating":
      return Number(args.overdueBalance ?? 0) >= args.overdueThresholdGbp;
    default:
      return false;
  }
}

// Append an audit_log row for a hold-state transition. userId null = automated
// (detection / auto-clear); set = an operator action.
export async function recordHoldTransition(args: {
  orderId: string;
  userId: string | null;
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId: args.userId,
    action: args.action,
    entityType: "order",
    entityId: args.orderId,
    before: args.before,
    after: args.after,
  });
}

function reasonLine(reason: HoldAlertReason, paymentStatus: string): string {
  if (reason === "customer_on_hold") {
    return "Reason: this customer is currently ON HOLD — they should not be able to place orders.";
  }
  return `Reason: this customer is PAYMENT UPFRONT and the order is not paid yet (payment status: ${paymentStatus}).`;
}

function fmtMoney(total: string | null): string {
  const n = Number(total);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export type RunOrderHoldAlertsResult = {
  candidates: number;
  sent: number;
  skipped: number;
};

// Evaluate recent, un-alerted orders and send a hold alert for each violation.
// Idempotent per order via orders.hold_alerted_at. Send failures leave the
// stamp unset so the next run retries.
export async function runOrderHoldAlerts(): Promise<RunOrderHoldAlertsResult> {
  const cutoff = new Date(Date.now() - HOLD_ALERT_MAX_AGE_DAYS * 86_400_000);

  // Orders linked to a customer who's on hold, OR payment-upfront with an
  // unpaid order. Not cancelled, not yet alerted, recent.
  const rows = await db
    .select({
      order: orders,
      holdStatus: customers.holdStatus,
      customerName: customers.displayName,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(
      and(
        isNull(orders.holdAlertedAt),
        isNull(orders.cancelledAt),
        gte(orders.orderDate, cutoff),
        or(
          eq(customers.holdStatus, "hold"),
          and(
            eq(customers.holdStatus, "payment_upfront"),
            sql`(${orders.financialStatus} IS NULL OR LOWER(${orders.financialStatus}) NOT IN ('paid','refunded','partially_refunded','voided'))`,
          ),
        ),
      ),
    )
    .limit(200);

  if (rows.length === 0) {
    return { candidates: 0, sent: 0, skipped: 0 };
  }

  const settings = await loadAppSettings();
  const recipients = loadInternalHoldRecipients(settings);
  const alertTpl = loadOrderTemplate(settings, "hold_alert");

  // DECOUPLED (order-email-templates spec §5): the per-order state flip to
  // on_hold MUST happen for every qualifying order regardless of whether alert
  // recipients are configured. The email is sent only when recipients exist;
  // a missing recipient list never means "no hold". In shadow mode we still
  // flip state but never send (and never capture a thread id).
  if (!recipients) {
    log.warn(
      { candidates: rows.length },
      "order hold alerts: no internal recipients configured (warehouse + team empty) — holding orders but not emailing",
    );
  }
  if (env.SHADOW_MODE) {
    log.info(
      { candidates: rows.length, reason: "shadow_mode" },
      "order hold alerts: shadow mode, flipping state but not sending",
    );
  }

  const canSend = Boolean(recipients) && !env.SHADOW_MODE;
  const sendEmail = canSend
    ? (await import("../../integrations/gmail/send.js")).sendEmail
    : null;

  let sent = 0;
  let skipped = 0;
  for (const { order: o, holdStatus, customerName } of rows) {
    const reason = classifyOrderHoldAlert({
      cancelledAt: o.cancelledAt,
      holdStatus,
      financialStatus: o.financialStatus,
    });
    if (!reason) {
      skipped += 1;
      continue;
    }

    const orderNumber = o.orderNumber ?? `#${o.shopifyOrderId}`;
    const paymentStatus = o.financialStatus ?? "unknown";

    // 1) Send the alert email if we can. Failures here must NOT block the hold
    // state flip (operator's whole point: a held customer's order is held even
    // if the warehouse email bounces). Capture the thread for in-thread release.
    let threadId: string | null = null;
    let messageId: string | null = null;
    if (sendEmail) {
      const vars: Record<string, string> = {
        order_number: orderNumber,
        customer_name: customerName ?? "(unknown customer)",
        reason_line: reasonLine(reason, paymentStatus),
        order_date: fmtDate(o.orderDate),
        order_total: fmtMoney(o.total),
        item_count: String(o.itemCount ?? 0),
        payment_status: paymentStatus,
        hold_status: holdStatus ?? "—",
        customer_url: o.customerId
          ? `${env.PUBLIC_URL}/customers/${o.customerId}`
          : "—",
      };
      const rendered = renderOrderTemplate(alertTpl, vars);
      try {
        const sendResult = await sendEmail({
          to: recipients,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          financeSendType: "hold-alert",
          financeCustomerId: o.customerId ?? undefined,
        });
        threadId = sendResult.threadId || null;
        messageId = sendResult.messageId || null;
        sent += 1;
        log.info(
          { orderId: o.id, orderNumber, reason, customerId: o.customerId },
          "order hold alert sent",
        );
      } catch (err) {
        skipped += 1;
        log.error(
          { err, orderId: o.id, orderNumber, reason },
          "order hold alert send failed — order still flipped to on_hold; alert retries next run",
        );
        // Leave holdAlertedAt unset (below) so the email retries next run, but
        // still flip the hold state now.
      }
    } else {
      skipped += 1;
    }

    // 2) Flip the order to on_hold — but ONLY on the first transition (when it
    // isn't already on_hold). This keeps the ladder clock (holdStartedAt) and
    // the audit row at-most-once even when the email couldn't go out and the
    // order is re-selected next run for an alert retry. holdAlertedAt is the
    // "alert delivered" marker: stamped only when the email actually sent, so a
    // hold with no recipients (or a bounced send) is re-evaluated next run to
    // retry the email without re-flipping or resetting the clock.
    const now = new Date();
    const alerted = Boolean(threadId || messageId);
    if (o.holdState !== "on_hold") {
      await db
        .update(orders)
        .set({
          holdAlertedAt: alerted ? now : null,
          holdState: "on_hold",
          holdReason: reason,
          holdStartedAt: now,
          holdAlertThreadId: threadId,
          holdAlertMessageId: messageId,
        })
        .where(eq(orders.id, o.id));
      await recordHoldTransition({
        orderId: o.id,
        userId: null,
        action: "order.hold_started",
        before: { holdState: o.holdState },
        after: { holdState: "on_hold", holdReason: reason },
      });
    } else if (alerted) {
      // Already on_hold from a prior recipient-less run; now the email landed,
      // so stamp the marker + capture the thread without touching the clock.
      await db
        .update(orders)
        .set({
          holdAlertedAt: now,
          holdAlertThreadId: threadId,
          holdAlertMessageId: messageId,
        })
        .where(eq(orders.id, o.id));
    }
  }

  return { candidates: rows.length, sent, skipped };
}

// Dashboard widget look-back for hold orders.
export const HOLD_WIDGET_LOOKBACK_DAYS = 30;

export type HoldOrderRow = {
  orderId: string;
  orderNumber: string | null;
  orderDate: string | null;
  orderTotal: string | null;
  customerId: string;
  customerName: string | null;
  reason: string | null;
  heldDays: number;
};

// Dashboard data — orders currently on_hold (the per-order holdState is the
// source of truth now), still holdable (unshipped). Covers all hold reasons,
// including overdue orders an operator manually placed on hold.
export async function listHoldableHoldOrders(
  limit = 10,
): Promise<HoldOrderRow[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderDate: orders.orderDate,
      orderTotal: orders.total,
      holdReason: orders.holdReason,
      holdStartedAt: orders.holdStartedAt,
      customerId: orders.customerId,
      customerName: customers.displayName,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(and(eq(orders.holdState, "on_hold"), unshippedOrderSql()))
    .orderBy(desc(orders.holdStartedAt))
    .limit(limit);

  return rows
    .map((r) => {
      const row: HoldOrderRow = {
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        orderDate:
          r.orderDate instanceof Date
            ? r.orderDate.toISOString()
            : (r.orderDate as string | null),
        orderTotal: r.orderTotal,
        customerId: r.customerId as string,
        customerName: r.customerName,
        reason: r.holdReason,
        heldDays: r.holdStartedAt
          ? Math.floor(
              (Date.now() - new Date(r.holdStartedAt).getTime()) / 86_400_000,
            )
          : 0,
      };
      return row;
    })
    .filter((r): r is HoldOrderRow => r !== null);
}

// Auto-clear: release any on_hold order whose reason no longer applies (prepay
// order got paid, customer taken off hold, overdue settled below threshold).
// holdReleasedByUserId stays null to mark it as an automatic release. Runs each
// orders-sync.
export async function releaseResolvedHolds(): Promise<{ released: number }> {
  const settings = await loadAppSettings();
  const thRaw = (settings.order_overdue_threshold_gbp ?? "").trim();
  const overdueThresholdGbp =
    thRaw === "" || !Number.isFinite(Number(thRaw)) ? 1000 : Number(thRaw);

  const rows = await db
    .select({
      id: orders.id,
      holdReason: orders.holdReason,
      financialStatus: orders.financialStatus,
      holdStatus: customers.holdStatus,
      overdueBalance: customers.overdueBalance,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.holdState, "on_hold"))
    .limit(500);

  let released = 0;
  for (const r of rows) {
    const stillHeld = holdReasonStillApplies({
      reason: r.holdReason,
      holdStatus: r.holdStatus,
      financialStatus: r.financialStatus,
      overdueBalance: r.overdueBalance,
      overdueThresholdGbp,
    });
    if (stillHeld) continue;
    await db
      .update(orders)
      .set({
        holdState: "released",
        holdReleasedAt: new Date(),
        holdReleasedByUserId: null,
      })
      .where(eq(orders.id, r.id));
    await recordHoldTransition({
      orderId: r.id,
      userId: null,
      action: "order.hold_auto_released",
      before: { holdState: "on_hold", holdReason: r.holdReason },
      after: { holdState: "released", reason: "resolved" },
    });
    released += 1;
    log.info(
      { orderId: r.id, holdReason: r.holdReason },
      "order hold auto-released (reason resolved)",
    );
  }
  return { released };
}

// Re-exported for callers that want the row type.
export type OrderRowForAlert = Order;
