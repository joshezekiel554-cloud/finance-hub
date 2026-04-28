import type { ChaseAccount, EmailContext, QbContext } from "./types.js";

// Lifted verbatim from 1.0's ai-summarizer.js. The QB-specific scoping ("focus
// only on payment/billing") is well-tuned — don't broaden it here. If we want
// general-purpose customer summaries later, add a separate prompt; don't dilute
// this one.
export const CUSTOMER_SUMMARY_PROMPT = `You are an AI assistant analyzing customer email correspondence and accounting data for a business. You have access to both email history AND QuickBooks financial data. Focus ONLY on payment, billing, invoicing, account balance, and order/shipping matters — ignore unrelated emails (marketing, general enquiries, etc.). Produce a structured summary covering these four areas. Be concise and factual. Use bullet points within each section. If no information is available for a section, skip it. Cross-reference emails with QB data — e.g. if a customer says they paid but QB shows a balance, flag it. Keep the TOTAL output under 1800 characters.`;

export const ACTION_PLAN_PROMPT = `You are an accounts assistant. Based on recent email correspondence AND QuickBooks accounting data, write a brief action plan summarizing WHERE THINGS STAND RIGHT NOW and what needs to happen next. Focus ONLY on payment, billing, invoicing, and account balance matters — ignore unrelated emails. Your output goes into a 2000-character text field so be extremely concise. Write in plain language as brief bullet points. Focus only on the CURRENT STATUS — what has been agreed, what is outstanding, what needs chasing. Cross-reference emails with QB data — flag discrepancies (e.g. customer says they paid but QB shows balance, credit memo issued but not discussed in emails). Examples of the tone: "Agreed to pay $500 by end of month", "Check supposedly in the mail as of 2/5 — QB still shows $500 outstanding", "Credit memo #456 for $200 issued 1/8 — not acknowledged by customer", "Need to chase — no reply since 1/20".`;

export const CHASE_DIGEST_PROMPT = `You are helping an accounts assistant prioritize which overdue customer accounts to chase today. You'll be given candidate accounts (already ranked by severity = overdue_amount × days_overdue) along with each one's existing AI Action Plan that summarizes recent email context.

Re-prioritize based on signals you spot in the Action Plans:
- DEMOTE if the customer recently promised payment (e.g. "said will pay Friday", "check in the mail")
- DEMOTE if a partial payment was just received and things look in-progress
- DEMOTE if the issue is a dispute or discrepancy that needs resolution, not chasing
- KEEP/PROMOTE if there's a clear "no response" pattern or the customer has gone silent after prior chases

Output markdown in this exact structure:

## Today's Digest
One paragraph (3-4 sentences) — the day's overall picture, total exposure, what's changed, what to focus on.

## Act Today
Exactly up to 5 accounts, most urgent first. For each:
### {rank}. {Name} — \${overdue} overdue ({days}d) — {TIER}
- One line: the single most important action (what to say, what to ask, what to check)
- One line: key context the assistant should know before contacting them
- One line: what a successful outcome today looks like

## Demoted from Top 5
Any accounts you moved out of Act Today. One bullet each:
- **{Name}** — {brief reason, e.g. "promised 4/25 payment, wait until Monday"}

## Watching
One-line notes on the next 3-5 accounts worth monitoring but not chasing today.

Be direct, specific, and actionable. No generic advice. Use the account's actual context.`;

function formatQbData(qb?: QbContext | null): string {
  if (!qb) return "";

  let section = "--- QUICKBOOKS ACCOUNTING DATA ---\n\n";

  if (qb.currentBalance != null) {
    section += `Current Balance: $${Number(qb.currentBalance).toFixed(2)}\n`;
  }
  if (qb.overdueBalance != null) {
    section += `Overdue Balance: $${Number(qb.overdueBalance).toFixed(2)}\n`;
  }
  if (qb.lastPaymentDate) {
    section += `Last Payment Date: ${qb.lastPaymentDate}\n`;
  }
  if (qb.lastInvoiceDate) {
    section += `Last Invoice Date: ${qb.lastInvoiceDate}\n`;
  }

  const txns = qb.transactions;
  if (txns) {
    if (txns.payments && txns.payments.length > 0) {
      section += "\nRecent Payments:\n";
      for (const p of txns.payments.slice(0, 10)) {
        section += `- PAYMENT $${Number(p.amount).toFixed(2)} on ${p.date}${p.docNumber ? " (#" + p.docNumber + ")" : ""}\n`;
      }
    }
    if (txns.invoices && txns.invoices.length > 0) {
      section += "\nRecent Invoices:\n";
      for (const inv of txns.invoices.slice(0, 10)) {
        const balanceText =
          inv.balance != null && inv.balance > 0
            ? ` (balance: $${Number(inv.balance).toFixed(2)})`
            : " (paid)";
        section += `- INVOICE $${Number(inv.amount).toFixed(2)} on ${inv.date}${inv.docNumber ? " (#" + inv.docNumber + ")" : ""}${balanceText}\n`;
      }
    }
    if (txns.creditMemos && txns.creditMemos.length > 0) {
      section += "\nRecent Credit Memos:\n";
      for (const cm of txns.creditMemos.slice(0, 10)) {
        section += `- CREDIT MEMO $${Number(cm.amount).toFixed(2)} on ${cm.date}${cm.docNumber ? " (#" + cm.docNumber + ")" : ""}\n`;
      }
    }
  }

  section += "\n";
  return section;
}

function formatEmailDateRange(emails: EmailContext[]): string {
  const dates = emails
    .map((e) => new Date(e.date))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return "Unknown";
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  return `${first.toLocaleDateString()} to ${last.toLocaleDateString()}`;
}

function renderEmails(emails: EmailContext[]): string {
  let out = "--- EMAILS ---\n\n";
  for (const email of emails) {
    const direction = email.direction === "outbound" ? "SENT" : "RECEIVED";
    const body = email.body ? email.body.substring(0, 1500) : "(no body)";
    out += `[${direction}] ${email.date}\n`;
    out += `From: ${email.from}\n`;
    out += `Subject: ${email.subject}\n`;
    out += `Body:\n${body}\n\n---\n\n`;
  }
  return out;
}

const SUMMARY_EMAIL_LIMIT = 25;
const ACTION_PLAN_EMAIL_LIMIT = 15;

export function buildCustomerSummaryUserPrompt(
  customerName: string,
  emails: EmailContext[],
  qbData?: QbContext | null,
): string {
  const recent = emails.slice(0, SUMMARY_EMAIL_LIMIT);
  const dateRange = formatEmailDateRange(emails);

  let prompt = `Customer: ${customerName}\n`;
  prompt += `Total Emails: ${emails.length} (showing ${recent.length} most recent)\n`;
  prompt += `Date Range: ${dateRange}\n\n`;
  prompt += formatQbData(qbData);
  prompt += renderEmails(recent);
  prompt += "Please provide a summary with these four sections:\n";
  prompt += "1. PAYMENT/BILLING STATUS (cross-reference emails with QB data)\n";
  prompt += "2. RELATIONSHIP HEALTH\n";
  prompt += "3. ACTION ITEMS\n";
  prompt += "4. COMMUNICATION OVERVIEW\n\n";
  prompt += "Keep the TOTAL output under 1800 characters. Be concise.\n";
  return prompt;
}

export function buildActionPlanUserPrompt(
  customerName: string,
  emails: EmailContext[],
  qbData?: QbContext | null,
): string {
  const recent = emails.slice(0, ACTION_PLAN_EMAIL_LIMIT);

  let prompt = `Customer: ${customerName}\n`;
  prompt += `Reviewing ${recent.length} most recent emails:\n\n`;
  prompt += formatQbData(qbData);
  prompt += renderEmails(recent);
  prompt += "Write the current action plan using these sections (skip any that don't apply):\n";
  prompt +=
    "PAYMENT STATUS: Cross-reference QB data with emails. Flag any discrepancies.\n";
  prompt +=
    "ACTION NEEDED: What we need to do next (chase, send statement, follow up, etc.)\n";
  prompt +=
    "KEY NOTES: Important context (credit memos, disputes, promises, delivery issues)\n";
  prompt += "\nKeep the TOTAL output under 1800 characters. Be direct and actionable.\n";
  return prompt;
}

export function buildChaseDigestUserPrompt(accounts: ChaseAccount[]): string {
  const today = new Date().toISOString().split("T")[0];
  let prompt = `Today is ${today}.\n\nCandidate accounts (sorted by severity score):\n\n`;

  accounts.forEach((a, i) => {
    prompt += `### ${i + 1}. ${a.name}\n`;
    prompt += `- Tier: ${a.tier}, Severity score: ${a.score}\n`;
    prompt += `- Overdue: $${a.overdue_balance} (${a.days_overdue} days since oldest unpaid ${a.oldest_unpaid_invoice ?? "unknown"})\n`;
    prompt += `- Current balance: $${a.current_balance}, Last payment: ${a.last_payment ?? "none recorded"}\n`;
    if (a.last_chased) {
      prompt += `- Last chased: ${a.last_chased.chased_at}${a.last_chased.method ? " via " + a.last_chased.method : ""}\n`;
    } else {
      prompt += "- Last chased: never\n";
    }
    prompt += `- Hold status: ${a.hold_status ?? "YES"}\n`;
    if (a.action_plan && a.action_plan.trim()) {
      prompt += `- Existing AI Action Plan:\n${a.action_plan.trim()}\n`;
    } else {
      prompt += "- Existing AI Action Plan: (none available)\n";
    }
    prompt += "\n---\n\n";
  });

  prompt += "Produce the digest now.";
  return prompt;
}
