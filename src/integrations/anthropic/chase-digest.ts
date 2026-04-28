import { getAnthropicClient, isConfigured } from "./client.js";
import { trackUsage } from "./cost-tracker.js";
import {
  CHASE_DIGEST_PROMPT,
  buildChaseDigestUserPrompt,
} from "./prompts.js";
import type {
  AnthropicResponseWithUsage,
  ChaseAccount,
} from "./types.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4000;

export type ChaseDigestResult = {
  digest: string | null;
  error: string | null;
};

export type GenerateChaseDigestOptions = {
  userId?: string | null;
};

export async function generateChaseDigest(
  accounts: ChaseAccount[],
  options: GenerateChaseDigestOptions = {},
): Promise<ChaseDigestResult> {
  if (!isConfigured()) {
    return {
      digest: null,
      error: "Anthropic API key not configured. Set ANTHROPIC_API_KEY in env.",
    };
  }
  if (!accounts || accounts.length === 0) {
    return { digest: null, error: "No accounts provided" };
  }

  const client = getAnthropicClient();

  try {
    // Prompt caching: the chase prompt is the only stable prefix here (the
    // user message — today's account list — varies every run). Cache the
    // system block at 1h TTL so the cron's daily-and-on-demand cadence keeps
    // hitting the cache. See shared/prompt-caching.md → "Large system prompt
    // shared across many requests" + 1h economics (>=3 reads to break even).
    //
    // Adaptive thinking + effort=medium: matches 1.0's chase digest. SDK
    // 0.30.x doesn't type these fields; the cast lets them pass through to
    // the API. claude-api skill confirms thinking:{type:'adaptive'} +
    // output_config:{effort:'medium'} as the canonical 4.6 syntax.
    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: CHASE_DIGEST_PROMPT,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildChaseDigestUserPrompt(accounts),
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    } as unknown as Parameters<typeof client.messages.create>[0])) as unknown as AnthropicResponseWithUsage;

    void trackUsage(response, {
      surface: "chase_digest",
      userId: options.userId,
    });

    const digest = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    return { digest, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { digest: null, error: `Digest generation failed: ${message}` };
  }
}
