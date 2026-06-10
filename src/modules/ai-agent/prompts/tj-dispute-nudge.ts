// Drafting prompt for tj_dispute_nudge proposals (origin-split-2 W2 T3).
//
// The drafted email goes to the TORAH JUDAICA BOOKKEEPER, not the customer.
// The recipient address is NOT part of the drafted args — the executor's
// send_bookkeeper_email tool resolves app_settings.tj_bookkeeper_email at
// execution time (so the AI can never redirect the email, and a setting
// change between draft and approve is honoured). The prompt still names the
// bookkeeper so the draft reads correctly and the operator reviewing the
// proposal sees who it addresses.
//
// Two variants, branched on the candidate summary:
//   - follow-up: the linked bookkeeper thread has been silent ≥ 7 days —
//     a short nudge referencing the earlier ask.
//   - first email: no bookkeeper thread yet — introduce the customer's
//     claims-paid question from scratch.

import type { BuiltPrompt, DraftContext } from "../voice.js";
import { composeSystem } from "../voice.js";

export const TOOL_NAME = "send_bookkeeper_email";

type TjDisputeNudgeSummary = {
  invoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  balance: number;
  claimedAt: string | null;
  disputeNote: string | null;
  hasBookkeeperThread: boolean;
  needsFirstEmail: boolean;
  daysSilent: number | null;
  lastThreadEmailAt: string | null;
  bookkeeperEmail: string | null;
  bookkeeperName: string | null;
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(iso: string | null): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleDateString("en-US", { dateStyle: "medium" });
}

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const s = summary as TjDisputeNudgeSummary;

  const system = composeSystem(
    "You are the accounts team at Feldart, writing to the Torah Judaica bookkeeper — a colleague on the wind-down of the Torah Judaica book, NOT a customer. You are verifying a customer's claim that an invoice was already paid to Torah Judaica. Keep it short, specific and collegial: this is an internal-side query between bookkeepers, not a chase.",
    context,
  );

  const bookkeeperLine = s.bookkeeperEmail
    ? `the TJ bookkeeper${s.bookkeeperName ? ` ${s.bookkeeperName}` : ""} (${s.bookkeeperEmail})`
    : `the TJ bookkeeper — address not configured yet in Settings → Torah Judaica, so the send will fail until it is set`;

  const threadBlock = s.needsFirstEmail
    ? `No bookkeeper email has been sent yet for this dispute — this is the
FIRST message. Introduce the question from scratch: which invoice, what the
customer claims, and what we need confirmed (was it paid to Torah Judaica,
and when/how).`
    : `We already have an open thread with the bookkeeper about this invoice,
but it has been silent for ${s.daysSilent ?? "several"} days (last message
${formatDate(s.lastThreadEmailAt)}). Write a brief follow-up nudge: reference
the earlier ask, restate the invoice + claim in one line, and ask if they
have been able to check yet. Do not re-explain everything.`;

  const user = `## Dispute being verified
Invoice: #${s.docNumber ?? s.invoiceId} — open balance ${formatCurrency(s.balance)}
Customer: ${s.customerName}
Customer claimed paid on: ${formatDate(s.claimedAt)}
Operator note on the claim: ${s.disputeNote?.trim() ? s.disputeNote : "(none recorded)"}

## Recipient
This email goes to ${bookkeeperLine}. It is NOT the customer — never address
the customer, never use chase language, and do not put any email address in
the body. The system delivers it to the configured bookkeeper address.

## Thread state
${threadBlock}

## Your task
Call the \`${TOOL_NAME}\` tool with:
- invoiceId: "${s.invoiceId}"
- subject: a short, specific subject (include the invoice number; when
  following up on an existing thread, keep the subject consistent with a
  reply rather than a fresh topic)
- body: an HTML email body of 1-3 short paragraphs. Use <p> tags. Do NOT
  include a signature block — it is appended automatically.

## Skip condition
If the situation clearly makes the email pointless (e.g. balance is 0),
return plain JSON instead of calling the tool:
{"skip": true, "reason": "<one sentence>"}

Act now.`;

  return { system, user };
}
