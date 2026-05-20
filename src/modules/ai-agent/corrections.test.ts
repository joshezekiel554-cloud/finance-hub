import { describe, it, expect } from "vitest";
import {
  stripHtml,
  pairsWithEdits,
  buildDistillPrompt,
} from "./corrections.js";

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello   <b>world</b></p>")).toBe("Hello world");
  });
});

describe("pairsWithEdits", () => {
  it("keeps only pairs where the sent text meaningfully differs from the draft", () => {
    const rows = [
      { category: "chase_next", draftBody: "<p>Pay now</p>", sentBody: "<p>Pay now</p>" }, // unchanged
      {
        category: "chase_next",
        draftBody: "<p>Pay now please</p>",
        sentBody: "<p>Could you settle this?</p>",
      }, // edited
      { category: "cadence_cold", draftBody: "<p>Hi</p>", sentBody: null }, // not sent yet
    ];
    const out = pairsWithEdits(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.category).toBe("chase_next");
  });
});

describe("buildDistillPrompt", () => {
  it("includes draft/sent pairs and demands recurring-only JSON output", () => {
    const prompt = buildDistillPrompt([
      { category: "chase_next", draft: "DRAFT_A", sent: "SENT_A" },
    ]);
    expect(prompt).toContain("DRAFT_A");
    expect(prompt).toContain("SENT_A");
    expect(prompt.toLowerCase()).toContain("recurring");
    expect(prompt.toLowerCase()).toContain("ignore");
    expect(prompt).toContain("corrections");
  });
});
