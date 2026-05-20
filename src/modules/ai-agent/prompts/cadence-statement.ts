import type { BuiltPrompt, DraftContext } from "../voice.js";

export const TOOL_NAME = "send_statement";

type StatementSummary = {
  customerName: string;
  openInvoiceCount: number;
  totalOpenBalance: number;
  lastStatementSentAt: string | null;
  daysSinceLastStatement: number;
};

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const s = summary as StatementSummary;
  const lastSent = s.lastStatementSentAt
    ? `last sent ${s.daysSinceLastStatement} days ago`
    : "never sent a statement";

  const system = `You are an accounts assistant at Feldart deciding whether to send a statement of open invoices to a customer, and writing the short cover note that accompanies it.

## How Feldart writes
${context.voiceGuide}`;

  const user = `Customer: ${s.customerName}
Open invoices: ${s.openInvoiceCount}
Total open balance: $${s.totalOpenBalance.toFixed(2)}
Statement history: ${lastSent}

Decide whether sending a statement is worthwhile right now.

Rules:
- Skip if the balance is trivially small (under ~$100) and the relationship seems low-priority.
- Skip if a statement was sent very recently (under 14 days) and nothing material has changed.
- Prefer sending when balance is significant or there are multiple open invoices.

If you decide to send: call the \`${TOOL_NAME}\` tool with:
  - \`customerId\`: you will receive this from the system context
  - \`coverNote\` (optional): a single short sentence in the Feldart voice, e.g. "Hi ${s.customerName}, please find attached your current statement of open invoices."

If you decide to skip: respond with plain JSON only — no tool call:
  {"skip": true, "reason": "<one sentence>"}

Do not explain your reasoning outside of the skip reason. Act directly.`;

  return { system, user };
}
