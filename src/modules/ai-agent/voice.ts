import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import type { AiProposalCategory } from "../../db/schema/ai-proposals.js";
import { customers } from "../../db/schema/customers.js";
import {
  aiCompanyFacts,
  FACT_TAG_GLOBAL,
} from "../../db/schema/ai-company-facts.js";

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

function exampleSlugFor(
  category: AiProposalCategory,
  summary: Record<string, unknown>,
): string | null {
  if (category === "chase_next") {
    const tier = String(summary.tier ?? "");
    return CHASE_TIER_SLUG[tier] ?? null;
  }
  // cadence_cold (no check-in template), cadence_statement, ops_* -> none.
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

  // 3. per-customer context (#4)
  let customerContext: string | null = null;
  if (customerId) {
    const cRows = await db
      .select({ ctx: customers.aiCustomerContext })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const v = cRows[0]?.ctx;
    customerContext = v && v.trim().length > 0 ? v : null;
  }

  // 4. example template
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
    globalCorrections: [], // Wave C (#2) populates
    categoryCorrections: [], // Wave C (#2) populates
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
