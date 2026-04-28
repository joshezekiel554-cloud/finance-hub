import Anthropic from "@anthropic-ai/sdk";
import { env } from "~/lib/env.js";

let cached: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!cached) {
    cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return cached;
}

export function isConfigured(): boolean {
  return env.ANTHROPIC_API_KEY.length > 0;
}

// Test/dev hook — drop the singleton so the next getAnthropicClient() rebuilds
// with whatever env state is current. Used by the cost-tracker tests.
export function __resetAnthropicClient(): void {
  cached = null;
}
