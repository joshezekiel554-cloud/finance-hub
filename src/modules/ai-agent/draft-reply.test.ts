import { describe, it, expect } from "vitest";
import {
  buildDraftReplyPrompt,
  parseDraftReplyResponse,
  type DraftReplyPromptInput,
} from "./draft-reply.js";

const baseContext: DraftReplyPromptInput["context"] = {
  voiceGuide: "VOICE",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: null,
};

describe("buildDraftReplyPrompt", () => {
  it("includes the thread transcript and operator notes when provided", () => {
    const out = buildDraftReplyPrompt({
      thread: [
        {
          direction: "inbound",
          from: "client@x.com",
          date: "2026-05-20",
          subject: "Q",
          body: "Where is invoice?",
        },
        {
          direction: "outbound",
          from: "us@y.com",
          date: "2026-05-21",
          subject: "Re: Q",
          body: "Attached.",
        },
        {
          direction: "inbound",
          from: "client@x.com",
          date: "2026-05-22",
          subject: "Re: Q",
          body: "Got it, but the total is wrong.",
        },
      ],
      customer: {
        id: "c1",
        name: "Acme",
        balance: 1200,
        hasHold: false,
      },
      notes: "apologise for the mix-up and offer to send a corrected invoice",
      context: baseContext,
    });
    expect(out.system).toContain("VOICE");
    expect(out.user).toContain("Got it, but the total is wrong.");
    expect(out.user.toLowerCase()).toContain("apologise");
    expect(out.user.toLowerCase()).toContain("reply");
  });

  it("works without notes (clean run)", () => {
    const out = buildDraftReplyPrompt({
      thread: [
        {
          direction: "inbound",
          from: "c@x.com",
          date: "2026-05-20",
          subject: "Q",
          body: "Need a copy of invoice INV-9.",
        },
      ],
      customer: { id: "c1", name: "Acme", balance: 0, hasHold: false },
      notes: null,
      context: baseContext,
    });
    expect(out.user).toContain("INV-9");
    expect(out.user.toLowerCase()).not.toContain(
      "operator instructions for this reply",
    );
  });

  it("renders the per-customer context block when present", () => {
    const out = buildDraftReplyPrompt({
      thread: [
        {
          direction: "inbound",
          from: "c@x.com",
          date: "2026-05-20",
          subject: "S",
          body: "B",
        },
      ],
      customer: { id: "c1", name: "Acme", balance: 0, hasHold: false },
      notes: null,
      context: {
        ...baseContext,
        customerContext: "Pays via BACS, address them as 'Sarah'",
      },
    });
    expect(out.user).toContain("Sarah");
  });
});

describe("parseDraftReplyResponse", () => {
  it("parses {subject, body} JSON correctly", () => {
    const raw = JSON.stringify({
      subject: "Re: Invoice query",
      body: "Hi Sarah,\n\nApologies for the mix-up...",
    });
    const out = parseDraftReplyResponse(raw, "fallback subject");
    expect(out.subject).toBe("Re: Invoice query");
    expect(out.body).toContain("Apologies");
  });

  it("falls back to provided fallbackSubject when subject missing", () => {
    const raw = JSON.stringify({ body: "B" });
    const out = parseDraftReplyResponse(raw, "Re: Original subject");
    expect(out.subject).toBe("Re: Original subject");
    expect(out.body).toBe("B");
  });

  it("returns raw text as body when JSON parse fails", () => {
    const raw = "Sorry about the mix-up — corrected invoice attached.";
    const out = parseDraftReplyResponse(raw, "Re: X");
    expect(out.body).toBe(raw);
    expect(out.subject).toBe("Re: X");
  });

  it("tolerates a ```json fenced wrapper", () => {
    const raw =
      "```json\n" + JSON.stringify({ subject: "S", body: "B" }) + "\n```";
    const out = parseDraftReplyResponse(raw, "fallback");
    expect(out.subject).toBe("S");
    expect(out.body).toBe("B");
  });
});
