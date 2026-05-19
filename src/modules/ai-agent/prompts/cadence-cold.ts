export const TOOL_NAME = "send_check_in_email";

type ColdSummary = {
  customerName: string;
  openBalance: number;
  daysSinceLastPayment: number;
  daysSinceLastContact: number;
};

export function buildPrompt(summary: Record<string, unknown>): string {
  const s = summary as ColdSummary;
  const paymentLabel =
    s.daysSinceLastPayment >= 99999
      ? "no payment on record"
      : `last payment ${s.daysSinceLastPayment} days ago`;
  const contactLabel =
    s.daysSinceLastContact >= 99999
      ? "no prior contact on record"
      : `last contact ${s.daysSinceLastContact} days ago`;

  return `You are an accounts assistant deciding whether to send a gentle check-in email to a customer who has gone quiet.

Customer: ${s.customerName}
Open balance: $${s.openBalance.toFixed(2)}
Payment activity: ${paymentLabel}
Contact activity: ${contactLabel}

Context: This customer has an outstanding balance but has not paid or been contacted in a while. The goal is NOT to chase or pressure — it is to check in warmly, acknowledge the silence without passive-aggression, and open a door in case there is anything they need or any reason for the gap.

Rules:
- Skip if the open balance is trivially small (under ~$150). Respond with JSON only: {"skip": true, "reason": "<one sentence>"}
- Skip if context suggests this is not the right moment (e.g. very recent first contact, special account notes).
- If you send: the tone must be warm and low-pressure. Do not mention overdue, chase, or demand. Assume good faith.

If you decide to send: call the \`${TOOL_NAME}\` tool with:
  - \`customerId\`: you will receive this from the system context
  - \`subject\`: a friendly, non-alarming subject line (e.g. "Checking in — ${s.customerName} account")
  - \`body\`: HTML, 3 short paragraphs:
    1. Warm greeting and reason for reaching out (keep it light — "just wanted to touch base").
    2. Acknowledge you haven't connected in a bit; ask if everything is going well or if there is anything they need from Feldart's side.
    3. Brief, soft reference to the open balance — offer to answer any questions about invoices — and a friendly close.

If you decide to skip: respond with plain JSON only — no tool call:
  {"skip": true, "reason": "<one sentence>"}

Do not explain your reasoning outside of the skip reason. Act directly.`;
}
