// Drafting prompt for tj_chase proposals (origin-split-2 W2 T3).
//
// Mirrors prompts/chase-next.ts but for the Torah Judaica wind-down book:
// the reference template resolved into context.exampleTemplate is the
// tj_l1/2/3 ladder (TJ_CHASE_TIER_SLUG in ../voice.ts — MEDIUM→tj_l1,
// HIGH→tj_l2, CRITICAL→tj_l3), and the tool call is instructed to carry
// origin "tj" so the executor records the chase against the right book.

import type { BuiltPrompt, DraftContext } from "../voice.js";
import { composeSystem, composeCustomerBlock } from "../voice.js";

// Same executor tool as chase_next — the draft differs (TJ templates +
// tone), the send mechanics don't.
export const TOOL_NAME = "send_chase_email";

type TjChaseSummary = {
  customerId: string;
  customerName: string;
  overdueBalance: number;
  daysOverdue: number;
  tier: "CRITICAL" | "HIGH" | "MEDIUM";
  lastChaseAt: string | null;
};

// TJ tone ladder: firm but never legalistic (the wind-down book Feldart
// took over — the relationship context differs from the live Feldart book).
const TONE_INSTRUCTIONS: Record<TjChaseSummary["tier"], string> = {
  CRITICAL: `Tone: final-notice firmness — clear, unambiguous, but NEVER
legalistic or threatening. State that the balance is long outstanding from
the Torah Judaica era and must now be settled or discussed; ask for payment
or a call this week. No legal language, no "further action" threats.`,
  HIGH: `Tone: firm and matter-of-fact. The balance has been outstanding a
long time; ask for a specific payment date or a payment plan — not just an
acknowledgement.`,
  MEDIUM: `Tone: courteous reminder. Acknowledge this balance dates from the
Torah Judaica accounts that Feldart now manages; assume good faith and make
it easy to reply.`,
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatLastChase(lastChaseAt: string | null): string {
  if (!lastChaseAt) return "This is the first chase for this account.";
  const d = new Date(lastChaseAt);
  return `Last chased: ${d.toLocaleDateString("en-US", { dateStyle: "medium" })}.`;
}

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const s = summary as TjChaseSummary;

  const system = composeSystem(
    "You are the accounts team at Feldart, preparing a chase email for an overdue balance on the Torah Judaica (TJ) book — a legacy ledger Feldart took over and is winding down. These are older invoices originally issued by Torah Judaica; Feldart now collects them.",
    context,
  );

  const exampleBlock = context.exampleTemplate
    ? `\n## Reference email to match the tone of\n${context.exampleTemplate}\n`
    : "";

  const user = `## Account situation (Torah Judaica book only)
Customer: ${s.customerName} (ID: ${s.customerId})
TJ overdue balance: ${formatCurrency(s.overdueBalance)}
Days overdue: ${s.daysOverdue}
Severity tier: ${s.tier}
${formatLastChase(s.lastChaseAt)}
${composeCustomerBlock(context)}${exampleBlock}
## Tone instructions
${TONE_INSTRUCTIONS[s.tier]}

If the customer believes any of these invoices were already paid to Torah
Judaica, invite them to reply saying which invoice — we will verify it with
the Torah Judaica bookkeeper. Do not demand proof of payment.

## Your task
Call the \`${TOOL_NAME}\` tool with:
- customerId: "${s.customerId}"
- tier: "${s.tier}"
- origin: "tj"
- subject: a concise subject line matching the tier's urgency
- body: an HTML email body of 3-5 short paragraphs. Use <p> tags. Adapt the
  reference email and Feldart voice above to this customer's situation. Do
  NOT include a signature block — it is appended automatically.

## Skip condition
If the account situation clearly indicates the customer has already paid or a
chase would be inappropriate (e.g. daysOverdue is 0 or balance is 0), return
plain JSON instead of calling the tool:
{"skip": true, "reason": "<one sentence>"}

Act now.`;

  return { system, user };
}
