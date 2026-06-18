// generateCustomerCard branch tests (osplit2 W2 T5): both-books customers get
// ONE Anthropic call whose schema carries summary_feldart/summary_tj and whose
// persistence writes the per-book columns; single-book customers keep the
// blended summary with per-book columns NULL. Mock seams follow tools.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("../../db/index.js", () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));
vi.mock("./voice.js", () => ({
  buildDraftContext: vi.fn(async () => ({
    voiceGuide: "VOICE",
    globalFacts: [],
    categoryFacts: [],
    globalCorrections: [],
    categoryCorrections: [],
    customerContext: null,
    exampleTemplate: null,
  })),
}));
vi.mock("./candidates/chase-next.js", () => ({
  findCandidates: vi.fn(async () => []),
}));
vi.mock("./candidates/cadence-cold.js", () => ({
  findCandidates: vi.fn(async () => []),
}));
vi.mock("./candidates/cadence-statement.js", () => ({
  findCandidates: vi.fn(async () => []),
}));
vi.mock("./candidates/ops-rma-stalled.js", () => ({
  findCandidates: vi.fn(async () => []),
}));
vi.mock("./candidates/ops-cron-fail.js", () => ({
  findCandidates: vi.fn(async () => []),
}));
vi.mock("../../integrations/anthropic/client.js", () => ({
  getAnthropicClient: () => ({ messages: { create: createMock } }),
}));
vi.mock("../../integrations/anthropic/cost-tracker.js", () => ({
  trackUsage: vi.fn(async () => undefined),
}));

import { db } from "../../db/index.js";
import { generateCustomerCard } from "./customer-card.js";

// Awaitable drizzle select-chain stub: every builder method returns the chain;
// awaiting it resolves the queued rows.
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "groupBy"]) {
    c[m] = vi.fn(() => c);
  }
  c["then"] = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(rows).then(onFulfilled, onRejected);
  return c as unknown as ReturnType<typeof db.select>;
}

const customerRow = {
  id: "c1",
  displayName: "Acme Ltd",
  balance: "500.00",
  overdueBalance: "420.00",
  holdStatus: "active",
};

const pastDue = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

function aiResponse(json: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// Select order inside generateCustomerCard: customer → emails → invoices →
// credit memos → phone calls (the latter four sit in one Promise.all, array
// order) → held orders.
function queueSelects(invoiceRows: unknown[], creditRows: unknown[]) {
  vi.mocked(db.select)
    .mockReturnValueOnce(chain([customerRow]))
    .mockReturnValueOnce(chain([])) // emails
    .mockReturnValueOnce(chain(invoiceRows))
    .mockReturnValueOnce(chain(creditRows))
    .mockReturnValueOnce(chain([])) // phone calls/texts
    .mockReturnValueOnce(chain([])); // held orders
}

let inserted: Record<string, unknown> | null = null;

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.insert).mockReset();
  createMock.mockReset();
  inserted = null;
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn((v: Record<string, unknown>) => {
      inserted = v;
      return { onDuplicateKeyUpdate: vi.fn(async () => undefined) };
    }),
  } as never);
});

describe("generateCustomerCard — both books", () => {
  const tjInvoices = [
    {
      origin: "feldart",
      balance: "300.00",
      dueDate: pastDue,
      disputeState: null,
      docNumber: "1-100",
      disputeClaimedAt: null,
    },
    {
      origin: "tj",
      balance: "120.00",
      dueDate: pastDue,
      disputeState: "verifying",
      docNumber: "2-200",
      disputeClaimedAt: new Date("2026-06-02T00:00:00Z"),
    },
    {
      origin: "tj",
      balance: "80.00",
      dueDate: null,
      disputeState: null,
      docNumber: "2-201",
      disputeClaimedAt: null,
    },
  ];

  it("one call with per-book schema; persists per-book columns + summary", async () => {
    queueSelects(tjInvoices, []);
    createMock.mockResolvedValueOnce(
      aiResponse({
        summary: "Overall read.",
        summary_feldart: "Feldart read.",
        summary_tj: "TJ read.",
        actions: [
          { kind: "send_chase_email", label: "Chase TJ", origin: "tj", args: {} },
        ],
      }),
    );

    const result = await generateCustomerCard("c1");

    // ONE Anthropic call (cost discipline).
    expect(createMock).toHaveBeenCalledTimes(1);
    const req = createMock.mock.calls[0]?.[0] as {
      system: string;
      messages: { content: string }[];
    };
    expect(req.system).toContain("summary_feldart");
    expect(req.system).toContain("summary_tj");
    expect(req.messages[0]?.content).toContain("Torah Judaica");
    expect(req.messages[0]?.content).toContain("2-200");

    // Persistence: per-book columns + NOT NULL summary written.
    expect(inserted).not.toBeNull();
    expect(inserted?.summary).toBe("Overall read.");
    expect(inserted?.summaryFeldart).toBe("Feldart read.");
    expect(inserted?.summaryTj).toBe("TJ read.");

    // TJ origin allowed because TJ history exists.
    expect(result.data.summaryFeldart).toBe("Feldart read.");
    expect(result.data.summaryTj).toBe("TJ read.");
    expect(result.data.actions[0]?.origin).toBe("tj");
  });
});

describe("generateCustomerCard — single book", () => {
  const feldartOnly = [
    {
      origin: "feldart",
      balance: "300.00",
      dueDate: pastDue,
      disputeState: null,
      docNumber: "1-100",
      disputeClaimedAt: null,
    },
  ];

  it("keeps the blended schema; per-book columns persist NULL", async () => {
    queueSelects(feldartOnly, []);
    createMock.mockResolvedValueOnce(
      aiResponse({
        summary: "Blended read.",
        actions: [
          // Model hallucinates a TJ origin — must normalize to feldart since
          // the customer has no TJ history.
          { kind: "send_statement", label: "Statement", origin: "tj", args: {} },
        ],
      }),
    );

    const result = await generateCustomerCard("c1");

    expect(createMock).toHaveBeenCalledTimes(1);
    const req = createMock.mock.calls[0]?.[0] as { system: string };
    expect(req.system).not.toContain("summary_feldart");

    expect(inserted?.summary).toBe("Blended read.");
    expect(inserted?.summaryFeldart).toBeNull();
    expect(inserted?.summaryTj).toBeNull();

    expect(result.data.summaryFeldart).toBeNull();
    expect(result.data.summaryTj).toBeNull();
    expect(result.data.actions[0]?.origin).toBe("feldart");
  });
});
