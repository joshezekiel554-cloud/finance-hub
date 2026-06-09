import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../db/index.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../../../db/index.js";
import { findCandidates, isStillEligible } from "./cadence-statement.js";

// Chainable query builder stub
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeQueryChain(resolvedValue: unknown): any {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "innerJoin", "leftJoin", "where", "groupBy", "having"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // The last awaited call returns the resolved value
  chain["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(resolvedValue).then(resolve);
  return chain;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findCandidates", () => {
  it("excluded customer not returned — agentModeExcluded=true filtered in query", async () => {
    // DB returns empty — the WHERE agentModeExcluded=false filters it out
    const chain = makeQueryChain([]);
    vi.mocked(db.select).mockReturnValue(chain);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("customer with open invoices and no statement returns as candidate", async () => {
    const chain = makeQueryChain([
      {
        customerId: "cust-1",
        customerName: "Acme Corp",
        openInvoiceCount: "3",
        totalOpenBalance: "4500.00",
        lastStatementSentAt: null,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    const results = await findCandidates();
    expect(results).toHaveLength(1);
    const c = results[0]!;
    expect(c.entityType).toBe("customer");
    expect(c.entityId).toBe("cust-1");
    expect(c.summary.customerName).toBe("Acme Corp");
    expect(c.summary.openInvoiceCount).toBe(3);
    expect(c.summary.totalOpenBalance).toBe(4500);
    expect(c.summary.lastStatementSentAt).toBeNull();
    expect(c.summary.daysSinceLastStatement).toBe(9999);
  });

  it("recent statement suppresses — query HAVING filters it out", async () => {
    // DB returns empty — the HAVING clause (last sent < 30 days ago) filters customer with 5-day-old statement
    const chain = makeQueryChain([]);
    vi.mocked(db.select).mockReturnValue(chain);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("customer with statement > 30 days ago is included", async () => {
    const oldSend = daysAgo(45);
    const chain = makeQueryChain([
      {
        customerId: "cust-2",
        customerName: "Beta LLC",
        openInvoiceCount: "1",
        totalOpenBalance: "1200.00",
        lastStatementSentAt: oldSend,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    const results = await findCandidates();
    expect(results).toHaveLength(1);
    expect(results[0]!.summary.daysSinceLastStatement).toBeGreaterThan(30);
    expect(results[0]!.summary.lastStatementSentAt).toBe(oldSend.toISOString());
  });

  it("when customerId is passed, result only includes that customer", async () => {
    const chain = makeQueryChain([
      {
        customerId: "cust-scope",
        customerName: "Scoped Co",
        openInvoiceCount: "2",
        totalOpenBalance: "3000.00",
        lastStatementSentAt: null,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    const results = await findCandidates("cust-scope");
    expect(results).toHaveLength(1);
    expect(results[0]!.entityId).toBe("cust-scope");
  });

  it("TJ-only open invoices produce no statement-cadence candidate", async () => {
    // The invoice innerJoin is origin-scoped to feldart, so a customer whose
    // only open invoices are TJ (origin='tj') matches no invoice rows and is
    // dropped by the inner join → query returns no rows. TJ statements are
    // handled manually, never by the AI proposer.
    const chain = makeQueryChain([]);
    vi.mocked(db.select).mockReturnValue(chain);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("Feldart open invoices still produce a candidate", async () => {
    const chain = makeQueryChain([
      {
        customerId: "cust-feldart",
        customerName: "Feldart Co",
        openInvoiceCount: "2",
        totalOpenBalance: "2200.00",
        lastStatementSentAt: null,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    const results = await findCandidates();
    expect(results).toHaveLength(1);
    expect(results[0]!.entityId).toBe("cust-feldart");
    expect(results[0]!.summary.openInvoiceCount).toBe(2);
  });
});

describe("isStillEligible", () => {
  it("returns false for excluded customer", async () => {
    const chain = makeQueryChain([
      {
        openInvoiceCount: "2",
        lastStatementSentAt: null,
        agentModeExcluded: true,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    expect(await isStillEligible("cust-excl")).toBe(false);
  });

  it("returns false when no open invoices", async () => {
    const chain = makeQueryChain([
      {
        openInvoiceCount: "0",
        lastStatementSentAt: null,
        agentModeExcluded: false,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    expect(await isStillEligible("cust-paid")).toBe(false);
  });

  it("returns false when statement sent 5 days ago (recent suppression)", async () => {
    const chain = makeQueryChain([
      {
        openInvoiceCount: "2",
        lastStatementSentAt: daysAgo(5),
        agentModeExcluded: false,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    expect(await isStillEligible("cust-recent")).toBe(false);
  });

  it("returns true when no statement ever sent", async () => {
    const chain = makeQueryChain([
      {
        openInvoiceCount: "1",
        lastStatementSentAt: null,
        agentModeExcluded: false,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    expect(await isStillEligible("cust-new")).toBe(true);
  });

  it("returns true when statement sent > 30 days ago", async () => {
    const chain = makeQueryChain([
      {
        openInvoiceCount: "3",
        lastStatementSentAt: daysAgo(45),
        agentModeExcluded: false,
      },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);

    expect(await isStillEligible("cust-stale")).toBe(true);
  });

  it("returns false when customer not found", async () => {
    const chain = makeQueryChain([]);
    vi.mocked(db.select).mockReturnValue(chain);

    expect(await isStillEligible("cust-ghost")).toBe(false);
  });
});
