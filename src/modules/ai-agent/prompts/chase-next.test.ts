import { describe, it, expect } from "vitest";
import { buildPrompt } from "./chase-next.js";
import type { DraftContext } from "../voice.js";

const ctx: DraftContext = {
  voiceGuide: "VOICE_GUIDE_MARKER",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: "EXAMPLE_TEMPLATE_MARKER",
};

const summary = {
  customerId: "c1",
  customerName: "On The Table NJ",
  overdueBalance: 1234.5,
  daysOverdue: 45,
  tier: "CRITICAL",
  lastChaseAt: null,
};

describe("chase-next buildPrompt", () => {
  it("puts role + voice guide in system", () => {
    const { system } = buildPrompt(summary, ctx);
    expect(system).toContain("VOICE_GUIDE_MARKER");
    expect(system).toContain("Feldart");
  });

  it("puts the situation + example in user, not system", () => {
    const { system, user } = buildPrompt(summary, ctx);
    expect(user).toContain("On The Table NJ");
    expect(user).toContain("EXAMPLE_TEMPLATE_MARKER");
    expect(system).not.toContain("EXAMPLE_TEMPLATE_MARKER");
  });

  it("omits the example block when exampleTemplate is null", () => {
    const { user } = buildPrompt(summary, { ...ctx, exampleTemplate: null });
    expect(user).not.toContain("EXAMPLE_TEMPLATE_MARKER");
    expect(user).not.toContain("Reference email to match");
  });

  it("includes facts in system and customer context in user", () => {
    const { system, user } = buildPrompt(summary, {
      ...ctx,
      globalFacts: ["GLOBAL_FACT_MARKER"],
      customerContext: "CUSTOMER_CTX_MARKER",
    });
    expect(system).toContain("GLOBAL_FACT_MARKER");
    expect(user).toContain("CUSTOMER_CTX_MARKER");
  });
});
