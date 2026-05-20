import { describe, it, expect } from "vitest";
import { buildSeedPrompt } from "./voice-seed.js";

describe("buildSeedPrompt", () => {
  it("includes template bodies and outbound email bodies", () => {
    const prompt = buildSeedPrompt(
      [{ slug: "chase_l1", body: "TEMPLATE_BODY_1" }],
      ["EMAIL_BODY_1", "EMAIL_BODY_2"],
    );
    expect(prompt).toContain("TEMPLATE_BODY_1");
    expect(prompt).toContain("EMAIL_BODY_1");
    expect(prompt).toContain("EMAIL_BODY_2");
  });

  it("instructs a concise prose guide under 600 words", () => {
    const prompt = buildSeedPrompt([], []);
    expect(prompt.toLowerCase()).toContain("voice");
    expect(prompt).toContain("600");
  });
});
