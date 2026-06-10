import { describe, it, expect } from "vitest";
import { buildPrompt, TOOL_NAME } from "./tj-dispute-nudge.js";
import type { DraftContext } from "../voice.js";

const ctx: DraftContext = {
  voiceGuide: "VOICE_GUIDE_MARKER",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: null,
};

const followUpSummary = {
  invoiceId: "inv-1",
  docNumber: "20455",
  customerId: "cust-1",
  customerName: "Claims Paid Co",
  balance: 850,
  claimedAt: "2026-05-29T10:00:00.000Z",
  disputeNote: "Says cheque #1042 cleared in March",
  hasBookkeeperThread: true,
  needsFirstEmail: false,
  daysSilent: 9,
  lastThreadEmailAt: "2026-06-01T10:00:00.000Z",
  recipient: "bookkeeper",
  bookkeeperEmail: "books@torahjudaica.example",
  bookkeeperName: "Rivka",
};

const firstEmailSummary = {
  ...followUpSummary,
  hasBookkeeperThread: false,
  needsFirstEmail: true,
  daysSilent: null,
  lastThreadEmailAt: null,
  bookkeeperEmail: null,
  bookkeeperName: null,
};

describe("tj-dispute-nudge buildPrompt", () => {
  it("uses the bookkeeper send tool", () => {
    expect(TOOL_NAME).toBe("send_bookkeeper_email");
  });

  it("puts role + voice guide in system", () => {
    const { system } = buildPrompt(followUpSummary, ctx);
    expect(system).toContain("VOICE_GUIDE_MARKER");
    expect(system).toContain("bookkeeper");
  });

  it("makes plain the recipient is the bookkeeper, not the customer", () => {
    const { user } = buildPrompt(followUpSummary, ctx);
    expect(user.toLowerCase()).toContain("not the customer");
    expect(user).toContain("Rivka");
    expect(user).toContain("books@torahjudaica.example");
  });

  it("follow-up variant references invoice, claim date, note and days silent", () => {
    const { user } = buildPrompt(followUpSummary, ctx);
    expect(user).toContain("20455");
    expect(user).toContain("Claims Paid Co");
    expect(user).toContain("cheque #1042");
    expect(user).toContain("9 days");
    expect(user).toContain("follow-up");
  });

  it("no-thread variant asks for a first introduction of the question", () => {
    const { user } = buildPrompt(firstEmailSummary, ctx);
    expect(user.toLowerCase()).toContain("no bookkeeper email has been sent yet");
    expect(user).not.toContain("days silent");
  });

  it("flags an unconfigured bookkeeper address", () => {
    const { user } = buildPrompt(firstEmailSummary, ctx);
    expect(user.toLowerCase()).toContain("not configured");
  });

  it("instructs the tool call with the invoiceId", () => {
    const { user } = buildPrompt(followUpSummary, ctx);
    expect(user).toContain(`invoiceId: "inv-1"`);
    expect(user).toContain(TOOL_NAME);
  });
});
