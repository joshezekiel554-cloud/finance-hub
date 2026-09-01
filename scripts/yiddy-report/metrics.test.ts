import { describe, expect, test } from "vitest";
import {
  ttmMonths,
  priorYearMonths,
  monthOf,
  bucketMonthly,
  windowTotals,
  medianGapDays,
  trendBadge,
  seasonFlag,
} from "./metrics";
import type { GatheredDoc } from "./types";

const doc = (
  date: string,
  total: number,
  kind: "inv" | "sr" = "inv",
): GatheredDoc => ({
  kind,
  docNumber: "1001",
  date,
  total,
  open: false,
  openBalance: 0,
  origin: "feldart",
  status: "paid",
  lines: [],
});

describe("windows", () => {
  test("ttmMonths ends with the generation month, 12 entries", () => {
    const m = ttmMonths("2026-09-01");
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2025-10");
    expect(m[11]).toBe("2026-09");
  });

  test("priorYearMonths is the 12 months before TTM", () => {
    const m = priorYearMonths("2026-09-01");
    expect(m[0]).toBe("2024-10");
    expect(m[11]).toBe("2025-09");
  });

  test("windows cross year boundaries correctly", () => {
    const m = ttmMonths("2026-01-15");
    expect(m[0]).toBe("2025-02");
    expect(m[11]).toBe("2026-01");
  });

  test("monthOf extracts YYYY-MM", () => {
    expect(monthOf("2026-01-15")).toBe("2026-01");
  });
});

describe("bucketMonthly", () => {
  test("buckets orders and spend per TTM month, zero-filling empty months", () => {
    const docs = [
      doc("2026-09-05", 100),
      doc("2026-09-20", 50),
      doc("2025-10-01", 25),
      doc("2024-01-01", 999), // outside window — ignored
    ];
    const rows = bucketMonthly(docs, "2026-09-01");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ month: "2025-10", orders: 1, spend: 25 });
    expect(rows[11]).toEqual({ month: "2026-09", orders: 2, spend: 150 });
    expect(rows[5].orders).toBe(0); // zero-filled
  });
});

describe("windowTotals", () => {
  test("sums spend/orders inside a month set only", () => {
    const docs = [doc("2026-09-05", 100), doc("2024-11-01", 40), doc("2023-01-01", 7)];
    expect(windowTotals(docs, ttmMonths("2026-09-01"))).toEqual({ spend: 100, orders: 1 });
    expect(windowTotals(docs, priorYearMonths("2026-09-01"))).toEqual({ spend: 40, orders: 1 });
  });
});

describe("cadence", () => {
  test("medianGapDays over sorted dates", () => {
    // gaps: 10, 20, 30 → median 20
    expect(
      medianGapDays(["2026-01-01", "2026-01-11", "2026-01-31", "2026-03-02"]),
    ).toBe(20);
  });
  test("even gap count averages the middle pair", () => {
    // gaps: 10, 20 → median 15
    expect(medianGapDays(["2026-01-01", "2026-01-11", "2026-01-31"])).toBe(15);
  });
  test("null with fewer than 3 orders (no meaningful cadence)", () => {
    expect(medianGapDays(["2026-01-01", "2026-02-01"])).toBeNull();
    expect(medianGapDays([])).toBeNull();
  });
});

describe("trendBadge", () => {
  test("dormant when gap exceeds max(90, 2x median gap)", () => {
    expect(
      trendBadge({ t90Spend: 0, prior90Spend: 500, daysSinceLastOrder: 120, medianGap: 30 }),
    ).toBe("dormant");
    // 100 < max(90, 120) → not dormant, but t90 <= 0.7x prior → declining
    expect(
      trendBadge({ t90Spend: 0, prior90Spend: 500, daysSinceLastOrder: 100, medianGap: 60 }),
    ).toBe("declining");
  });
  test("never ordered → dormant", () => {
    expect(
      trendBadge({ t90Spend: 0, prior90Spend: 0, daysSinceLastOrder: null, medianGap: null }),
    ).toBe("dormant");
  });
  test("growing at >= 1.15x prior 90d spend", () => {
    expect(
      trendBadge({ t90Spend: 1200, prior90Spend: 1000, daysSinceLastOrder: 5, medianGap: 20 }),
    ).toBe("growing");
  });
  test("declining at <= 0.7x, steady in between", () => {
    expect(
      trendBadge({ t90Spend: 600, prior90Spend: 1000, daysSinceLastOrder: 10, medianGap: 20 }),
    ).toBe("declining");
    expect(
      trendBadge({ t90Spend: 950, prior90Spend: 1000, daysSinceLastOrder: 10, medianGap: 20 }),
    ).toBe("steady");
  });
  test("prior 90d empty but ordering now → growing", () => {
    expect(
      trendBadge({ t90Spend: 400, prior90Spend: 0, daysSinceLastOrder: 12, medianGap: null }),
    ).toBe("growing");
  });
});

describe("seasonFlag", () => {
  // season window = generation month ±1, compared year-on-year
  test("flags when last year's Aug-Oct had orders and this year's has none", () => {
    const docs = [doc("2025-09-10", 300)];
    expect(seasonFlag(docs, "2026-09-01")).toEqual({
      flagged: true,
      lastYearSeasonSpend: 300,
    });
  });
  test("season window is prev/current/next month", () => {
    const docsNext = [doc("2025-10-05", 10)]; // Oct = next month relative to Sep genDate
    expect(seasonFlag(docsNext, "2026-09-01").lastYearSeasonSpend).toBe(10);
  });
  test("not flagged when this season already ordered", () => {
    const docs = [doc("2025-09-10", 300), doc("2026-08-20", 100)];
    expect(seasonFlag(docs, "2026-09-01").flagged).toBe(false);
  });
  test("not flagged when last year had no season orders", () => {
    expect(seasonFlag([doc("2025-02-01", 50)], "2026-09-01").flagged).toBe(false);
  });
});
