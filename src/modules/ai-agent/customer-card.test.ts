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

// Per-book figures fixture (osplit2 W2 T5): customer carries both books.
const bothBooks: NonNullable<CardPromptInput["books"]> = {
  feldart: {
    balance: 300,
    overdue: 300,
    openCount: 1,
    oldestOverdueDays: 30,
  },
  tj: {
    balance: 200,
    overdue: 120,
    openCount: 2,
    oldestOverdueDays: 45,
    verifyingCount: 1,
    disputes: [{ docNumber: "2-200", balance: 120, claimedAt: "2026-06-02" }],
  },
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
      recentCalls: [],
      context: baseContext,
    });
    expect(out.system).toContain("VOICE");
    expect(out.user).toContain("Acme Ltd");
    expect(out.user).toContain("chase_next");
    expect(out.user.toLowerCase()).toContain("json");
  });

  it("renders recent calls & texts (transcripts/SMS) in the prompt", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { balance: 0, overdueBalance: 0, hasHold: false },
      candidates: [],
      recentEmails: [],
      recentCalls: [
        {
          kind: "call_in",
          date: "2026-06-10",
          detail: "Asked about overdue invoice 1-100; promised to pay Friday.",
        },
        { kind: "sms_out", date: "2026-06-09", detail: "Payment reminder sent." },
      ],
      context: baseContext,
    });
    expect(out.user).toContain("Recent calls & texts");
    expect(out.user).toContain("CALL (inbound)");
    expect(out.user).toContain("promised to pay Friday");
    expect(out.user).toContain("TEXT (outbound)");
  });

  it("includes the per-customer AI context line when present", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { balance: 0, overdueBalance: 0, hasHold: false },
      candidates: [],
      recentEmails: [],
      recentCalls: [],
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
      recentCalls: [],
      context: baseContext,
    });
    expect(out.user.toLowerCase()).toContain("no autopilot candidates");
  });

  it("single-book: schema does NOT carry per-book summary fields", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { balance: 100, overdueBalance: 0, hasHold: false },
      candidates: [],
      recentEmails: [],
      recentCalls: [],
      context: baseContext,
    });
    expect(out.system).not.toContain("summary_feldart");
    expect(out.system).not.toContain("summary_tj");
  });

  it("both-books: user block separates the two books incl. dispute states", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { balance: 500, overdueBalance: 420, hasHold: false },
      candidates: [],
      recentEmails: [],
      recentCalls: [],
      context: baseContext,
      books: bothBooks,
    });
    expect(out.user).toContain("Feldart");
    expect(out.user).toContain("Torah Judaica");
    expect(out.user).toContain("2-200");
    expect(out.user).toContain("2026-06-02");
    expect(out.user.toLowerCase()).toContain("verif");
  });

  it("both-books: schema gains summary_feldart + summary_tj + action origin", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { balance: 500, overdueBalance: 420, hasHold: false },
      candidates: [],
      recentEmails: [],
      recentCalls: [],
      context: baseContext,
      books: bothBooks,
    });
    expect(out.system).toContain("summary_feldart");
    expect(out.system).toContain("summary_tj");
    expect(out.system).toContain('"origin"');
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

  it("single-book: per-book summaries stay null", () => {
    const out = parseCardResponse(
      JSON.stringify({ summary: "S", actions: [] }),
    );
    expect(out.summaryFeldart).toBeNull();
    expect(out.summaryTj).toBeNull();
  });

  it("perBook: parses summary_feldart + summary_tj alongside the overall summary", () => {
    const raw = JSON.stringify({
      summary: "Overall read.",
      summary_feldart: "Feldart read.",
      summary_tj: "TJ read.",
      actions: [],
    });
    const out = parseCardResponse(raw, { perBook: true, allowTj: true });
    expect(out.summary).toBe("Overall read.");
    expect(out.summaryFeldart).toBe("Feldart read.");
    expect(out.summaryTj).toBe("TJ read.");
  });

  it("perBook: synthesizes the NOT NULL summary when the model omits it", () => {
    const raw = JSON.stringify({
      summary_feldart: "Feldart read.",
      summary_tj: "TJ read.",
      actions: [],
    });
    const out = parseCardResponse(raw, { perBook: true, allowTj: true });
    expect(out.summaryFeldart).toBe("Feldart read.");
    expect(out.summaryTj).toBe("TJ read.");
    expect(out.summary).toContain("Feldart read.");
    expect(out.summary).toContain("TJ read.");
  });

  it("perBook: a lone per-book field falls back to blended summary only", () => {
    const raw = JSON.stringify({
      summary: "Blended.",
      summary_feldart: "Feldart only.",
      actions: [],
    });
    const out = parseCardResponse(raw, { perBook: true, allowTj: true });
    expect(out.summary).toBe("Blended.");
    expect(out.summaryFeldart).toBeNull();
    expect(out.summaryTj).toBeNull();
  });

  it("ignores per-book fields when not in perBook mode", () => {
    const raw = JSON.stringify({
      summary: "S",
      summary_feldart: "F",
      summary_tj: "T",
      actions: [],
    });
    const out = parseCardResponse(raw);
    expect(out.summaryFeldart).toBeNull();
    expect(out.summaryTj).toBeNull();
  });
});

describe("parseCardResponse action origin", () => {
  function rawWith(action: Record<string, unknown>): string {
    return JSON.stringify({ summary: "S", actions: [action] });
  }

  it("keeps origin 'tj' on book-specific actions when TJ history exists", () => {
    const out = parseCardResponse(
      rawWith({ kind: "send_chase_email", label: "Chase", origin: "tj", args: {} }),
      { allowTj: true },
    );
    expect(out.actions[0]?.origin).toBe("tj");
  });

  it("normalizes origin 'tj' to 'feldart' when the customer has no TJ history", () => {
    const out = parseCardResponse(
      rawWith({ kind: "send_statement", label: "Statement", origin: "tj", args: {} }),
      { allowTj: false },
    );
    expect(out.actions[0]?.origin).toBe("feldart");
  });

  it("defaults missing origin to 'feldart' on book-specific actions", () => {
    const out = parseCardResponse(
      rawWith({ kind: "send_chase_email", label: "Chase", args: {} }),
      { allowTj: true },
    );
    expect(out.actions[0]?.origin).toBe("feldart");
  });

  it("accepts origin via args when the model nests it there", () => {
    const out = parseCardResponse(
      rawWith({ kind: "send_statement", label: "Statement", args: { origin: "tj" } }),
      { allowTj: true },
    );
    expect(out.actions[0]?.origin).toBe("tj");
  });

  it("never sets origin on non-book-specific actions", () => {
    const out = parseCardResponse(
      rawWith({ kind: "view_rma", label: "RMA", origin: "tj", args: {} }),
      { allowTj: true },
    );
    expect(out.actions[0]?.origin).toBeUndefined();
  });

  it("rejects junk origin values to the feldart default", () => {
    const out = parseCardResponse(
      rawWith({ kind: "send_chase_email", label: "Chase", origin: "both", args: {} }),
      { allowTj: true },
    );
    expect(out.actions[0]?.origin).toBe("feldart");
  });
});
