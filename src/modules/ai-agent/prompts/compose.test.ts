import { describe, it, expect } from "vitest";
import { composeSystem, composeCustomerBlock } from "../voice.js";
import type { DraftContext } from "../voice.js";

const base: DraftContext = {
  voiceGuide: "VG",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: null,
};

describe("composeSystem", () => {
  it("includes role + voice guide always", () => {
    const s = composeSystem("ROLE", base);
    expect(s).toContain("ROLE");
    expect(s).toContain("VG");
  });

  it("includes a facts section when facts exist, omits it otherwise", () => {
    expect(composeSystem("ROLE", base)).not.toContain("Things to know");
    const s = composeSystem("ROLE", {
      ...base,
      globalFacts: ["We close in August"],
      categoryFacts: ["Mention orders-on-hold"],
    });
    expect(s).toContain("Things to know about Feldart");
    expect(s).toContain("- We close in August");
    expect(s).toContain("- Mention orders-on-hold");
  });

  it("includes a corrections section when corrections exist", () => {
    const s = composeSystem("ROLE", {
      ...base,
      globalCorrections: ["Never say 'kindly'"],
    });
    expect(s).toContain("Style corrections to apply");
    expect(s).toContain("- Never say 'kindly'");
  });
});

describe("composeCustomerBlock", () => {
  it("returns empty string when no customer context", () => {
    expect(composeCustomerBlock(base)).toBe("");
  });
  it("renders the context when present", () => {
    const b = composeCustomerBlock({ ...base, customerContext: "Pays late" });
    expect(b).toContain("What we know about this customer");
    expect(b).toContain("Pays late");
  });
});
