import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";
import { emailLog } from "../../db/schema/crm.js";
import { aiLearnedCorrections } from "../../db/schema/ai-learned-corrections.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "ai-agent.corrections" });
const SONNET = "claude-sonnet-4-6";
const MIN_EDITED_PAIRS = 3; // cold-start guard

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type RawPair = {
  category: string;
  draftBody: string | null;
  sentBody: string | null;
  proposalId?: string;
};
export type EditedPair = {
  category: string;
  draft: string;
  sent: string;
  proposalId?: string;
};

// Keep only pairs that were actually sent AND meaningfully edited (stripped
// text differs). Trivial/whitespace-only diffs are dropped.
export function pairsWithEdits(rows: RawPair[]): EditedPair[] {
  const out: EditedPair[] = [];
  for (const r of rows) {
    if (!r.draftBody || !r.sentBody) continue;
    const draft = stripHtml(r.draftBody);
    const sent = stripHtml(r.sentBody);
    if (!draft || !sent) continue;
    if (draft === sent) continue;
    out.push({ category: r.category, draft, sent, proposalId: r.proposalId });
  }
  return out;
}

export function buildDistillPrompt(
  pairs: Array<{ category: string; draft: string; sent: string }>,
): string {
  const body = pairs
    .map(
      (p, i) =>
        `### Pair ${i + 1} (${p.category})\nAI DRAFT:\n${p.draft}\n\nOPERATOR SENT:\n${p.sent}`,
    )
    .join("\n\n");
  return `You are analysing how a Feldart accounts operator edits AI-drafted emails before sending, to learn their style.

For each pair below, compare the AI draft to what the operator actually sent. Identify ONLY recurring, stylistic/structural corrections the operator consistently makes — tone, phrasing, sign-offs, structure, things they add or remove.

STRICT rules:
- IGNORE one-off factual edits (a changed name, number, date, invoice id, or customer-specific detail). Those are not style lessons.
- Only output a correction if the pattern appears across MULTIPLE pairs (recurring). If nothing recurs, output an empty list.
- Each correction is a short imperative instruction a writer could follow.

Output STRICT JSON only, no prose:
{"corrections": [{"text": "<imperative correction>", "tags": ["global"]}]}
Use tag "global" for general style, or a category slug ("chase_next", "cadence_cold") if the correction is specific to that draft type.

## Draft-vs-sent pairs
${body}`;
}

type DistillResult = { proposed: number; reason?: string };

export async function runCorrectionsDistill(
  userId: string | null,
): Promise<DistillResult> {
  // Fetch recent executed chase/cold proposals + their sent email body.
  const rows = await db
    .select({
      proposalId: aiProposals.id,
      category: aiProposals.category,
      draftedAction: aiProposals.draftedAction,
      sentBody: emailLog.bodyHtml,
      sentPlain: emailLog.body,
    })
    .from(aiProposals)
    .leftJoin(emailLog, eq(emailLog.aiProposalId, aiProposals.id))
    .where(
      and(
        eq(aiProposals.status, "executed"),
        isNotNull(aiProposals.draftedAction),
        inArray(aiProposals.category, ["chase_next", "cadence_cold"]),
      ),
    )
    .orderBy(desc(aiProposals.executedAt))
    .limit(50);

  const raw: RawPair[] = rows.map((r) => {
    const action = r.draftedAction as
      | { tool: string; args: Record<string, unknown> }
      | null;
    const draftBody =
      action && typeof action.args.body === "string"
        ? (action.args.body as string)
        : null;
    return {
      category: r.category,
      draftBody,
      sentBody: (r.sentBody ?? r.sentPlain) as string | null,
      proposalId: r.proposalId,
    };
  });

  const edited = pairsWithEdits(raw);
  if (edited.length < MIN_EDITED_PAIRS) {
    return { proposed: 0, reason: "not enough edited drafts yet" };
  }

  const prompt = buildDistillPrompt(
    edited.map((e) => ({ category: e.category, draft: e.draft, sent: e.sent })),
  );
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: SONNET,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  await trackUsage(response, { surface: "background_proposing", userId });

  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();

  let parsed: { corrections?: Array<{ text?: string; tags?: string[] }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn({ text: text.slice(0, 200) }, "distill: non-JSON response");
    return { proposed: 0, reason: "model did not return JSON" };
  }
  const corrections = (parsed.corrections ?? []).filter(
    (c) => typeof c.text === "string" && c.text.trim().length > 0,
  );
  if (corrections.length === 0)
    return { proposed: 0, reason: "no recurring patterns" };

  const sourceIds = edited
    .map((e) => e.proposalId)
    .filter((x): x is string => Boolean(x));
  for (const c of corrections) {
    await db.insert(aiLearnedCorrections).values({
      id: nanoid(24),
      correction: c.text!.trim(),
      tags: Array.isArray(c.tags) && c.tags.length > 0 ? c.tags : ["global"],
      status: "proposed",
      sourceProposalIds: sourceIds,
    });
  }
  log.info({ proposed: corrections.length }, "corrections distilled");
  return { proposed: corrections.length };
}
