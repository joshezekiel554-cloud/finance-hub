// Customer AI card pipeline. One row per customer in customer_ai_cards;
// generation runs every 5 candidate finders scoped to the customer +
// pulls customer KPIs/recent emails + does a single Anthropic call that
// returns {summary, actions[]} structured JSON. Cache TTL is 24h, but
// reads still return stale rows with an is_stale flag so the page renders
// instantly; the Regenerate button forces a fresh call.

import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog } from "../../db/schema/crm.js";
import {
  customerAiCards,
  type CardAction,
} from "../../db/schema/customer-ai-cards.js";
import { buildDraftContext, type DraftContext } from "./voice.js";
import { findCandidates as findChaseNext } from "./candidates/chase-next.js";
import { findCandidates as findCadenceCold } from "./candidates/cadence-cold.js";
import { findCandidates as findCadenceStatement } from "./candidates/cadence-statement.js";
import { findCandidates as findOpsRmaStalled } from "./candidates/ops-rma-stalled.js";
import { findCandidates as findOpsCronFail } from "./candidates/ops-cron-fail.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "ai-agent.customer-card" });

const CACHE_TTL_HOURS = 24;
const MODEL = "claude-sonnet-4-6";

export type CardKpis = {
  balance: number;
  overdueBalance: number;
  hasHold: boolean;
};

export type CardCandidate = {
  category: string;
  entityType: string;
  entityId: string;
  summary: Record<string, unknown>;
};

export type CardEmail = {
  direction: "inbound" | "outbound";
  subject: string;
  date: string;
};

export type CardPromptInput = {
  customer: { id: string; name: string };
  kpis: CardKpis;
  candidates: CardCandidate[];
  recentEmails: CardEmail[];
  context: DraftContext;
};

export type CustomerCardData = {
  summary: string;
  actions: CardAction[];
};

export function buildCardPrompt(input: CardPromptInput): {
  system: string;
  user: string;
} {
  const system =
    `You produce concise customer summaries and action plans for an ` +
    `accounts assistant. Output strict JSON matching the schema below. ` +
    `Reference specific invoice numbers, amounts, dates, customer state. ` +
    `Stay in voice. Don't invent facts.\n\n` +
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
      : "") +
    `## Output schema (return JSON only — no prose preamble)\n` +
    `{\n` +
    `  "summary": string,   // 1-2 short paragraphs of plain prose\n` +
    `  "actions": [         // 0 or more recommended actions\n` +
    `    {\n` +
    `      "kind": "send_chase_email" | "send_statement" | "send_check_in_email" | "view_rma" | "view_cron_failure",\n` +
    `      "label": string, // operator-facing button text\n` +
    `      "args": object   // kind-specific args, may be empty\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `Only include actions that are actually warranted. If nothing's needed, return [].`;

  const candidatesBlock = input.candidates.length
    ? input.candidates
        .map(
          (c) =>
            `- ${c.category} (${c.entityType}:${c.entityId}): ${JSON.stringify(c.summary)}`,
        )
        .join("\n")
    : "(no autopilot candidates for this customer right now)";

  const emailBlock = input.recentEmails.length
    ? input.recentEmails
        .map(
          (e) => `- ${e.date} ${e.direction.toUpperCase()}: ${e.subject}`,
        )
        .join("\n")
    : "(no recent emails)";

  const ctxBlock = input.context.customerContext
    ? `\n\n## Customer-specific context (operator-curated)\n${input.context.customerContext}`
    : "";

  const user =
    `## Customer: ${input.customer.name}\n` +
    `Open balance: £${input.kpis.balance.toFixed(2)} ` +
    `(overdue: £${input.kpis.overdueBalance.toFixed(2)}, ` +
    `on hold: ${input.kpis.hasHold ? "yes" : "no"})\n\n` +
    `## Current autopilot candidates for this customer\n${candidatesBlock}\n\n` +
    `## Recent emails (last 5)\n${emailBlock}` +
    ctxBlock +
    `\n\nReturn JSON matching the schema. Summary in plain prose; ` +
    `actions cover only what's actually warranted right now.`;

  return { system, user };
}

const VALID_KINDS = new Set<CardAction["kind"]>([
  "send_chase_email",
  "send_statement",
  "send_check_in_email",
  "view_rma",
  "view_cron_failure",
]);

// Strip a fenced ```json ... ``` wrapper if present, plus trim. Models
// sometimes ignore "JSON only" and wrap.
function unfence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence?.[1]?.trim() ?? trimmed;
}

export function parseCardResponse(raw: string): CustomerCardData {
  try {
    const parsed = JSON.parse(unfence(raw)) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "summary" in parsed &&
      "actions" in parsed
    ) {
      const p = parsed as { summary: unknown; actions: unknown };
      if (typeof p.summary === "string" && Array.isArray(p.actions)) {
        const actions: CardAction[] = [];
        for (const a of p.actions) {
          if (
            typeof a === "object" &&
            a !== null &&
            "kind" in a &&
            "label" in a
          ) {
            const aa = a as {
              kind: unknown;
              label: unknown;
              args?: unknown;
            };
            if (
              typeof aa.kind === "string" &&
              typeof aa.label === "string" &&
              VALID_KINDS.has(aa.kind as CardAction["kind"])
            ) {
              const args =
                typeof aa.args === "object" && aa.args !== null
                  ? (aa.args as Record<string, unknown>)
                  : {};
              actions.push({
                kind: aa.kind as CardAction["kind"],
                label: aa.label,
                args,
              });
            }
          }
        }
        return { summary: p.summary, actions };
      }
    }
  } catch {
    // fall through
  }
  return {
    summary: "AI summary unavailable — try Regenerate.",
    actions: [],
  };
}

export type CardResult = {
  data: CustomerCardData;
  isStale: boolean;
  generatedAt: Date;
};

export async function getCustomerCard(
  customerId: string,
): Promise<CardResult | null> {
  const rows = await db
    .select()
    .from(customerAiCards)
    .where(eq(customerAiCards.customerId, customerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const ageHours =
    (Date.now() - row.generatedAt.getTime()) / (1000 * 60 * 60);
  return {
    data: { summary: row.summary, actions: row.actions },
    isStale: ageHours > CACHE_TTL_HOURS,
    generatedAt: row.generatedAt,
  };
}

export async function generateCustomerCard(
  customerId: string,
  opts: { force?: boolean } = {},
): Promise<CardResult> {
  const cRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const customer = cRows[0];
  if (!customer) throw new Error(`customer not found: ${customerId}`);

  const [chase, coldEm, statementEm, rmaStall, cronFail] = await Promise.all([
    findChaseNext(customerId),
    findCadenceCold(customerId),
    findCadenceStatement(customerId),
    findOpsRmaStalled(customerId),
    findOpsCronFail(customerId),
  ]);

  const candidates: CardCandidate[] = [
    ...chase.map((c) => ({ ...c, category: "chase_next" })),
    ...coldEm.map((c) => ({ ...c, category: "cadence_cold" })),
    ...statementEm.map((c) => ({ ...c, category: "cadence_statement" })),
    ...rmaStall.map((c) => ({ ...c, category: "ops_rma_stalled" })),
    ...cronFail.map((c) => ({ ...c, category: "ops_cron_fail" })),
  ];

  const emails = await db
    .select({
      direction: emailLog.direction,
      subject: emailLog.subject,
      emailDate: emailLog.emailDate,
    })
    .from(emailLog)
    .where(eq(emailLog.customerId, customerId))
    .orderBy(desc(emailLog.emailDate))
    .limit(5);

  // chase_next as the carrier category — globals are what we use, the
  // category-specific arrays go unused in buildCardPrompt.
  const ctx = await buildDraftContext("chase_next", {}, customerId);

  const prompt = buildCardPrompt({
    customer: { id: customer.id, name: customer.displayName },
    kpis: {
      balance: Number(customer.balance ?? 0),
      overdueBalance: Number(customer.overdueBalance ?? 0),
      hasHold: Boolean(
        customer.holdStatus && customer.holdStatus !== "active",
      ),
    },
    candidates,
    recentEmails: emails.map((e) => ({
      direction: e.direction,
      subject: e.subject ?? "(no subject)",
      date: e.emailDate.toISOString().slice(0, 10),
    })),
    context: ctx,
  });

  const client = getAnthropicClient();
  const start = Date.now();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  const tookMs = Date.now() - start;

  const textBlock = res.content.find((b) => b.type === "text");
  const raw =
    textBlock && textBlock.type === "text" && "text" in textBlock
      ? (textBlock as { text: string }).text
      : "";
  const data = parseCardResponse(raw);

  await trackUsage(res, { surface: "customer_summary" });

  const now = new Date();
  await db
    .insert(customerAiCards)
    .values({
      customerId,
      summary: data.summary,
      actions: data.actions,
      generatedAt: now,
      modelUsed: MODEL,
      tokensIn: res.usage?.input_tokens ?? 0,
      tokensOut: res.usage?.output_tokens ?? 0,
    })
    .onDuplicateKeyUpdate({
      set: {
        summary: data.summary,
        actions: data.actions,
        generatedAt: now,
        modelUsed: MODEL,
        tokensIn: res.usage?.input_tokens ?? 0,
        tokensOut: res.usage?.output_tokens ?? 0,
      },
    });

  log.info(
    { customerId, tookMs, force: opts.force ?? false, actions: data.actions.length },
    "customer card generated",
  );
  return { data, isStale: false, generatedAt: now };
}
