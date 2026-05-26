import { describe, it, expect } from "vitest";
import {
  buildCardPrompt,
  parseCardResponse,
  type CardPromptInput,
} from "./customer-card.js";

const baseContext: CardPromptInput["context"] = {
  voiceGuide: "VOICE",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: null,
};

describe("buildCardPrompt", () => {
  it("includes voice, customer name, candidate findings, and JSON instruction", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { balance: 1200, overdueBalance: 800, hasHold: false },
      candidates: [
        {
          category: "chase_next",
          entityType: "customer",
          entityId: "c1",
          summary: { tier: "HIGH", invoice: "INV-1" },
        },
      ],
      recentEmails: [],
      context: baseContext,
    });
    expect(out.system).toContain("VOICE");
    expect(out.user).toContain("Acme Ltd");
    expect(out.user).toContain("chase_next");
    expect(out.user.toLowerCase()).toContain("json");
  });

  it("includes the per-customer AI context line when present", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { balance: 0, overdueBalance: 0, hasHold: false },
      candidates: [],
      recentEmails: [],
      context: { ...baseContext, customerContext: "Pays late, key contact = Sarah" },
    });
    expect(out.user).toContain("Pays late, key contact = Sarah");
  });

  it("renders 'no autopilot candidates' line when the list is empty", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Quiet Co" },
      kpis: { balance: 0, overdueBalance: 0, hasHold: false },
      candidates: [],
      recentEmails: [],
      context: baseContext,
    });
    expect(out.user.toLowerCase()).toContain("no autopilot candidates");
  });
});

describe("parseCardResponse", () => {
  it("parses a valid JSON response into typed card data", () => {
    const raw = JSON.stringify({
      summary: "Acme is 47d overdue on INV-1.",
      actions: [
        {
          kind: "send_chase_email",
          label: "Send chase L3 (INV-1)",
          args: { tier: "CRITICAL", invoiceId: "INV-1" },
        },
      ],
    });
    const out = parseCardResponse(raw);
    expect(out.summary).toBe("Acme is 47d overdue on INV-1.");
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]?.kind).toBe("send_chase_email");
    expect(out.actions[0]?.args.invoiceId).toBe("INV-1");
  });

  it("returns a safe fallback on malformed JSON", () => {
    const out = parseCardResponse("not json at all");
    expect(out.summary).toMatch(/unavailable|failed/i);
    expect(out.actions).toEqual([]);
  });

  it("drops actions with invalid shape but keeps valid ones", () => {
    const raw = JSON.stringify({
      summary: "S",
      actions: [
        { kind: "send_chase_email", label: "Good", args: {} },
        { kind: 123 }, // invalid: kind not string + no label
        { kind: "view_rma", label: "RMA-9", args: { rmaId: "rma9" } },
      ],
    });
    const out = parseCardResponse(raw);
    expect(out.actions).toHaveLength(2);
    expect(out.actions.map((a) => a.kind)).toEqual([
      "send_chase_email",
      "view_rma",
    ]);
  });

  it("tolerates a fenced code block around the JSON", () => {
    const raw = "```json\n" + JSON.stringify({ summary: "S", actions: [] }) + "\n```";
    const out = parseCardResponse(raw);
    expect(out.summary).toBe("S");
  });
});
