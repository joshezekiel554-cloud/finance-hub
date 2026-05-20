import type { BuiltPrompt, DraftContext } from "../voice.js";

export const TOOL_NAME = "send_chase_email";

type ChaseSummary = {
  customerId: string;
  customerName: string;
  overdueBalance: number;
  daysOverdue: number;
  tier: "CRITICAL" | "HIGH" | "MEDIUM";
  lastChaseAt: string | null;
};

const TONE_INSTRUCTIONS: Record<ChaseSummary["tier"], string> = {
  CRITICAL: `Tone: formal and urgent. This account requires escalation language.
State clearly that if no response is received within 7 days, further action
will be taken (orders on hold, escalation to management). Do not soften.`,
  HIGH: `Tone: firm but professional. Emphasise that a payment deadline is needed.
Ask for a specific date or payment plan — not just acknowledgement.`,
  MEDIUM: `Tone: friendly reminder. Warm, non-pressuring. Assume the invoice
simply slipped through the cracks. Leave the door open for a quick reply.`,
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
  const s = summary as ChaseSummary;

  const system = `You are the accounts team at Feldart, preparing a chase email for an overdue customer account.

## How Feldart writes
${context.voiceGuide}`;

  const exampleBlock = context.exampleTemplate
    ? `\n## Reference email to match the tone of\n${context.exampleTemplate}\n`
    : "";

  const user = `## Account situation
Customer: ${s.customerName} (ID: ${s.customerId})
Overdue balance: ${formatCurrency(s.overdueBalance)}
Days overdue: ${s.daysOverdue}
Severity tier: ${s.tier}
${formatLastChase(s.lastChaseAt)}
${exampleBlock}
## Tone instructions
${TONE_INSTRUCTIONS[s.tier]}

## Your task
Call the \`${TOOL_NAME}\` tool with:
- customerId: "${s.customerId}"
- tier: "${s.tier}"
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
