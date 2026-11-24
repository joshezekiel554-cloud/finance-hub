// Order-hold email PLANNING — the single place that decides exactly which
// hold emails a given action would send (to whom, which template, what
// subject/body). Used by:
//   - the send paths (hold-actions.ts manual/overdue hold + good-to-send,
//     and the Hold Orders actions), which plan then send, and
//   - the Hold Orders preview endpoint, which plans and returns the list.
// Because both go through the same planner, the preview can never drift from
// what actually goes out.

import type { AppSettingsMap } from "../statements/settings.js";
import type { FinanceSendType } from "../../integrations/gmail/types.js";
import { loadOrderTemplate, renderOrderTemplate } from "./templates.js";
import {
  loadInternalHoldRecipients,
  resolveHoldCustomerRecipients,
  type HoldCustomerInput,
} from "./recipients.js";
import { actionClause, reasonClause, isLadderPaused } from "./hold-ladder.js";
import { isPromiseActive } from "../promises/promise-state.js";
import { env } from "../../lib/env.js";

export type PlannedEmailRole = "warehouse" | "customer" | "internal";

export type PlannedEmail = {
  role: PlannedEmailRole;
  template: "hold_alert" | "hold_release" | "hold_notice";
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  financeSendType: FinanceSendType;
  financeCustomerId?: string;
  // "now" = sent by the action itself; "next_sync" = the ladder sends it on
  // its next pass (~15 min), shown so the preview is complete.
  when: "now" | "next_sync";
};

export type HoldPlanOrder = {
  orderId: string;
  orderNumber: string | null;
  shopifyOrderId: string;
  total: string | null;
  customerId: string | null;
  customerName: string | null;
  holdAlertThreadId?: string | null;
  holdAlertMessageId?: string | null;
};

export function displayOrderNumber(o: Pick<HoldPlanOrder, "orderNumber" | "shopifyOrderId">): string {
  return o.orderNumber ?? `#${o.shopifyOrderId}`;
}

function fmtMoney(total: string | null, fallback: string): string {
  const n = Number(total);
  return total != null && Number.isFinite(n) ? `$${n.toFixed(2)}` : fallback;
}

function customerUrl(customerId: string | null): string {
  return customerId ? `${env.PUBLIC_URL}/customers/${customerId}` : "—";
}

function toHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

type PlanSettings = AppSettingsMap;

/**
 * The immediate warehouse "⚠ HOLD ORDER" alert (operator-editable hold_alert
 * template) to the merged warehouse + accounts-team list. Null when no
 * recipients are configured (the hold still happens; nobody is emailed).
 */
export function planHoldAlertEmail(
  o: HoldPlanOrder,
  settings: PlanSettings,
  opts: { reasonLine: string; holdStatus: string },
): PlannedEmail | null {
  const to = loadInternalHoldRecipients(settings);
  if (!to) return null;
  const tpl = loadOrderTemplate(settings, "hold_alert");
  const rendered = renderOrderTemplate(tpl, {
    order_number: displayOrderNumber(o),
    customer_name: o.customerName ?? "(unknown customer)",
    reason_line: opts.reasonLine,
    order_total: fmtMoney(o.total, "—"),
    hold_status: opts.holdStatus,
    customer_url: customerUrl(o.customerId),
  });
  return {
    role: "warehouse",
    template: "hold_alert",
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    financeSendType: "hold-alert",
    financeCustomerId: o.customerId ?? undefined,
    when: "now",
  };
}

/**
 * "✅ CLEARED — good to send" to the warehouse, as a reply on the original
 * hold-alert thread so Inbox flips that thread to Done.
 */
export function planReleaseEmail(
  o: HoldPlanOrder,
  settings: PlanSettings,
): PlannedEmail | null {
  const to = loadInternalHoldRecipients(settings);
  if (!to) return null;
  const orderNumber = displayOrderNumber(o);
  const body = `Order ${orderNumber} for ${o.customerName ?? "the customer"} is now CLEARED — good to send. Please go ahead and ship it.`;
  return {
    role: "warehouse",
    template: "hold_release",
    to,
    subject: `✅ CLEARED — order ${orderNumber} good to send`,
    html: toHtml(body),
    text: body,
    threadId: o.holdAlertThreadId ?? undefined,
    inReplyTo: o.holdAlertMessageId ?? undefined,
    financeSendType: "hold-release",
    financeCustomerId: o.customerId ?? undefined,
    when: "now",
  };
}

export type LadderNoticeInput = HoldPlanOrder &
  HoldCustomerInput & {
    holdReason: string | null;
    holdLadderPausedUntil?: Date | string | null;
    customerPromisedPayBy?: string | null;
  };

/**
 * The Day-0 customer notice the ladder will send on its next pass when a
 * hold enters the ladder — same template + recipients runHoldLadder uses.
 * Null when it won't go (paused, customer promise active, no customer email).
 */
export async function planLadderNoticeEmail(
  o: LadderNoticeInput,
  settings: PlanSettings,
): Promise<PlannedEmail | null> {
  if (isLadderPaused(o.holdLadderPausedUntil)) return null;
  if (isPromiseActive(o.customerPromisedPayBy ?? null)) return null;
  const to = await resolveHoldCustomerRecipients(o);
  if (!to) return null;
  const tpl = loadOrderTemplate(settings, "hold_notice");
  const rendered = renderOrderTemplate(tpl, {
    order_number: displayOrderNumber(o),
    customer_name: o.customerName ?? "there",
    order_total: fmtMoney(o.total, "the order value"),
    reason_clause: reasonClause(o.holdReason),
    action_clause: actionClause(o.holdReason),
    age_days: "0",
    customer_url: customerUrl(o.customerId),
  });
  return {
    role: "customer",
    template: "hold_notice",
    to: to.to,
    cc: to.cc || undefined,
    bcc: to.bcc || undefined,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    financeSendType: "hold-chase",
    financeCustomerId: o.customerId ?? undefined,
    when: "next_sync",
  };
}

export type SentEmailRef = { threadId: string | null; messageId: string | null };

/** Send one planned "now" email via the shared Gmail sender. Throws on failure. */
export async function sendPlannedEmail(p: PlannedEmail): Promise<SentEmailRef> {
  const { sendEmail } = await import("../../integrations/gmail/send.js");
  const r = await sendEmail({
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    html: p.html,
    text: p.text,
    threadId: p.threadId,
    inReplyTo: p.inReplyTo,
    financeSendType: p.financeSendType,
    financeCustomerId: p.financeCustomerId,
  });
  return { threadId: r.threadId || null, messageId: r.messageId || null };
}
