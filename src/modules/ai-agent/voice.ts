import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import type { AiProposalCategory } from "../../db/schema/ai-proposals.js";
import { customers } from "../../db/schema/customers.js";
import { activities, emailLog } from "../../db/schema/crm.js";
import { fenceUntrusted } from "../agent/context.js";
import {
  aiCompanyFacts,
  FACT_TAG_GLOBAL,
} from "../../db/schema/ai-company-facts.js";
import { aiLearnedCorrections } from "../../db/schema/ai-learned-corrections.js";

// Baked-in fallback so drafts have a Feldart voice before the operator
// seeds/customizes app_settings.ai_voice_guide.
export const DEFAULT_VOICE_GUIDE = `Feldart is a family-run trade supplier. Our accounts team writes to customers directly, in the first person plural ("we"), as real people who know the account.

Tone: warm, direct, professional. Friendly but not chatty; firm when needed but never aggressive. Assume good faith — most late payments are oversights, not bad actors. Match the seriousness of the situation: a first reminder is light and assumes the invoice slipped through; an escalation is clear and states consequences plainly, without threats or legal language.

Phrasing: plain British business English. Short paragraphs (2-4 sentences). No marketing language, no buzzwords, no exclamation marks. Reference specific invoice numbers and amounts. Always give the customer a clear, easy next step (a reply, a payment date, a call).

Sign-off: close warmly and sign as "The Feldart Accounts Team". The signature block is appended automatically — do not add one. Avoid "Dear Sir/Madam"; use the contact's name or a simple "Hello".

Never: threaten legal action unless explicitly escalated, use guilt or passive-aggression, send a wall of text, or invent facts about the account.`;

// Resolved context fed into a draft. Wave A populates voiceGuide +
// exampleTemplate; the array fields and customerContext are filled by
// Wave B (#3 facts, #4 per-customer) and Wave C (#2 corrections).
export type DraftContext = {
  voiceGuide: string;
  globalFacts: string[];
  categoryFacts: string[];
  globalCorrections: string[];
  categoryCorrections: string[];
  customerContext: string | null;
  exampleTemplate: string | null;
};

// What every prompt builder returns. `system` is the cacheable prefix
// (role + voice guide, later + facts/corrections); `user` varies per
// candidate. Empty `system` => the endpoint sends no system block.
export type BuiltPrompt = { system: string; user: string };

const CHASE_TIER_SLUG: Record<string, string> = {
  MEDIUM: "chase_l1",
  HIGH: "chase_l2",
  CRITICAL: "chase_l3",
};

// Same ladder for the Torah Judaica book — tj_chase drafts reference the
// tj_l1/2/3 templates (seeded by scripts/seed-email-templates.ts) instead of
// the Feldart chase_l* set.
const TJ_CHASE_TIER_SLUG: Record<string, string> = {
  MEDIUM: "tj_l1",
  HIGH: "tj_l2",
  CRITICAL: "tj_l3",
};

function exampleSlugFor(
  category: AiProposalCategory,
  summary: Record<string, unknown>,
): string | null {
  if (category === "chase_next") {
    const tier = String(summary.tier ?? "");
    return CHASE_TIER_SLUG[tier] ?? null;
  }
  if (category === "tj_chase") {
    const tier = String(summary.tier ?? "");
    return TJ_CHASE_TIER_SLUG[tier] ?? null;
  }
  // cadence_cold (no check-in template), cadence_statement, ops_*,
  // tj_dispute_nudge (bookkeeper email — no customer template) -> none.
  return null;
}

export async function buildDraftContext(
  category: AiProposalCategory,
  summary: Record<string, unknown>,
  customerId: string | null,
): Promise<DraftContext> {
  // 1. voice guide
  const guideRows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_voice_guide"))
    .limit(1);
  const stored = guideRows[0]?.value;
  const voiceGuide =
    stored && stored.trim().length > 0 ? stored : DEFAULT_VOICE_GUIDE;

  // 2. company facts (active), partitioned by tag
  const factRows = await db
    .select()
    .from(aiCompanyFacts)
    .where(eq(aiCompanyFacts.active, true));
  const globalFacts: string[] = [];
  const categoryFacts: string[] = [];
  for (const f of factRows) {
    const tags = f.tags ?? [];
    if (tags.includes(FACT_TAG_GLOBAL)) globalFacts.push(f.fact);
    else if (tags.includes(category)) categoryFacts.push(f.fact);
  }

  // 3. active learned corrections (#2), partitioned by tag
  const correctionRows = await db
    .select()
    .from(aiLearnedCorrections)
    .where(eq(aiLearnedCorrections.status, "active"));
  const globalCorrections: string[] = [];
  const categoryCorrections: string[] = [];
  for (const c of correctionRows) {
    const tags = c.tags ?? [];
    if (tags.includes(FACT_TAG_GLOBAL)) globalCorrections.push(c.correction);
    else if (tags.includes(category)) categoryCorrections.push(c.correction);
  }

  // 4. per-customer context (#4). The operator-authored AI context field is
  // the primary source; the legacy internal_notes column and the customer's
  // recent manual notes (the amber "Notes" card = manual_note activities) are
  // also folded in so the model has knowledge of everything the team has
  // recorded on the account — all operator-authored, so trusted.
  let customerContext: string | null = null;
  if (customerId) {
    const cRows = await db
      .select({
        ctx: customers.aiCustomerContext,
        notes: customers.internalNotes,
      })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const parts: string[] = [];
    const ctxVal = cRows[0]?.ctx;
    if (ctxVal && ctxVal.trim().length > 0) parts.push(ctxVal.trim());
    const notesVal = cRows[0]?.notes;
    if (notesVal && notesVal.trim().length > 0) {
      parts.push(`Internal notes: ${notesVal.trim()}`);
    }
    // Recent manual notes from the activity timeline, newest first. Capped so
    // a chatty account doesn't blow the prompt; the model gets the most
    // relevant recent context.
    const noteRows = await db
      .select({ body: activities.body })
      .from(activities)
      .where(
        and(
          eq(activities.customerId, customerId),
          eq(activities.kind, "manual_note"),
        ),
      )
      .orderBy(desc(activities.occurredAt))
      .limit(10);
    const noteBodies = noteRows
      .map((r) => r.body?.trim())
      .filter((b): b is string => !!b && b.length > 0);
    if (noteBodies.length > 0) {
      parts.push(
        `Operator notes (most recent first):\n${noteBodies
          .map((b) => `- ${b}`)
          .join("\n")}`,
      );
    }
    // Recent email history so the drafter knows what's actually been said on
    // the account (previously it saw NONE — only notes/facts). Customer text
    // is UNTRUSTED → the whole block is wrapped via fenceUntrusted so an
    // injected "ignore previous instructions" in an email body can't steer the
    // draft. Capped + body-snippet-truncated for the token budget; "all" isn't
    // feasible for the LLM, so this is the most-recent slice across the
    // customer's matched addresses.
    const emailRows = await db
      .select({
        direction: emailLog.direction,
        subject: emailLog.subject,
        body: emailLog.body,
        emailDate: emailLog.emailDate,
      })
      .from(emailLog)
      .where(eq(emailLog.customerId, customerId))
      .orderBy(desc(emailLog.emailDate))
      .limit(12);
    if (emailRows.length > 0) {
      const lines = emailRows.map((e) => {
        const date = e.emailDate
          ? new Date(e.emailDate).toISOString().slice(0, 10)
          : "????-??-??";
        const dir = e.direction === "outbound" ? "We wrote" : "They wrote";
        const subj = e.subject?.trim() || "(no subject)";
        const snippet = (e.body ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        return `[${date}] ${dir} — ${subj}${snippet ? `: ${snippet}` : ""}`;
      });
      parts.push(
        `Recent email history (most recent first):\n${fenceUntrusted(
          lines.join("\n"),
          "email",
        )}`,
      );
    }
    customerContext = parts.length > 0 ? parts.join("\n\n") : null;
  }

  // 5. example template
  let exampleTemplate: string | null = null;
  const slug = exampleSlugFor(category, summary);
  if (slug) {
    const tplRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, slug))
      .limit(1);
    exampleTemplate = tplRows[0]?.body ?? null;
  }

  return {
    voiceGuide,
    globalFacts,
    categoryFacts,
    globalCorrections,
    categoryCorrections,
    customerContext,
    exampleTemplate,
  };
}

// Assemble the system prompt: role + voice guide + facts + (Wave C)
// corrections. Centralised so builders don't hand-roll it and so Wave C's
// corrections slot in here without touching the builders.
export function composeSystem(roleIntro: string, context: DraftContext): string {
  const parts: string[] = [
    roleIntro,
    `## How Feldart writes\n${context.voiceGuide}`,
  ];
  const facts = [...context.globalFacts, ...context.categoryFacts];
  if (facts.length > 0) {
    parts.push(
      `## Things to know about Feldart\n${facts.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  const corrections = [
    ...context.globalCorrections,
    ...context.categoryCorrections,
  ];
  if (corrections.length > 0) {
    parts.push(
      `## Style corrections to apply\n${corrections
        .map((c) => `- ${c}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

// Per-customer block for the user message (empty when no context). Only the
// customer-facing builders include this; warehouse/internal builders pass a
// null-customerId context so this returns "".
export function composeCustomerBlock(context: DraftContext): string {
  if (!context.customerContext) return "";
  return `\n## What we know about this customer\n${context.customerContext}\n`;
}
