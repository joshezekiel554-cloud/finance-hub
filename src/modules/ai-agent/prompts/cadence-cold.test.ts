import { describe, it, expect } from "vitest";
import { buildPrompt as buildCold } from "./cadence-cold.js";
import { buildPrompt as buildStatement } from "./cadence-statement.js";
import type { DraftContext } from "../voice.js";

const ctx: DraftContext = {
  voiceGuide: "VOICE_MARK",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: null,
};

describe("cadence builders", () => {
  it("cold: voice in system, customer in user", () => {
    const { system, user } = buildCold(
      {
        customerName: "Acme",
        openBalance: 500,
        daysSinceLastPayment: 60,
        daysSinceLastContact: 30,
      },
      ctx,
    );
    expect(system).toContain("VOICE_MARK");
    expect(user).toContain("Acme");
  });

  it("statement: voice in system, customer in user", () => {
    const { system, user } = buildStatement(
      {
        customerName: "Acme",
        openInvoiceCount: 3,
        totalOpenBalance: 900,
        lastStatementSentAt: null,
        daysSinceLastStatement: 99999,
      },
      ctx,
    );
    expect(system).toContain("VOICE_MARK");
    expect(user).toContain("Acme");
  });

  it("cold: facts in system, customer context in user", () => {
    const { system, user } = buildCold(
      {
        customerName: "Acme",
        openBalance: 500,
        daysSinceLastPayment: 60,
        daysSinceLastContact: 30,
      },
      { ...ctx, globalFacts: ["GLOBAL_FACT_MARKER"], customerContext: "CUSTOMER_CTX_MARKER" },
    );
    expect(system).toContain("GLOBAL_FACT_MARKER");
    expect(user).toContain("CUSTOMER_CTX_MARKER");
  });
});
