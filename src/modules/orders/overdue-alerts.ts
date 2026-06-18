// Overdue-order review alerts + dashboard flag (Phase 4).
//
// When an order comes through for a customer who (a) carries a large overdue
// balance, (b) hasn't been in contact for a while, and (c) is NOT excluded from
// autopilot, we:
//   - surface it on the dashboard (the "Overdue-balance orders" widget, which
//     replaces the old "unactioned emails today" widget), and
//   - send ONE urgent review email to the Feldart inboxes with the order, the
//     customer's AI summary, balances, and oldest unpaid invoice, asking them to
//     review and tell Bluechip to hold if required.
//
// The email carries `X-Feldart-Finance-Send: hold-alert` so Inbox routes it to
// To-Do, loud, with a team ping (same treatment as the Phase 3 hold alert).
//
// Thresholds (overdue $ and no-contact days), recipients, and the autopilot-off
// exclusion are all operator-controllable. At-most-once per order via
// orders.overdue_alerted_at. The dashboard widget runs the SAME qualification
// query live (independent of whether the email sent), so a flagged order always
// shows even if the email failed.

import { and, asc, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { orderReviewDismissals } from "../../db/schema/order-review-dismissals.js";
import { emailLog } from "../../db/schema/crm.js";
import { customerAiCards } from "../../db/schema/customer-ai-cards.js";
import { loadAppSettings } from "../statements/settings.js";
import { unshippedOrderSql } from "./hold-alerts.js";
import { renderTemplate } from "../email-compose/index.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "orders.overdue-alerts" });

// Only orders this fresh are eligible for a (first-time) email alert — keeps the
// 30-day first sync from back-blasting and matches the hold-alert window.
export const OVERDUE_ALERT_MAX_AGE_DAYS = 3;
// The dashboard widget looks back further so flagged orders stay visible for a
// while after they trigger.
export const OVERDUE_WIDGET_LOOKBACK_DAYS = 30;

export const DEFAULT_OVERDUE_THRESHOLD_GBP = 1000;
export const DEFAULT_NO_CONTACT_DAYS = 14;

export type OverdueAlertConfig = {
  thresholdGbp: number;
  noContactDays: number;
  recipients: string;
};

// Parse the operator-tweakable settings into typed config, falling back to
// sensible defaults on missing/garbage values.
export function parseOverdueConfig(settings: {
  order_overdue_threshold_gbp: string;
  order_overdue_no_contact_days: string;
  order_overdue_alert_recipients: string;
}): OverdueAlertConfig {
  // Distinguish an empty/blank string ("use the default") from an explicit "0"
  // — Number("") is 0, which would otherwise silently flag every overdue
  // customer when the operator just cleared the field.
  const thresholdStr = (settings.order_overdue_threshold_gbp ?? "").trim();
  const daysStr = (settings.order_overdue_no_contact_days ?? "").trim();
  const thresholdRaw = thresholdStr === "" ? NaN : Number(thresholdStr);
  const daysRaw = daysStr === "" ? NaN : Number(daysStr);
  return {
    thresholdGbp:
      Number.isFinite(thresholdRaw) && thresholdRaw >= 0
        ? thresholdRaw
        : DEFAULT_OVERDUE_THRESHOLD_GBP,
    noContactDays:
      Number.isFinite(daysRaw) && daysRaw > 0
        ? Math.floor(daysRaw)
        : DEFAULT_NO_CONTACT_DAYS,
    recipients: (settings.order_overdue_alert_recipients ?? "").trim(),
  };
}

// Shared WHERE for "this order should be flagged": recent, not cancelled, linked
// to an autopilot-ON customer with overdue ≥ threshold who hasn't been in
// contact within the no-contact window. Used by both the email pass and the
// dashboard widget (each adds its own extra filters / lookback).
function overdueOrderConditions(opts: {
  orderCutoff: Date;
  thresholdGbp: number;
  contactCutoff: Date;
}): SQL[] {
  return [
    isNull(orders.cancelledAt),
    gte(orders.orderDate, opts.orderCutoff),
    // Autopilot ON only — the operator excludes agent-off customers from this.
    eq(customers.agentModeExcluded, false),
    // Overdue balance at/above the threshold. overdueBalance is a decimal
    // string column; MySQL compares it numerically against the bound number.
    sql`${customers.overdueBalance} >= ${opts.thresholdGbp}`,
    // Not communicating: zero emails (either direction) since the contact
    // cutoff. customers.id is hand-qualified inside the correlated subquery
    // because Drizzle's column serializer drops the table prefix here (same
    // gotcha as the customers list route).
    sql`NOT EXISTS (
      SELECT 1 FROM ${emailLog}
      WHERE ${emailLog.customerId} = \`customers\`.\`id\`
        AND ${emailLog.emailDate} >= ${opts.contactCutoff}
    )`,
  ];
}

export type FlaggedOverdueOrder = {
  orderId: string;
  orderNumber: string | null;
  orderDate: string | null;
  orderTotal: string | null;
  customerId: string;
  customerName: string | null;
  overdueBalance: string;
  alerted: boolean;
};

// Dashboard widget data — currently-qualifying recent orders, newest first.
export async function listFlaggedOverdueOrders(
  limit = 10,
): Promise<FlaggedOverdueOrder[]> {
  const settings = await loadAppSettings();
  const cfg = parseOverdueConfig(settings);
  const now = Date.now();
  const conds = overdueOrderConditions({
    orderCutoff: new Date(now - OVERDUE_WIDGET_LOOKBACK_DAYS * 86_400_000),
    thresholdGbp: cfg.thresholdGbp,
    contactCutoff: new Date(now - cfg.noContactDays * 86_400_000),
  });
  // Dashboard only surfaces still-holdable orders (the email pass fires
  // regardless of shipped state).
  conds.push(unshippedOrderSql());
  // Operator-dismissed review rows stay hidden for good (mirrors the chase
  // widget's chase_dismissals exclusion). Only the widget filters these — the
  // email pass is unaffected (it's at-most-once via overdue_alerted_at anyway).
  conds.push(
    sql`${orders.id} NOT IN (SELECT ${orderReviewDismissals.orderId} FROM ${orderReviewDismissals})`,
  );

  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderDate: orders.orderDate,
      orderTotal: orders.total,
      customerId: orders.customerId,
      customerName: customers.displayName,
      overdueBalance: customers.overdueBalance,
      overdueAlertedAt: orders.overdueAlertedAt,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(and(...conds))
    .orderBy(desc(orders.orderDate))
    .limit(limit);

  return rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    orderDate:
      r.orderDate instanceof Date
        ? r.orderDate.toISOString()
        : (r.orderDate as string | null),
    orderTotal: r.orderTotal,
    customerId: r.customerId as string,
    customerName: r.customerName,
    overdueBalance: r.overdueBalance ?? "0",
    alerted: r.overdueAlertedAt != null,
  }));
}

const SUBJECT_TPL =
  "⚠ REVIEW ORDER — {{order_number}} · {{customer_name}} ({{overdue_balance}} overdue)";
const BODY_TPL = `A new order has come through from {{customer_name}}, who has a large overdue balance and has not been in contact.

Order: {{order_number}}
Order date: {{order_date}}
Order total: {{order_total}}

Account:
Total balance: {{balance}}
Overdue balance: {{overdue_balance}}
Oldest unpaid invoice: {{oldest_invoice}}

AI summary:
{{ai_summary}}

Please review and email Bluechip to hold if required.

Customer record: {{customer_url}}`;

function fmtMoney(total: string | null | undefined): string {
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

export type RunOrderOverdueAlertsResult = {
  candidates: number;
  sent: number;
  skipped: number;
};

// Email pass — send ONE urgent review email per newly-qualifying order, then
// stamp overdue_alerted_at. Send failures leave the stamp unset for retry.
export async function runOrderOverdueAlerts(): Promise<RunOrderOverdueAlertsResult> {
  const settings = await loadAppSettings();
  const cfg = parseOverdueConfig(settings);
  const now = Date.now();

  const conds = overdueOrderConditions({
    orderCutoff: new Date(now - OVERDUE_ALERT_MAX_AGE_DAYS * 86_400_000),
    thresholdGbp: cfg.thresholdGbp,
    contactCutoff: new Date(now - cfg.noContactDays * 86_400_000),
  });
  conds.push(isNull(orders.overdueAlertedAt));

  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderDate: orders.orderDate,
      orderTotal: orders.total,
      shopifyOrderId: orders.shopifyOrderId,
      customerId: orders.customerId,
      customerName: customers.displayName,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(and(...conds))
    .orderBy(desc(orders.orderDate))
    .limit(50);

  if (rows.length === 0) return { candidates: 0, sent: 0, skipped: 0 };

  if (!cfg.recipients) {
    log.warn(
      { candidates: rows.length },
      "overdue order alerts: no recipients configured — skipping all",
    );
    return { candidates: rows.length, sent: 0, skipped: rows.length };
  }

  if (env.SHADOW_MODE) {
    log.info(
      { candidates: rows.length, reason: "shadow_mode" },
      "overdue order alerts: shadow mode, not sending",
    );
    return { candidates: rows.length, sent: 0, skipped: rows.length };
  }

  const { sendEmail } = await import("../../integrations/gmail/send.js");

  let sent = 0;
  let skipped = 0;
  for (const r of rows) {
    const customerId = r.customerId as string;
    const orderNumber = r.orderNumber ?? `#${r.shopifyOrderId}`;

    // Oldest unpaid invoice (earliest due date, balance > 0).
    const oldestRows = await db
      .select({
        docNumber: invoices.docNumber,
        dueDate: invoices.dueDate,
        balance: invoices.balance,
      })
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), gt(invoices.balance, "0")))
      .orderBy(asc(invoices.dueDate))
      .limit(1);
    const oldest = oldestRows[0];
    const oldestInvoice = oldest
      ? `${oldest.docNumber ?? "(no #)"} — ${fmtMoney(oldest.balance)} due ${fmtDate(oldest.dueDate)}`
      : "(none on file)";

    // Cached AI summary, if any (don't generate on the fly — too costly here).
    const cardRows = await db
      .select({ summary: customerAiCards.summary })
      .from(customerAiCards)
      .where(eq(customerAiCards.customerId, customerId))
      .limit(1);
    const aiSummary = cardRows[0]?.summary?.trim() || "(no AI summary on file yet)";

    const vars: Record<string, string> = {
      order_number: orderNumber,
      customer_name: r.customerName ?? "(unknown customer)",
      order_date: fmtDate(r.orderDate),
      order_total: fmtMoney(r.orderTotal),
      balance: fmtMoney(r.balance),
      overdue_balance: fmtMoney(r.overdueBalance),
      oldest_invoice: oldestInvoice,
      ai_summary: aiSummary,
      customer_url: `${env.PUBLIC_URL}/customers/${customerId}`,
    };

    const subject = renderTemplate(SUBJECT_TPL, vars);
    const body = renderTemplate(BODY_TPL, vars);

    try {
      await sendEmail({
        to: cfg.recipients,
        subject,
        html: body
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
          .join("\n"),
        text: body,
        financeSendType: "hold-alert",
        financeCustomerId: customerId,
      });
      await db
        .update(orders)
        .set({ overdueAlertedAt: new Date() })
        .where(eq(orders.id, r.orderId));
      sent += 1;
      log.info(
        { orderId: r.orderId, orderNumber, customerId },
        "overdue order alert sent",
      );
    } catch (err) {
      skipped += 1;
      log.error(
        { err, orderId: r.orderId, orderNumber },
        "overdue order alert send failed — will retry next run",
      );
    }
  }

  return { candidates: rows.length, sent, skipped };
}
