import { getAnthropicClient, isConfigured } from "./client.js";
import { trackUsage } from "./cost-tracker.js";
import {
  CUSTOMER_SUMMARY_PROMPT,
  buildCustomerSummaryUserPrompt,
} from "./prompts.js";
import type {
  AnthropicResponseWithUsage,
  EmailContext,
  QbContext,
} from "./types.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 800;
const HARD_OUTPUT_CAP = 2000;

export type CustomerSummaryResult = {
  summary: string | null;
  error: string | null;
};

export type GenerateCustomerSummaryOptions = {
  userId?: string | null;
};

export async function generateCustomerSummary(
  customerName: string,
  emails: EmailContext[],
  qbData?: QbContext | null,
  options: GenerateCustomerSummaryOptions = {},
): Promise<CustomerSummaryResult> {
  if (!isConfigured()) {
    return {
      summary: null,
      error:
        "Anthropic API key not configured. Set ANTHROPIC_API_KEY in env.",
    };
  }
  if (!emails || emails.length === 0) {
    return { summary: null, error: "No emails provided for summarization" };
  }

  const client = getAnthropicClient();

  try {
    // SDK 0.30.x doesn't type output_config or thinking, so cast through to
    // pass them. Runtime accepts them — this matches the API spec for
    // sonnet-4-6 (see shared/prompt-caching.md, claude-api skill).
    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: CUSTOMER_SUMMARY_PROMPT,
      messages: [
        {
          role: "user",
          content: buildCustomerSummaryUserPrompt(customerName, emails, qbData),
        },
      ],
    } as Parameters<typeof client.messages.create>[0])) as unknown as AnthropicResponseWithUsage;

    void trackUsage(response, {
      surface: "customer_summary",
      userId: options.userId,
    });

    let summary = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    if (summary.length > HARD_OUTPUT_CAP) {
      summary = summary.substring(0, HARD_OUTPUT_CAP - 3) + "...";
    }

    return { summary, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { summary: null, error: `AI summarization failed: ${message}` };
  }
}
