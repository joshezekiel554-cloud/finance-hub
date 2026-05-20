import { describe, it, expect } from "vitest";
import { buildPrompt as buildRma } from "./ops-rma-stalled.js";
import { buildPrompt as buildCron } from "./ops-cron-fail.js";
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

describe("ops builders", () => {
  it("rma warehouse branch includes voice in system", () => {
    const { system, user } = buildRma(
      { rmaNumber: "RMA-1", customerName: "Acme", status: "sent_to_warehouse", daysInState: 20 },
      ctx,
    );
    expect(system).toContain("VOICE_MARK");
    expect(user).toContain("RMA-1");
  });

  it("rma admin branch sends NO system (internal notification)", () => {
    const { system } = buildRma(
      { rmaNumber: "RMA-2", customerName: "Acme", status: "needs_review", daysInState: 30 },
      ctx,
    );
    expect(system).toBe("");
  });

  it("cron-fail ignores context and sends NO system", () => {
    const { system, user } = buildCron(
      { jobKind: "qb_full", lastFailureAt: new Date().toISOString(), lastErrorExcerpt: "boom" },
      ctx,
    );
    expect(system).toBe("");
    expect(user).toContain("qb_full");
  });

  it("warehouse branch includes facts in system, no customer block", () => {
    const { system, user } = buildRma(
      { rmaNumber: "RMA-1", customerName: "Acme", status: "sent_to_warehouse", daysInState: 20 },
      { ...ctx, globalFacts: ["WAREHOUSE_FACT"], customerContext: "SHOULD_NOT_APPEAR" },
    );
    expect(system).toContain("WAREHOUSE_FACT");
    expect(user).not.toContain("SHOULD_NOT_APPEAR");
  });
});
