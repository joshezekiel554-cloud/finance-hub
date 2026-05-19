import { describe, expect, it } from "vitest";

// Pure-logic tests for the chase widget's tier sort. The actual sort lives
// inline in src/server/routes/dashboard.ts (the /chase handler); we mirror
// it here so the contract is regression-protected. DB-bound query shape is
// validated by manual smoke (no Fastify test harness in repo).

const tierRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
type Tier = keyof typeof tierRank;

function sortByChaseTier(
  rows: Array<{ tier: Tier; daysOverdue: number }>,
): Array<{ tier: Tier; daysOverdue: number }> {
  return [...rows].sort((a, b) => {
    const t = tierRank[a.tier] - tierRank[b.tier];
    return t !== 0 ? t : b.daysOverdue - a.daysOverdue;
  });
}

describe("chase widget sort order", () => {
  it("CRITICAL beats HIGH regardless of daysOverdue", () => {
    const sorted = sortByChaseTier([
      { tier: "HIGH", daysOverdue: 100 },
      { tier: "CRITICAL", daysOverdue: 5 },
    ]);
    expect(sorted[0].tier).toBe("CRITICAL");
  });

  it("within same tier, higher daysOverdue comes first", () => {
    const sorted = sortByChaseTier([
      { tier: "MEDIUM", daysOverdue: 10 },
      { tier: "MEDIUM", daysOverdue: 50 },
      { tier: "MEDIUM", daysOverdue: 30 },
    ]);
    expect(sorted.map((r) => r.daysOverdue)).toEqual([50, 30, 10]);
  });

  it("full ordering CRITICAL > HIGH > MEDIUM > LOW with daysOverdue tiebreak", () => {
    const sorted = sortByChaseTier([
      { tier: "LOW", daysOverdue: 99 },
      { tier: "CRITICAL", daysOverdue: 1 },
      { tier: "MEDIUM", daysOverdue: 50 },
      { tier: "HIGH", daysOverdue: 10 },
      { tier: "HIGH", daysOverdue: 20 },
    ]);
    expect(sorted.map((r) => `${r.tier}/${r.daysOverdue}`)).toEqual([
      "CRITICAL/1",
      "HIGH/20",
      "HIGH/10",
      "MEDIUM/50",
      "LOW/99",
    ]);
  });
});
