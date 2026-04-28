import { getAnthropicClient, isConfigured } from "./client.js";
import { trackUsage } from "./cost-tracker.js";
import {
  ACTION_PLAN_PROMPT,
  buildActionPlanUserPrompt,
} from "./prompts.js";
import type {
  AnthropicResponseWithUsage,
  EmailContext,
  QbContext,
} from "./types.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 800;
const HARD_OUTPUT_CAP = 2000;

export type ActionPlanResult = {
  actionPlan: string | null;
  error: string | null;
};

export type GenerateActionPlanOptions = {
  userId?: string | null;
};

export async function generateActionPlan(
  customerName: string,
  emails: EmailContext[],
  qbData?: QbContext | null,
  options: GenerateActionPlanOptions = {},
): Promise<ActionPlanResult> {
  if (!isConfigured()) {
    return {
      actionPlan: null,
      error:
        "Anthropic API key not configured. Set ANTHROPIC_API_KEY in env.",
    };
  }
  if (!emails || emails.length === 0) {
    return { actionPlan: null, error: "No emails provided" };
  }

  const client = getAnthropicClient();

  try {
    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: ACTION_PLAN_PROMPT,
      messages: [
        {
          role: "user",
          content: buildActionPlanUserPrompt(customerName, emails, qbData),
        },
      ],
    } as Parameters<typeof client.messages.create>[0])) as unknown as AnthropicResponseWithUsage;

    void trackUsage(response, {
      surface: "action_plan",
      userId: options.userId,
    });

    let actionPlan = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    if (actionPlan.length > HARD_OUTPUT_CAP) {
      actionPlan = actionPlan.substring(0, HARD_OUTPUT_CAP - 3) + "...";
    }

    return { actionPlan, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      actionPlan: null,
      error: `Action plan generation failed: ${message}`,
    };
  }
}
