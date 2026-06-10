import { describe, it, expect } from "vitest";
import { buildPrompt, TOOL_NAME } from "./tj-chase.js";
import type { DraftContext } from "../voice.js";

const ctx: DraftContext = {
  voiceGuide: "VOICE_GUIDE_MARKER",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: "TJ_TEMPLATE_MARKER",
};

const summary = {
  customerId: "c1",
  customerName: "Legacy Judaica Shop",
  overdueBalance: 2345.67,
  daysOverdue: 130,
  tier: "HIGH",
  lastChaseAt: null,
};

describe("tj-chase buildPrompt", () => {
  it("reuses the chase send tool", () => {
    expect(TOOL_NAME).toBe("send_chase_email");
  });

  it("puts role + voice guide in system, framed as the Torah Judaica book", () => {
    const { system } = buildPrompt(summary, ctx);
    expect(system).toContain("VOICE_GUIDE_MARKER");
    expect(system).toContain("Torah Judaica");
  });

  it("puts the situation + tj_l template example in user, not system", () => {
    const { system, user } = buildPrompt(summary, ctx);
    expect(user).toContain("Legacy Judaica Shop");
    expect(user).toContain("TJ_TEMPLATE_MARKER");
    expect(system).not.toContain("TJ_TEMPLATE_MARKER");
  });

  it("instructs the tool call to carry origin 'tj'", () => {
    const { user } = buildPrompt(summary, ctx);
    expect(user).toContain(`origin: "tj"`);
    expect(user).toContain(`customerId: "c1"`);
    expect(user).toContain(`tier: "HIGH"`);
  });

  it("omits the example block when exampleTemplate is null", () => {
    const { user } = buildPrompt(summary, { ...ctx, exampleTemplate: null });
    expect(user).not.toContain("TJ_TEMPLATE_MARKER");
    expect(user).not.toContain("Reference email to match");
  });

  it("includes customer context in user when present", () => {
    const { user } = buildPrompt(summary, {
      ...ctx,
      customerContext: "CUSTOMER_CTX_MARKER",
    });
    expect(user).toContain("CUSTOMER_CTX_MARKER");
  });
});
