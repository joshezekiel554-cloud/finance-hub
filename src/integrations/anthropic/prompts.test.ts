import { describe, expect, it } from "vitest";
import { buildChaseDigestUserPrompt } from "./prompts.js";
import type { ChaseAccount, TjChaseDigestBlock } from "./types.js";

function makeAccount(overrides: Partial<ChaseAccount> = {}): ChaseAccount {
  return {
    name: "Acme",
    tier: "MEDIUM",
    score: 5000,
    overdue_balance: 5000,
    current_balance: 12345.67,
    days_overdue: 30,
    oldest_unpaid_invoice: "2026-05-11",
    last_payment: null,
    last_chased: null,
    hold_status: "active",
    action_plan: null,
    ...overrides,
  };
}

describe("buildChaseDigestUserPrompt — TJ wind-down block", () => {
  it("no TJ block → prompt has no Torah Judaica section", () => {
    const prompt = buildChaseDigestUserPrompt([makeAccount()]);
    expect(prompt).toContain("Candidate accounts");
    expect(prompt).toContain("### 1. Acme");
    expect(prompt).not.toContain("TORAH JUDAICA");
    expect(prompt.endsWith("Produce the digest now.")).toBe(true);
  });

  it("explicit null TJ block behaves like absent", () => {
    const prompt = buildChaseDigestUserPrompt([makeAccount()], null);
    expect(prompt).not.toContain("TORAH JUDAICA");
  });

  it("TJ block renders pipeline line + TJ accounts in a delimited section", () => {
    const tj: TjChaseDigestBlock = {
      accounts: [makeAccount({ name: "TJ Cust", tier: "HIGH", score: 9000 })],
      pipeline: { verifying: 3, awaitingFirstEmail: 1, silentThreads: 2 },
    };
    const prompt = buildChaseDigestUserPrompt([makeAccount()], tj);
    expect(prompt).toContain("--- TORAH JUDAICA WIND-DOWN ---");
    expect(prompt).toContain(
      "Dispute pipeline: 3 invoice(s) in bookkeeper verification, 1 awaiting a FIRST bookkeeper email, 2 with a bookkeeper thread silent >= 7 days.",
    );
    expect(prompt).toContain("TJ overdue accounts (sorted by severity score");
    expect(prompt).toContain("### 1. TJ Cust");
    // Feldart accounts come BEFORE the TJ delimiter; TJ accounts after.
    const delimiterIdx = prompt.indexOf("--- TORAH JUDAICA WIND-DOWN ---");
    expect(prompt.indexOf("### 1. Acme")).toBeLessThan(delimiterIdx);
    expect(prompt.indexOf("### 1. TJ Cust")).toBeGreaterThan(delimiterIdx);
  });

  it("TJ block with no severity rows (disputes only) says so explicitly", () => {
    const tj: TjChaseDigestBlock = {
      accounts: [],
      pipeline: { verifying: 2, awaitingFirstEmail: 2, silentThreads: 0 },
    };
    const prompt = buildChaseDigestUserPrompt([makeAccount()], tj);
    expect(prompt).toContain("TJ overdue accounts: none.");
    expect(prompt).toContain("2 invoice(s) in bookkeeper verification");
  });

  it("empty Feldart candidates render an explicit none marker (TJ-only digest)", () => {
    const tj: TjChaseDigestBlock = {
      accounts: [makeAccount({ name: "TJ Cust" })],
      pipeline: { verifying: 0, awaitingFirstEmail: 0, silentThreads: 0 },
    };
    const prompt = buildChaseDigestUserPrompt([], tj);
    expect(prompt).toContain(
      "(none — the Feldart book has no chase candidates today)",
    );
    expect(prompt).toContain("### 1. TJ Cust");
  });
});
