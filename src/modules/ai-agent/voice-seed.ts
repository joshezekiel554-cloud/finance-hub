import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import { emailLog } from "../../db/schema/crm.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "ai-agent.voice-seed" });
const SONNET = "claude-sonnet-4-6";

// Pure: assemble the distillation prompt from real Feldart content.
export function buildSeedPrompt(
  templates: Array<{ slug: string; body: string }>,
  emailBodies: string[],
): string {
  const tpl = templates
    .map((t) => `### Template: ${t.slug}\n${t.body}`)
    .join("\n\n");
  const mails = emailBodies
    .map((b, i) => `### Sent email ${i + 1}\n${b}`)
    .join("\n\n");
  return `Distill a concise voice/style guide from these real Feldart accounts emails and templates.

Capture: tone, common phrasings, sign-offs, sentence length, formality, and things they always/never do. Output the guide as prose (no preamble, no headings list), under 600 words. Write it as instructions a writer could follow to sound like Feldart.

## Templates
${tpl || "(none)"}

## Recent sent emails
${mails || "(none)"}`;
}

// Side-effecting: gather inputs, call the model, upsert the guide.
export async function runVoiceGuideSeed(
  userId: string | null,
): Promise<{ words: number }> {
  const templates = await db
    .select({ slug: emailTemplates.slug, body: emailTemplates.body })
    .from(emailTemplates);
  const emails = await db
    .select({ body: emailLog.body })
    .from(emailLog)
    .where(and(eq(emailLog.direction, "outbound"), isNotNull(emailLog.body)))
    .orderBy(desc(emailLog.emailDate))
    .limit(30);
  const emailBodies = emails
    .map((e) => e.body ?? "")
    .filter((b) => b.length > 0);

  const prompt = buildSeedPrompt(templates, emailBodies);
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

  const existing = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_voice_guide"))
    .limit(1);
  if (existing[0]) {
    await db
      .update(appSettings)
      .set({
        value: text,
        updatedByUserId: userId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(appSettings.key, "ai_voice_guide"));
  } else {
    await db.insert(appSettings).values({
      key: "ai_voice_guide",
      value: text,
      updatedByUserId: userId,
    });
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  log.info({ words }, "voice guide seeded");
  return { words };
}
