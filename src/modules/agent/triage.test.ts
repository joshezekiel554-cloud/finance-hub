// Inbound-triage contract tests: pattern→proposal mapping, the
// confidence floor, kill-switch gate, and fail-open-never-throw.

import { describe, expect, it } from "vitest";
import {
  proposalForClassification,
  triageInboundEmail,
  type TriageInput,
} from "./triage.js";

const NOW = new Date("2026-06-11T12:00:00Z");
const input: TriageInput = {
  emailLogId: "email240000000000000001",
  customerId: "cust1",
  customerName: "Brown & Co",
  subject: "s",
  body: "b",
};

describe("proposalForClassification", () => {
  it("tracking → pre-drafted create_task with the tracking number", () => {
    const row = proposalForClassification(
      input,
      { pattern: "tracking", confidence: 0.95, trackingNumber: "1Z999" },
      NOW,
    )!;
    expect(row.category).toBe("inbound_triage");
    expect(row.status).toBe("drafted");
    expect(row.draftedAction?.tool).toBe("create_task");
    expect(String((row.draftedAction?.args as { title: string }).title)).toContain("1Z999");
    expect((row.candidateSummary as { emailLogId: string }).emailLogId).toBe(
      input.emailLogId,
    );
  });

  it("payment_claim → high-priority verification task", () => {
    const row = proposalForClassification(
      input,
      { pattern: "payment_claim", confidence: 0.9, detail: "says paid by cheque" },
      NOW,
    )!;
    expect(row.draftedAction?.tool).toBe("create_task");
    expect((row.draftedAction?.args as { priority: string }).priority).toBe("high");
  });

  it("statement_request → send_statement (feldart)", () => {
    const row = proposalForClassification(
      input,
      { pattern: "statement_request", confidence: 0.85 },
      NOW,
    )!;
    expect(row.draftedAction?.tool).toBe("send_statement");
    expect((row.draftedAction?.args as { origin: string }).origin).toBe("feldart");
  });

  it("below the confidence floor or 'none' → no proposal", () => {
    expect(
      proposalForClassification(input, { pattern: "tracking", confidence: 0.7 }, NOW),
    ).toBeNull();
    expect(
      proposalForClassification(input, { pattern: "none", confidence: 0.99 }, NOW),
    ).toBeNull();
  });
});

describe("triageInboundEmail", () => {
  it("kill switch off → no classification call at all", async () => {
    let classified = false;
    const result = await triageInboundEmail(input, {
      isEnabled: async () => false,
      classify: async () => {
        classified = true;
        return { pattern: "tracking", confidence: 1 };
      },
    });
    expect(result.proposed).toBe(false);
    expect(classified).toBe(false);
  });

  it("proposes on a confident hit", async () => {
    const inserted: unknown[] = [];
    const result = await triageInboundEmail(input, {
      isEnabled: async () => true,
      classify: async () => ({ pattern: "tracking", confidence: 0.92 }),
      insertProposal: async (row) => void inserted.push(row),
      now: () => NOW,
    });
    expect(result).toEqual({ proposed: true, pattern: "tracking" });
    expect(inserted).toHaveLength(1);
  });

  it("never throws — classifier explosions are swallowed", async () => {
    const result = await triageInboundEmail(input, {
      isEnabled: async () => true,
      classify: async () => {
        throw new Error("haiku exploded");
      },
    });
    expect(result.proposed).toBe(false);
  });
});
