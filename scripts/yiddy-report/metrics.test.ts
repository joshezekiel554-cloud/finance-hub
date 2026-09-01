import { describe, expect, test } from "vitest";
import {
  ttmMonths,
  priorYearMonths,
  monthOf,
  bucketMonthly,
  windowTotals,
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
