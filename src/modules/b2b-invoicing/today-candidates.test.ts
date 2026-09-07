import { describe, it, expect } from "vitest";
import {
  selectTodayCandidates,
  TODAY_CANDIDATE_CAPS,
  type TodayCandidate,
} from "./today-candidates.js";

// Helper: build a candidate whose emailDate is `minutesAgo` minutes old, so
// "newest first" ordering is easy to assert on.
function cand(
  gmailId: string,
  minutesAgo: number,
  opts: { hasOrderNumber?: boolean; dismissed?: boolean } = {},
): TodayCandidate {
  return {
    gmailId,
    emailDate: new Date(Date.UTC(2026, 8, 7, 12, 0, 0) - minutesAgo * 60_000),
    hasOrderNumber: opts.hasOrderNumber ?? false,
    dismissed: opts.dismissed ?? false,
  };
}

describe("selectTodayCandidates", () => {
  it("keeps every undismissed candidate with an order number, no matter how many", () => {
    const candidates = Array.from({ length: 1000 }, (_, i) =>
      cand(`ord-${i}`, i, { hasOrderNumber: true }),
    );

    const result = selectTodayCandidates(candidates);

    expect(result.keep.size).toBe(1000);
    for (const c of candidates) expect(result.keep.has(c.gmailId)).toBe(true);
    expect(result.truncated).toEqual({ unparseable: 0, dismissed: 0 });
  });

  it("caps unparseable candidates at the newest N and reports the remainder", () => {
    // 10 unparseable rows, oldest → newest by index (index 0 is newest).
    const candidates = Array.from({ length: 10 }, (_, i) => cand(`noise-${i}`, i));

    const result = selectTodayCandidates(candidates, {
      unparseable: 4,
      dismissed: 50,
    });

    expect(result.keep.size).toBe(4);
    expect([...result.keep].sort()).toEqual([
      "noise-0",
      "noise-1",
      "noise-2",
      "noise-3",
    ]);
    expect(result.truncated).toEqual({ unparseable: 6, dismissed: 0 });
  });

  it("caps dismissed candidates separately; a dismissed row with an order number counts against the dismissed cap", () => {
    const candidates = [
      // 3 dismissed rows, two of which parsed an order number.
      cand("dis-new", 1, { dismissed: true, hasOrderNumber: true }),
      cand("dis-mid", 2, { dismissed: true }),
      cand("dis-old", 3, { dismissed: true, hasOrderNumber: true }),
      // Plus live rows that must survive untouched.
      cand("live-order", 4, { hasOrderNumber: true }),
      cand("live-noise", 5),
    ];

    const result = selectTodayCandidates(candidates, {
      unparseable: 10,
      dismissed: 2,
    });

    expect(result.keep.has("dis-new")).toBe(true);
    expect(result.keep.has("dis-mid")).toBe(true);
    // Oldest dismissed row falls off even though it has an order number.
    expect(result.keep.has("dis-old")).toBe(false);
    expect(result.keep.has("live-order")).toBe(true);
    expect(result.keep.has("live-noise")).toBe(true);
    // The dropped dismissed row must NOT be counted as unparseable.
    expect(result.truncated).toEqual({ unparseable: 0, dismissed: 1 });
  });

  it("with zero caps keeps only undismissed order-number rows", () => {
    const candidates = [
      cand("keep-me", 1, { hasOrderNumber: true }),
      cand("noise-a", 2),
      cand("noise-b", 3),
      cand("dis-a", 4, { dismissed: true }),
    ];

    const result = selectTodayCandidates(candidates, {
      unparseable: 0,
      dismissed: 0,
    });

    expect([...result.keep]).toEqual(["keep-me"]);
    expect(result.truncated).toEqual({ unparseable: 2, dismissed: 1 });
  });

  it("returns an empty selection for empty input", () => {
    const result = selectTodayCandidates([]);
    expect(result.keep.size).toBe(0);
    expect(result.truncated).toEqual({ unparseable: 0, dismissed: 0 });
  });

  it("orders by emailDate descending, keeping input order for ties", () => {
    const sameInstant = new Date(Date.UTC(2026, 8, 7, 9, 0, 0));
    const candidates: TodayCandidate[] = [
      { gmailId: "tie-first", emailDate: sameInstant, hasOrderNumber: false, dismissed: false },
      { gmailId: "tie-second", emailDate: sameInstant, hasOrderNumber: false, dismissed: false },
      // Older than the tied pair, so it must be the one that drops.
      cand("older", 500),
    ];

    const result = selectTodayCandidates(candidates, {
      unparseable: 2,
      dismissed: 50,
    });

    expect(result.keep.has("tie-first")).toBe(true);
    expect(result.keep.has("tie-second")).toBe(true);
    expect(result.keep.has("older")).toBe(false);
    expect(result.truncated.unparseable).toBe(1);
  });

  it("defaults to the exported caps", () => {
    expect(TODAY_CANDIDATE_CAPS).toEqual({ unparseable: 100, dismissed: 50 });

    const noise = Array.from({ length: 120 }, (_, i) => cand(`n-${i}`, i));
    const result = selectTodayCandidates(noise);

    expect(result.keep.size).toBe(100);
    expect(result.truncated).toEqual({ unparseable: 20, dismissed: 0 });
  });
});
