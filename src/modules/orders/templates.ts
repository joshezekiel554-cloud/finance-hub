// Operator-editable order/hold email templates (order-email-templates feature,
// spec 2026-06-19).
//
// Five templates, each {subject, body}, lifted verbatim from the previously
// hardcoded constants in hold-alerts.ts (SUBJECT_TPL/BODY_TPL) and
// hold-ladder.ts (NOTICE/WARNING/CANCEL), plus a NEW `order_cancelled` customer
// message. The effective template = the operator's stored override if non-empty,
// else the default constant here.
//
// Bodies are PLAIN TEXT. `renderOrderTemplate` substitutes {{placeholders}},
// strips any leftover {{...}} to blank (so a typo'd/empty var never leaks into
// the email or crashes), and auto-wraps to HTML the same way the live sends do
// (blank line = <p>, single newline = <br/>). No raw HTML — the wrap escapes
// nothing, so operators must keep bodies plain.

import type { AppSettingsMap } from "../statements/settings.js";
import { renderTemplate } from "../email-compose/index.js";

// The five operator-editable templates. The key maps to a pair of app_settings
// keys: `order_tpl_<key>_subject` / `order_tpl_<key>_body`.
export type OrderTemplateKey =
  | "hold_alert"
  | "hold_notice"
  | "hold_warning"
  | "hold_cancel"
  | "order_cancelled";

export const ORDER_TEMPLATE_KEYS: readonly OrderTemplateKey[] = [
  "hold_alert",
  "hold_notice",
  "hold_warning",
  "hold_cancel",
  "order_cancelled",
] as const;

export type OrderTemplate = { subject: string; body: string };

// Hardcoded defaults — verbatim from the prior constants, except
// `order_cancelled` which is new for this feature.
export const ORDER_EMAIL_DEFAULTS: Record<OrderTemplateKey, OrderTemplate> = {
  // From hold-alerts.ts SUBJECT_TPL / BODY_TPL (internal "⚠ HOLD ORDER").
  hold_alert: {
    subject: "⚠ HOLD ORDER — {{order_number}} ({{customer_name}})",
    body: `Please HOLD order {{order_number}} for {{customer_name}}.

{{reason_line}}

Order: {{order_number}}
Date: {{order_date}}
Total: {{order_total}}
Items: {{item_count}}
Payment status: {{payment_status}}
Customer hold status: {{hold_status}}

Do NOT ship this order until the accounts team confirms it's clear. Reply here once it's held.

Customer record: {{customer_url}}`,
  },
  // From hold-ladder.ts NOTICE_SUBJECT / NOTICE_BODY (Day-0 customer notice).
  hold_notice: {
    subject: "Your Feldart order {{order_number}} is on hold",
    body: `Hi {{customer_name}},

Your recent order {{order_number}} ({{order_total}}) is currently ON HOLD and won't be shipped {{reason_clause}}.

To release it, please {{action_clause}}. Once that's done we'll send it straight out.

If you've already sorted this, thank you — please ignore this message.

Many thanks,
Feldart Accounts`,
  },
  // From hold-ladder.ts WARNING_SUBJECT / WARNING_BODY (Day-7 final warning).
  hold_warning: {
    subject: "Action needed — order {{order_number}} still on hold",
    body: `Hi {{customer_name}},

Order {{order_number}} ({{order_total}}) is still on hold {{reason_clause}}.

Please note: if this isn't resolved within the next 3 days, the order will be cancelled and the items returned to stock.

To keep the order, please {{action_clause}} as soon as possible.

Many thanks,
Feldart Accounts`,
  },
  // From hold-ladder.ts CANCEL_SUBJECT / CANCEL_BODY (Day-10 internal cancel).
  hold_cancel: {
    subject: "CANCEL order {{order_number}} — return items to stock",
    body: `Order {{order_number}} for {{customer_name}} has been on hold for {{age_days}} days with no resolution.

Please CANCEL this order and return the items to stock.

Reason it was held: {{reason_clause}}
Order total: {{order_total}}

Customer record: {{customer_url}}`,
  },
  // NEW — customer-facing cancellation confirmation, sent best-effort from the
  // operator Cancel button after Shopify cancel + QBO void succeed.
  order_cancelled: {
    subject: "Your Feldart order {{order_number}} has been cancelled",
    body: `Hi {{customer_name}},

We're writing to let you know that your order {{order_number}} ({{order_total}}) has now been cancelled and the items returned to stock.

This was because the order remained on hold {{reason_clause}} and wasn't resolved in time.

If you'd still like these items, you're very welcome to place a fresh order — and if you think this was a mistake or you've already settled things, please just reply to this email and we'll sort it out.

Many thanks,
Feldart Accounts`,
  },
};

// Sample values for the "Send me a test" preview — every placeholder used by
// any of the 5 defaults is covered so a test render shows fully-populated text.
export const SAMPLE_VARS: Record<string, string> = {
  order_number: "#18672",
  customer_name: "Acme Holdings Ltd",
  order_total: "$420.00",
  age_days: "8",
  customer_url: "https://finance.feldart.com/customers/sample",
  payment_status: "pending",
  order_date: "19 Jun 2026",
  item_count: "3",
  hold_status: "hold",
  reason_line:
    "Reason: this customer is currently ON HOLD — they should not be able to place orders.",
  reason_clause: "pending settlement of your overdue account balance",
  action_clause:
    "settle your outstanding balance (or contact us to arrange it)",
};

const TPL_KEY_PREFIX = "order_tpl_";

// Strip any unrendered {{...}} token to blank. Mirrors the placeholder charset
// used by renderTemplate (alnum + underscore, whitespace-tolerant) but ALSO
// catches malformed/empty braces so nothing literal survives into the email.
const LEFTOVER_PLACEHOLDER_RE = /\{\{[^}]*\}\}/g;

export function stripUnrendered(s: string): string {
  return s.replace(LEFTOVER_PLACEHOLDER_RE, "");
}

// Plain-text → HTML: blank line = paragraph, single newline = <br/>. Same as
// the live hold sends (toHtml in hold-ladder.ts / hold-actions.ts).
export function orderTemplateToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

// Return the effective (override-or-default) template for a key.
export function loadOrderTemplate(
  settings: Pick<AppSettingsMap, never> & Record<string, string | undefined>,
  key: OrderTemplateKey,
): OrderTemplate {
  const def = ORDER_EMAIL_DEFAULTS[key];
  const subjectOverride = (settings[`${TPL_KEY_PREFIX}${key}_subject`] ?? "").trim();
  const bodyOverride = (settings[`${TPL_KEY_PREFIX}${key}_body`] ?? "").trim();
  return {
    subject: subjectOverride !== "" ? subjectOverride : def.subject,
    body: bodyOverride !== "" ? bodyOverride : def.body,
  };
}

export type RenderedOrderEmail = { subject: string; html: string; text: string };

// Render a template with vars: substitute, strip leftovers to blank, wrap body
// to HTML. Pure — unit-tested.
export function renderOrderTemplate(
  tpl: OrderTemplate,
  vars: Record<string, string>,
): RenderedOrderEmail {
  const subject = stripUnrendered(renderTemplate(tpl.subject, vars)).trim();
  const text = stripUnrendered(renderTemplate(tpl.body, vars));
  return {
    subject,
    text,
    html: orderTemplateToHtml(text),
  };
}
