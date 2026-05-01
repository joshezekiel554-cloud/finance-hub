// Resolves the canonical recipient list for outbound mail to a
// customer. Centralised so the statement-send, chase-email-send,
// invoicing-send, and the QBO BillEmail* push all read from the same
// rules. Three concerns:
//
//   1. Per-channel arrays — these are the source of truth:
//      - statement → statement_to_emails / statement_cc_emails / statement_bcc_emails
//      - invoice   → invoice_to_emails   / invoice_cc_emails   / invoice_bcc_emails
//      Chase emails reuse the statement set (same recipients, by spec).
//      No fallback to primary_email / billing_emails — those are
//      legacy display fields only; the migration backfilled the
//      per-channel arrays from them on first run.
//
//   2. Tag-driven extras:
//      - customers.tags is matched (case-insensitive) against rows in
//        email_routing_rules. Each match yields an additional CC or
//        BCC for one channel.
//      - Multiple matching rules are unioned + deduped.
//
//   3. Defensive normalisation: trim + lowercase + dedupe everywhere.
//      Empty strings fall out of every list.

import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  emailRoutingRules,
  type RoutingRuleAction,
} from "../../db/schema/email-routing-rules.js";

export type Channel = "invoice" | "statement";

export type CustomerEmailInput = {
  // Legacy display fields — kept for the customer-detail header but
  // not consulted for actual recipient resolution any more.
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

export type ResolvedRecipients = {
  // TO is now an array — multiple TO addresses are valid (QBO's
  // BillEmail accepts comma-joined; SMTP/Gmail allow multi-TO).
  // First element is the "primary" recipient when something needs a
  // single string (legacy callers expecting `to: string | null` use
  // `to[0] ?? null` or join with commas).
  to: string[];
  cc: string[];
  bcc: string[];
  // Per-channel reasoning surface so the customer-profile UI can show
  // "auto-BCC: sales@feldart.com (yiddy)" hints next to a tag.
  bccReasons: Array<{ tag: string; address: string }>;
};

function normaliseList(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const lower = v.trim().toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(v.trim());
  }
  return out;
}

// Strip CC entries that are already in TO (case-insensitive). Same
// recipient on both lines is a wire-format error in many SMTP relays
// and a footgun in QBO BillEmail/Cc joins.
function ccMinusTo(cc: string[], to: string[]): string[] {
  if (to.length === 0) return cc;
  const toLower = new Set(to.map((e) => e.trim().toLowerCase()));
  return cc.filter((e) => !toLower.has(e.trim().toLowerCase()));
}

// Resolve recipients for a single channel, given the customer's data
// and (already-fetched) routing rules. The split lets the caller
// batch-fetch rules once for many customers.
export function resolveRecipientsWithRules(
  channel: Channel,
  customer: CustomerEmailInput,
  rules: Array<{ tag: string; action: RoutingRuleAction; value: string }>,
): ResolvedRecipients {
  let to: string[];
  let cc: string[];
  let bcc: string[];
  if (channel === "invoice") {
    to = normaliseList(customer.invoiceToEmails ?? []);
    cc = normaliseList(customer.invoiceCcEmails ?? []);
    bcc = normaliseList(customer.invoiceBccEmails ?? []);
  } else {
    to = normaliseList(customer.statementToEmails ?? []);
    cc = normaliseList(customer.statementCcEmails ?? []);
    bcc = normaliseList(customer.statementBccEmails ?? []);
  }

  cc = ccMinusTo(cc, to);

  // Tag-driven CC + BCC additions.
  const customerTags = (customer.tags ?? []).map((t) =>
    t.trim().toLowerCase(),
  );
  const ccExtras: string[] = [];
  const bccExtras: string[] = [];
  const bccReasons: Array<{ tag: string; address: string }> = [];
  for (const r of rules) {
    if (!customerTags.includes(r.tag.toLowerCase())) continue;
    if (channel === "invoice" && r.action === "cc_invoice") {
      ccExtras.push(r.value);
    } else if (channel === "invoice" && r.action === "bcc_invoice") {
      bccExtras.push(r.value);
      bccReasons.push({ tag: r.tag, address: r.value });
    } else if (channel === "statement" && r.action === "cc_statement") {
      ccExtras.push(r.value);
    } else if (channel === "statement" && r.action === "bcc_statement") {
      bccExtras.push(r.value);
      bccReasons.push({ tag: r.tag, address: r.value });
    }
  }

  const ccFinal = ccMinusTo(normaliseList([...cc, ...ccExtras]), to);
  const bccFinal = normaliseList([...bcc, ...bccExtras]);

  return {
    to,
    cc: ccFinal,
    bcc: bccFinal,
    bccReasons,
  };
}

// Loads routing rules + delegates. Suitable when the caller has just
// one customer to resolve. Multiple-customer flows should fetch rules
// once and call resolveRecipientsWithRules for each.
export async function resolveRecipients(
  channel: Channel,
  customer: CustomerEmailInput,
): Promise<ResolvedRecipients> {
  const rules = await loadRulesForTags(customer.tags ?? []);
  return resolveRecipientsWithRules(channel, customer, rules);
}

// Fetch only the rules whose tag is present on the customer. Keeps the
// query trivially small for the common case (most customers have 0-2
// tags). Returns rules unchanged so the caller can pass straight into
// resolveRecipientsWithRules.
export async function loadRulesForTags(
  tags: string[],
): Promise<Array<{ tag: string; action: RoutingRuleAction; value: string }>> {
  if (tags.length === 0) return [];
  const lowered = Array.from(
    new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
  );
  if (lowered.length === 0) return [];
  const rows = await db
    .select({
      tag: emailRoutingRules.tag,
      action: emailRoutingRules.action,
      value: emailRoutingRules.value,
    })
    .from(emailRoutingRules)
    .where(inArray(emailRoutingRules.tag, lowered));
  return rows;
}

// Convenience for the customer-profile UI / settings hint: tells you
// what would happen if a given tag were applied. Used inside the
// "auto-BCC" caption next to the tag chip.
export async function describeTagEffects(tag: string): Promise<
  Array<{ action: RoutingRuleAction; value: string }>
> {
  const rows = await db
    .select({
      action: emailRoutingRules.action,
      value: emailRoutingRules.value,
    })
    .from(emailRoutingRules)
    .where(eq(emailRoutingRules.tag, tag.trim().toLowerCase()));
  return rows;
}
