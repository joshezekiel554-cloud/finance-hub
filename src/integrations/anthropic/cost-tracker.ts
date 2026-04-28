import { nanoid } from "nanoid";
import { db } from "~/db/index.js";
import { aiInteractions } from "~/db/schema/audit.js";
import { createLogger } from "~/lib/logger.js";
import type { AnthropicResponseWithUsage, AnthropicSurface } from "./types.js";

const log = createLogger({ module: "anthropic.cost-tracker" });

// Per-million-token rates in USD. Sonnet 4.6 has identical pricing to 4.5.
// Cache reads are ~10% of base input price; cache writes are ~1.25x base.
// Source: shared/prompt-caching.md (5-minute TTL: writes 1.25x, reads 0.1x).
type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
};

const SONNET_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

const OPUS_PRICING: ModelPricing = {
  inputPerMillion: 5.0,
  outputPerMillion: 25.0,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

export const PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": SONNET_PRICING,
  "claude-sonnet-4-5": SONNET_PRICING,
  "claude-sonnet-4-5-20250929": SONNET_PRICING,
  "claude-opus-4-7": OPUS_PRICING,
  "claude-opus-4-6": OPUS_PRICING,
};

export const DEFAULT_MODEL_FOR_PRICING = "claude-sonnet-4-6";

export type CostBreakdown = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

export type ToolCallRecord = {
  name: string;
  ok: boolean;
  durationMs?: number;
};

export function computeCost(
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): CostBreakdown {
  const pricing = PRICING[model] ?? PRICING[DEFAULT_MODEL_FOR_PRICING]!;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

  const inputRate = pricing.inputPerMillion / 1_000_000;
  const outputRate = pricing.outputPerMillion / 1_000_000;

  const cost =
    inputTokens * inputRate +
    outputTokens * outputRate +
    cacheReadTokens * inputRate * pricing.cacheReadMultiplier +
    cacheCreationTokens * inputRate * pricing.cacheWriteMultiplier;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: cost,
  };
}

export type TrackUsageOptions = {
  surface: AnthropicSurface;
  userId?: string | null;
  toolsCalled?: ToolCallRecord[];
};

// Async because the DB write is async. Callers that don't care about the row
// landing before they return can fire-and-forget; the catch keeps cost
// tracking from breaking the main flow on a transient DB error (matching 1.0).
export async function trackUsage(
  response: AnthropicResponseWithUsage,
  options: TrackUsageOptions,
): Promise<CostBreakdown | null> {
  const usage = response.usage;
  if (!usage) return null;

  const model = response.model ?? DEFAULT_MODEL_FOR_PRICING;
  const breakdown = computeCost(model, usage);

  log.debug(
    {
      surface: options.surface,
      model,
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      cacheReadTokens: breakdown.cacheReadTokens,
      cacheCreationTokens: breakdown.cacheCreationTokens,
      costUsd: breakdown.costUsd,
    },
    "anthropic.usage",
  );

  try {
    await db.insert(aiInteractions).values({
      id: nanoid(24),
      surface: options.surface,
      model,
      userId: options.userId ?? null,
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      cacheReadTokens: breakdown.cacheReadTokens,
      cacheCreationTokens: breakdown.cacheCreationTokens,
      costUsd: breakdown.costUsd.toFixed(6),
      toolsCalled: options.toolsCalled ?? null,
    });
  } catch (err) {
    log.error(
      { err, surface: options.surface },
      "Failed to record ai_interactions row",
    );
  }

  return breakdown;
}
