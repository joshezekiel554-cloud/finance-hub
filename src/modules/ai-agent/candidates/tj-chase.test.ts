import { beforeEach, describe, expect, it, vi } from "vitest";

// tj-chase delegates severity to the chase module's origin-scoped lookups
// (getOverdueCustomers("tj") / getOverdueForCustomer(id, "tj")) — mock the
// module so the default wiring is assertable without a DB; the behavioural
// tests inject deps directly (winddown-style DI seams).
vi.mock("../../../db/index.js", () => ({ db: { select: vi.fn() } }));
vi.mock("../../chase/lookups.js", () => ({
  getOverdueCustomers: vi.fn(),
  getOverdueForCustomer: vi.fn(),
}));

import {
  getOverdueCustomers,
  getOverdueForCustomer,
} from "../../chase/lookups.js";
import { findCandidates, isStillEligible } from "./tj-chase.js";
import type { OverdueCustomer, ChaseTier } from "../../chase/types.js";
import type { Customer } from "../../../db/schema/customers.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeOverdueRow(
  overrides: {
    customerId?: string;
    displayName?: string;
    agentModeExcluded?: boolean;
    tier?: ChaseTier;
    totalOverdue?: number;
    daysOverdue?: number;
  } = {},
): OverdueCustomer {
  const customerId = overrides.customerId ?? "cust-tj-1";
  return {
    customerId,
    customer: {
      id: customerId,
      displayName: overrides.displayName ?? "TJ Debtor",
      agentModeExcluded: overrides.agentModeExcluded ?? false,
    } as Customer,
    invoices: [],
    severity: {
      score: 10000,
      tier: overrides.tier ?? "MEDIUM",
      daysOverdue: overrides.daysOverdue ?? 60,
      totalOverdue: overrides.totalOverdue ?? 4500,
      oldestUnpaidDate: "2026-04-01",
    },
  };
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

const noRecentChases = async () => [];

beforeEach(() => {
  vi.mocked(getOverdueCustomers).mockReset();
  vi.mocked(getOverdueForCustomer).mockReset();
});

// ── findCandidates ───────────────────────────────────────────────────────────

describe("tj-chase findCandidates", () => {
  it("proposes MEDIUM/HIGH/CRITICAL with origin 'tj' and chase_next's summary shape", async () => {
    const rows = [
      makeOverdueRow({ customerId: "c-med", tier: "MEDIUM", totalOverdue: 5200, daysOverdue: 40 }),
      makeOverdueRow({ customerId: "c-high", tier: "HIGH" }),
      makeOverdueRow({ customerId: "c-crit", tier: "CRITICAL", displayName: "Big TJ Debtor" }),
    ];
    const results = await findCandidates(undefined, {
      loadOverdue: async () => rows,
      loadRecentChases: noRecentChases,
    });

    expect(results.map((r) => r.entityId)).toEqual(["c-med", "c-high", "c-crit"]);
    for (const r of results) {
      expect(r.entityType).toBe("customer");
      expect(r.origin).toBe("tj");
    }
    const med = results[0]!;
    expect(med.summary).toEqual({
      customerId: "c-med",
      customerName: "TJ Debtor",
      overdueBalance: 5200,
      daysOverdue: 40,
      tier: "MEDIUM",
      lastChaseAt: null,
    });
  });

  it("LOW tier never proposed (same threshold as chase_next)", async () => {
    const results = await findCandidates(undefined, {
      loadOverdue: async () => [makeOverdueRow({ tier: "LOW" })],
      loadRecentChases: noRecentChases,
    });
    expect(results).toHaveLength(0);
  });

  it("agentModeExcluded customers are filtered", async () => {
    const results = await findCandidates(undefined, {
      loadOverdue: async () => [
        makeOverdueRow({ customerId: "c-excl", agentModeExcluded: true, tier: "CRITICAL" }),
      ],
      loadRecentChases: noRecentChases,
    });
    expect(results).toHaveLength(0);
  });

  it("recent chase (3 days ago) suppresses the candidate", async () => {
    const results = await findCandidates(undefined, {
      loadOverdue: async () => [makeOverdueRow({ customerId: "c-chased", tier: "HIGH" })],
      loadRecentChases: async () => [
        { customerId: "c-chased", lastChasedAt: daysAgo(3) },
      ],
    });
    expect(results).toHaveLength(0);
  });

  it("recent-chase lookup is scoped to a ~7 day cooldown cutoff", async () => {
    let seenCutoff: Date | null = null;
    await findCandidates(undefined, {
      loadOverdue: async () => [makeOverdueRow({ tier: "HIGH" })],
      loadRecentChases: async (_ids, cutoff) => {
        seenCutoff = cutoff;
        return [];
      },
    });
    expect(seenCutoff).not.toBeNull();
    const days = (Date.now() - seenCutoff!.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("scopes to one customer when customerId is passed", async () => {
    const results = await findCandidates("c-2", {
      loadOverdue: async () => [
        makeOverdueRow({ customerId: "c-1", tier: "HIGH" }),
        makeOverdueRow({ customerId: "c-2", tier: "CRITICAL" }),
      ],
      loadRecentChases: noRecentChases,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.entityId).toBe("c-2");
  });

  it("returns early (no chase-log lookup) when nothing is actionable", async () => {
    const loadRecentChases = vi.fn(noRecentChases);
    const results = await findCandidates(undefined, {
      loadOverdue: async () => [],
      loadRecentChases,
    });
    expect(results).toHaveLength(0);
    expect(loadRecentChases).not.toHaveBeenCalled();
  });

  it("default severity loader is the TJ-scoped chase path (getOverdueCustomers('tj'))", async () => {
    // The "tj" scope is what brings verifying-exclusion + TJ credit netting —
    // both implemented (and tested) in chase/lookups.ts.
    vi.mocked(getOverdueCustomers).mockResolvedValueOnce([]);
    const results = await findCandidates();
    expect(results).toHaveLength(0);
    expect(getOverdueCustomers).toHaveBeenCalledWith("tj");
  });
});

// ── isStillEligible ──────────────────────────────────────────────────────────

describe("tj-chase isStillEligible", () => {
  it("false when the customer has no actionable TJ overdue", async () => {
    expect(
      await isStillEligible("ghost", {
        loadOverdueForCustomer: async () => null,
        loadRecentChases: noRecentChases,
      }),
    ).toBe(false);
  });

  it("false when agentModeExcluded", async () => {
    expect(
      await isStillEligible("c-x", {
        loadOverdueForCustomer: async () =>
          makeOverdueRow({ customerId: "c-x", agentModeExcluded: true, tier: "CRITICAL" }),
        loadRecentChases: noRecentChases,
      }),
    ).toBe(false);
  });

  it("false when the TJ tier dropped to LOW", async () => {
    expect(
      await isStillEligible("c-low", {
        loadOverdueForCustomer: async () =>
          makeOverdueRow({ customerId: "c-low", tier: "LOW" }),
        loadRecentChases: noRecentChases,
      }),
    ).toBe(false);
  });

  it("false when chased within the last 7 days", async () => {
    expect(
      await isStillEligible("c-chased", {
        loadOverdueForCustomer: async () =>
          makeOverdueRow({ customerId: "c-chased", tier: "HIGH" }),
        loadRecentChases: async () => [
          { customerId: "c-chased", lastChasedAt: daysAgo(2) },
        ],
      }),
    ).toBe(false);
  });

  it("true for an actionable TJ customer with no recent chase", async () => {
    expect(
      await isStillEligible("c-ok", {
        loadOverdueForCustomer: async () =>
          makeOverdueRow({ customerId: "c-ok", tier: "MEDIUM" }),
        loadRecentChases: noRecentChases,
      }),
    ).toBe(true);
  });

  it("default severity loader is getOverdueForCustomer(id, 'tj')", async () => {
    vi.mocked(getOverdueForCustomer).mockResolvedValueOnce(null);
    expect(await isStillEligible("c-default")).toBe(false);
    expect(getOverdueForCustomer).toHaveBeenCalledWith("c-default", "tj");
  });
});
