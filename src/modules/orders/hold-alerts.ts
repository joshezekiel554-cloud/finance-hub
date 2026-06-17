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
// ping. Recipients come from app_settings.order_hold_alert_recipients (Feldart
// inboxes + the Bluechip warehouse by default), tweakable in /settings.
//
// At-most-once: each order's hold_alerted_at is stamped after a successful send,
// so re-evaluating recent orders every 15 min never re-alerts. We only look at
// orders from the last few days so the first sync (which back-fills ~30 days of
// history) can't blast alerts for old orders.

import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders, type Order } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { loadAppSettings } from "../statements/settings.js";
import { renderTemplate } from "../email-compose/index.js";
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

const SUBJECT_TPL = "⚠ HOLD ORDER — {{order_number}} ({{customer_name}})";
const BODY_TPL = `Please HOLD order {{order_number}} for {{customer_name}}.

{{reason_line}}

Order: {{order_number}}
Date: {{order_date}}
Total: {{order_total}}
Items: {{item_count}}
Payment status: {{payment_status}}
Customer hold status: {{hold_status}}

Do NOT ship this order until the accounts team confirms it's clear. Reply here once it's held.

Customer record: {{customer_url}}`;

function reasonLine(reason: HoldAlertReason, paymentStatus: string): string {
  if (reason === "customer_on_hold") {
    return "Reason: this customer is currently ON HOLD — they should not be able to place orders.";
  }
  return `Reason: this customer is PAYMENT UPFRONT and the order is not paid yet (payment status: ${paymentStatus}).`;
}

function fmtMoney(total: string | null): string {
  const n = Number(total);
  return Number.isFinite(n) ? `£${n.toFixed(2)}` : "—";
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
  const recipients = (settings.order_hold_alert_recipients ?? "").trim();
  if (!recipients) {
    log.warn(
      { candidates: rows.length },
      "order hold alerts: no recipients configured (order_hold_alert_recipients empty) — skipping all",
    );
    return { candidates: rows.length, sent: 0, skipped: rows.length };
  }

  // In shadow mode (dev/test) we never send real email. Don't stamp
  // hold_alerted_at either, so a real prod run still fires.
  if (env.SHADOW_MODE) {
    log.info(
      { candidates: rows.length, reason: "shadow_mode" },
      "order hold alerts: shadow mode, not sending",
    );
    return { candidates: rows.length, sent: 0, skipped: rows.length };
  }

  const { sendEmail } = await import("../../integrations/gmail/send.js");

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

    const subject = renderTemplate(SUBJECT_TPL, vars);
    const body = renderTemplate(BODY_TPL, vars);

    try {
      await sendEmail({
        to: recipients,
        subject,
        html: body
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
          .join("\n"),
        text: body,
        financeSendType: "hold-alert",
      });
      await db
        .update(orders)
        .set({ holdAlertedAt: new Date() })
        .where(eq(orders.id, o.id));
      sent += 1;
      log.info(
        { orderId: o.id, orderNumber, reason, customerId: o.customerId },
        "order hold alert sent",
      );
    } catch (err) {
      skipped += 1;
      log.error(
        { err, orderId: o.id, orderNumber, reason },
        "order hold alert send failed — will retry next run",
      );
    }
  }

  return { candidates: rows.length, sent, skipped };
}

// Re-exported for callers that want the row type.
export type OrderRowForAlert = Order;
