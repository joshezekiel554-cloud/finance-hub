import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import type { AiProposalCategory } from "../../db/schema/ai-proposals.js";

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
  _customerId: string | null,
): Promise<DraftContext> {
  const guideRows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_voice_guide"))
    .limit(1);
  const stored = guideRows[0]?.value;
  const voiceGuide =
    stored && stored.trim().length > 0 ? stored : DEFAULT_VOICE_GUIDE;

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
    globalFacts: [],
    categoryFacts: [],
    globalCorrections: [],
    categoryCorrections: [],
    customerContext: null, // Wave B (#4) populates from customers.ai_customer_context
    exampleTemplate,
  };
}
