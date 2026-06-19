// Shared order-hold recipient resolution (order-email-templates feature).
//
// Two concerns, both previously inlined in hold-ladder.ts:
//
//   1. Customer-facing sends (hold_notice / hold_warning / order_cancelled) →
//      the customer's statement recipients, PLUS sales@feldart.com auto-CC for
//      Yiddy-tagged customers (operator rule). `resolveHoldCustomerRecipients`.
//
//   2. Internal sends (hold_alert / hold_cancel) → the merged + deduped
//      warehouse + accounts-team lists. `loadInternalHoldRecipients`.

import { resolveRecipients } from "../customer-emails/recipients.js";
import type { AppSettingsMap } from "../statements/settings.js";

export const YIDDY_SALES_CC = "sales@feldart.com";

export type HoldCustomerInput = {
  primaryEmail: string | null;
  billingEmails: string[] | null;
  invoiceToEmails: string[] | null;
  invoiceCcEmails: string[] | null;
  invoiceBccEmails: string[] | null;
  statementToEmails: string[] | null;
  statementCcEmails: string[] | null;
  statementBccEmails: string[] | null;
  tags: string[] | null;
};

export type HoldCustomerRecipients = { to: string; cc: string; bcc: string };

// Resolve the customer's statement recipients (+ sales@ cc for Yiddy-tagged, per
// the operator). Returns null when there's no usable TO address. Used by the
// hold ladder (Day-0/7 customer emails) AND the cancellation email.
export async function resolveHoldCustomerRecipients(
  r: HoldCustomerInput,
): Promise<HoldCustomerRecipients | null> {
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

// Merge the warehouse + accounts-team recipient lists into one deduped,
// comma-joined string for the internal hold_alert + hold_cancel sends.
// Case-insensitive dedupe, preserving the first-seen casing + order. Empty
// string = no recipients (caller skips the send).
export function loadInternalHoldRecipients(
  settings: Pick<
    AppSettingsMap,
    "order_hold_warehouse_recipients" | "order_hold_team_recipients"
  >,
): string {
  const warehouse = settings.order_hold_warehouse_recipients ?? "";
  const team = settings.order_hold_team_recipients ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [warehouse, team]) {
    for (const part of raw.split(",")) {
      const addr = part.trim();
      if (!addr) continue;
      const lower = addr.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(addr);
    }
  }
  return out.join(",");
}
