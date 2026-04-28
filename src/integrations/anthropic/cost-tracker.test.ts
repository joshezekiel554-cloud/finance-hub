import { describe, expect, it } from "vitest";
import { PRICING, computeCost } from "./cost-tracker.js";

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-7";
const UNKNOWN = "claude-mystery-model-9000";

describe("computeCost — Sonnet 4.6", () => {
  it("computes input + output cost for a basic call", () => {
    const cost = computeCost(SONNET, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // 1M @ $3 input + 1M @ $15 output = $18
    expect(cost.costUsd).toBeCloseTo(18.0, 6);
    expect(cost.inputTokens).toBe(1_000_000);
    expect(cost.outputTokens).toBe(1_000_000);
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheCreationTokens).toBe(0);
  });

  it("scales linearly for small token counts", () => {
    const cost = computeCost(SONNET, {
      input_tokens: 1000,
      output_tokens: 200,
    });
    // 1000 input @ $3/M = $0.003; 200 output @ $15/M = $0.003
    expect(cost.costUsd).toBeCloseTo(0.006, 8);
  });

  it("treats cache reads at ~10% of base input rate", () => {
    const cost = computeCost(SONNET, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    // 1M cache reads @ $3/M * 0.1 = $0.30
    expect(cost.costUsd).toBeCloseTo(0.3, 6);
    expect(cost.cacheReadTokens).toBe(1_000_000);
  });

  it("treats cache writes at ~125% of base input rate", () => {
    const cost = computeCost(SONNET, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    // 1M cache writes @ $3/M * 1.25 = $3.75
    expect(cost.costUsd).toBeCloseTo(3.75, 6);
    expect(cost.cacheCreationTokens).toBe(1_000_000);
  });

  it("composes input + output + cache reads + cache writes", () => {
    const cost = computeCost(SONNET, {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 50_000,
    });
    // 100k * $3/M = $0.30
    // 50k * $15/M = $0.75
    // 200k * $3/M * 0.1 = $0.06
    // 50k * $3/M * 1.25 = $0.1875
    // total = $1.2975
    expect(cost.costUsd).toBeCloseTo(1.2975, 6);
  });
});

describe("computeCost — Opus 4.7", () => {
  it("uses higher Opus rates", () => {
    const cost = computeCost(OPUS, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // 1M @ $5 input + 1M @ $25 output = $30
    expect(cost.costUsd).toBeCloseTo(30.0, 6);
  });

  it("Opus cache reads honor the same 10% multiplier on Opus input rate", () => {
    const cost = computeCost(OPUS, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    // 1M @ $5/M * 0.1 = $0.50
    expect(cost.costUsd).toBeCloseTo(0.5, 6);
  });
});

describe("computeCost — unknown model fallback", () => {
  it("falls back to Sonnet 4.6 pricing for unknown models", () => {
    const cost = computeCost(UNKNOWN, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // Same as Sonnet 4.6: $18
    expect(cost.costUsd).toBeCloseTo(18.0, 6);
  });
});

describe("computeCost — zero / missing usage fields", () => {
  it("returns zero cost for empty usage", () => {
    const cost = computeCost(SONNET, {});
    expect(cost.costUsd).toBe(0);
    expect(cost.inputTokens).toBe(0);
    expect(cost.outputTokens).toBe(0);
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheCreationTokens).toBe(0);
  });

  it("treats missing cache fields as zero, not NaN", () => {
    const cost = computeCost(SONNET, {
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(Number.isFinite(cost.costUsd)).toBe(true);
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheCreationTokens).toBe(0);
  });
});

describe("PRICING table", () => {
  it("contains entries for the canonical models the brief calls out", () => {
    expect(PRICING).toHaveProperty("claude-sonnet-4-6");
    expect(PRICING).toHaveProperty("claude-sonnet-4-5");
    expect(PRICING).toHaveProperty("claude-opus-4-7");
  });

  it("Sonnet 4.5 and 4.6 carry identical pricing (per the brief — same rates)", () => {
    expect(PRICING["claude-sonnet-4-5"]).toEqual(PRICING["claude-sonnet-4-6"]);
  });

  it("Opus pricing is more expensive than Sonnet on input + output", () => {
    const sonnet = PRICING["claude-sonnet-4-6"]!;
    const opus = PRICING["claude-opus-4-7"]!;
    expect(opus.inputPerMillion).toBeGreaterThan(sonnet.inputPerMillion);
    expect(opus.outputPerMillion).toBeGreaterThan(sonnet.outputPerMillion);
  });
});
