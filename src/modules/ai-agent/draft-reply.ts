// Per-email AI draft reply. Triggered from a "Draft reply" button on an
// inbound email row. Optionally accepts operator notes ("send back X,
// sorry Y, will get sorted") that steer the draft. Pulls in the full
// thread + customer state + voice + facts + corrections, returns
// {subject, body} for the compose modal to pre-fill.

import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog } from "../../db/schema/crm.js";
import { buildDraftContext, type DraftContext } from "./voice.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "ai-agent.draft-reply" });

const MODEL = "claude-sonnet-4-6";
const MAX_BODY_CHARS = 4000;

export type ThreadMessage = {
  direction: "inbound" | "outbound";
  from: string;
  date: string;
  subject: string;
  body: string;
};

export type DraftReplyPromptInput = {
  thread: ThreadMessage[];
  customer: {
    id: string;
    name: string;
    balance: number;
    hasHold: boolean;
  };
  notes: string | null;
  context: DraftContext;
};

export function buildDraftReplyPrompt(input: DraftReplyPromptInput): {
  system: string;
  user: string;
} {
  const system =
    `You write email replies on behalf of Feldart's accounts team. Match ` +
    `the seriousness of the situation, be specific (invoice numbers, ` +
    `amounts, dates). Return strict JSON: {"subject": string, "body": string}. ` +
    `The body is plain prose, paragraphs separated by blank lines. Do NOT ` +
    `include a greeting line copying "Dear Sir/Madam" — start with a simple ` +
    `"Hello" or the contact's name. Do NOT add a sign-off block — the ` +
    `signature is appended automatically.\n\n` +
    `## Voice\n${input.context.voiceGuide}\n\n` +
    (input.context.globalFacts.length
      ? `## Things to know about Feldart\n${input.context.globalFacts
          .map((f) => `- ${f}`)
          .join("\n")}\n\n`
      : "") +
    (input.context.globalCorrections.length
      ? `## Style corrections\n${input.context.globalCorrections
          .map((c) => `- ${c}`)
          .join("\n")}\n\n`
      : "");

  const threadBlock = input.thread
    .map(
      (m) =>
        `### ${m.direction.toUpperCase()} — ${m.date} — ${m.from}\n` +
        `Subject: ${m.subject}\n${m.body}`,
    )
    .join("\n\n---\n\n");

  const ctxLine =
    `Customer: ${input.customer.name} ` +
    `(open balance £${input.customer.balance.toFixed(2)}, ` +
    `on hold: ${input.customer.hasHold ? "yes" : "no"})`;

  const ctxBlock = input.context.customerContext
    ? `\n\n## Customer-specific context\n${input.context.customerContext}`
    : "";

  const notesBlock = input.notes
    ? `\n\n## Operator instructions for this reply\n${input.notes}`
    : "";

  const user =
    `${ctxLine}\n\n## Thread\n${threadBlock}${ctxBlock}${notesBlock}\n\n` +
    `Write a reply to the most recent inbound message. Output JSON only: ` +
    `{ "subject": string, "body": string }.`;

  return { system, user };
}

export type DraftReplyResult = {
  subject: string;
  body: string;
};

// Strip a fenced ```json ... ``` wrapper if present.
function unfence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence?.[1]?.trim() ?? trimmed;
}

export function parseDraftReplyResponse(
  raw: string,
  fallbackSubject: string,
): DraftReplyResult {
  try {
    const parsed = JSON.parse(unfence(raw)) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as { subject?: unknown; body?: unknown };
      const subject =
        typeof p.subject === "string" && p.subject.length > 0
          ? p.subject
          : fallbackSubject;
      const body = typeof p.body === "string" ? p.body : "";
      return { subject, body };
    }
  } catch {
    // fall through: treat raw as the body
  }
  return { subject: fallbackSubject, body: raw };
}

export async function generateDraftReply(
  emailLogId: string,
  notes: string | null,
): Promise<DraftReplyResult> {
  const rows = await db
    .select()
    .from(emailLog)
    .where(eq(emailLog.id, emailLogId))
    .limit(1);
  const source = rows[0];
  if (!source) throw new Error(`email_log not found: ${emailLogId}`);
  if (source.direction !== "inbound") {
    throw new Error("draft-reply only supports inbound rows");
  }
  if (!source.customerId) throw new Error("email has no linked customer");
  if (!source.threadId) throw new Error("email has no threadId");

  // Persist notes onto the source row BEFORE the LLM call — they belong
  // to the operator's intent regardless of what the model returns.
  // Distiller picks them up later for learn-from-edits.
  if (notes != null && notes.trim().length > 0) {
    await db
      .update(emailLog)
      .set({ draftAiNotes: notes })
      .where(eq(emailLog.id, emailLogId));
  }

  const threadRows = await db
    .select()
    .from(emailLog)
    .where(eq(emailLog.threadId, source.threadId))
    .orderBy(asc(emailLog.emailDate));

  const cRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, source.customerId))
    .limit(1);
  const customer = cRows[0];
  if (!customer) throw new Error("customer missing");

  const ctx = await buildDraftContext("chase_next", {}, source.customerId);

  const prompt = buildDraftReplyPrompt({
    thread: threadRows.map((r) => ({
      direction: r.direction,
      from: r.fromAddress ?? "",
      date: r.emailDate.toISOString().slice(0, 10),
      subject: r.subject ?? "",
      body: (r.body ?? r.snippet ?? "").slice(0, MAX_BODY_CHARS),
    })),
    customer: {
      id: customer.id,
      name: customer.displayName,
      balance: Number(customer.balance ?? 0),
      hasHold: Boolean(customer.holdStatus && customer.holdStatus !== "active"),
    },
    notes: notes && notes.trim().length > 0 ? notes : null,
    context: ctx,
  });

  const client = getAnthropicClient();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  await trackUsage(res, { surface: "inline_draft_email" });

  const textBlock = res.content.find((b) => b.type === "text");
  const raw =
    textBlock && textBlock.type === "text" && "text" in textBlock
      ? (textBlock as { text: string }).text
      : "";
  const fallbackSubject = source.subject?.toLowerCase().startsWith("re:")
    ? source.subject
    : `Re: ${source.subject ?? ""}`;
  const result = parseDraftReplyResponse(raw, fallbackSubject);

  log.info(
    {
      emailLogId,
      hasNotes: Boolean(notes && notes.trim().length > 0),
      threadSize: threadRows.length,
    },
    "draft reply generated",
  );
  return result;
}
