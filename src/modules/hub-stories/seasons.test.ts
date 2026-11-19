import { describe, expect, it, vi } from "vitest";
import { findSeasonMisses, holidayYmd, liveSeasons, pastWindows, seasonLookbackFrom, SEASON_RULES, type SkuMap } from "./seasons.js";
import { createSkuMapCache, SKU_MAP_TTL_MS } from "./sku-map.js";
import { addDaysYmd } from "./story.js";

describe("holidayYmd (Hebrew calendar)", () => {
  it("dates the four seasons", () => {
    expect(holidayYmd("Rosh Hashanah", 2026)).toBe("2026-09-12");
    expect(holidayYmd("Sukkos", 2026)).toBe("2026-09-26");
    expect(holidayYmd("Chanukah", 2026)).toBe("2026-12-05");
    expect(holidayYmd("Pesach", 2026)).toBe("2026-04-02");
    expect(holidayYmd("Chanukah", 2024)).toBe("2024-12-26");
    expect(holidayYmd("Purim-ish", 2026)).toBeNull();
  });
});

// Chanukah 2026 = 2026-12-05; window 12 weeks before → 2026-09-12 … holiday + 8.
const chanukah2026 = { name: "Chanukah", year: 2026, holiday: "2026-12-05", windowStart: "2026-09-12", windowEnd: "2026-12-13" };
const map: SkuMap = {
  generatedAt: "2026-11-19T00:00:00Z",
  windowWeeksBefore: 12,
  skus: { MEN01: { category: "menorah", seasons: ["Chanukah"] }, SED01: { category: "seder", seasons: ["Pesach"] } },
  seasons: [chanukah2026, { name: "Chanukah", year: 2027, holiday: "2027-12-25", windowStart: "2027-10-02", windowEnd: "2028-01-02" }],
};

describe("pastWindows", () => {
  it("rebuilds the last three windows with the same offsets from the holiday", () => {
    const w = pastWindows(map, chanukah2026, 3);
    expect(w.map((x) => x.year)).toEqual([2025, 2024, 2023]);
    const h2024 = holidayYmd("Chanukah", 2024)!;
    expect(w[1]).toMatchObject({ holiday: h2024, windowStart: addDaysYmd(h2024, -84), windowEnd: addDaysYmd(h2024, 8) });
  });
});

describe("findSeasonMisses", () => {
  const buyIn = (customerId: string, year: number, values: Array<string | null> = ["Silver menorah", "MEN01", null], amount = 400) => {
    const h = holidayYmd("Chanukah", year)!;
    return { customerId, date: addDaysYmd(h, -40), values, amount };
  };
  const loyal = [buyIn("c1", 2025), buyIn("c1", 2024), buyIn("c1", 2023, ["men01", null, null], 200)];

  it("fires when they bought the last 3 seasons and nothing this cycle, from windowStart − 6 weeks", () => {
    const today = "2026-11-19";
    expect(liveSeasons(map, today).map((s) => s.year)).toEqual([2026]);
    const misses = findSeasonMisses(map, loyal, today, 3);
    expect(misses).toEqual([
      { customerId: "c1", season: "Chanukah", year: 2026, windowStart: "2026-09-12", windowEnd: "2026-12-13", pastYears: [2025, 2024, 2023], avgSpend: 333 },
    ]);
    expect(seasonLookbackFrom(map, today)! <= addDaysYmd(holidayYmd("Chanukah", 2024)!, -84 - 42)).toBe(true); // default 2 past seasons
  });

  it("quiet once they've bought this cycle, if a past season is missing, or outside the live span", () => {
    expect(findSeasonMisses(map, [...loyal, { customerId: "c1", date: "2026-08-20", values: ["MEN01"], amount: 1 }], "2026-11-19", 3)).toEqual([]);
    expect(findSeasonMisses(map, loyal.slice(0, 2), "2026-11-19", 3)).toEqual([]);
    expect(findSeasonMisses(map, loyal, "2026-07-01", 3)).toEqual([]); // before windowStart − 6 weeks
    expect(findSeasonMisses(map, loyal, "2026-12-14", 3)).toEqual([]); // after windowEnd
    // Another season's SKU doesn't count.
    const pesach = loyal.map((p) => ({ ...p, values: ["SED01"] }));
    expect(findSeasonMisses(map, pesach, "2026-11-19", 3)).toEqual([]);
  });
});

describe("createSkuMapCache", () => {
  it("is off without a URL or secret", async () => {
    const fetcher = vi.fn();
    expect(await createSkuMapCache({ url: undefined, secret: "s".repeat(32), fetcher }).get()).toBeNull();
    expect(await createSkuMapCache({ url: "http://x", secret: undefined, fetcher }).get()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches with a fresh app→hub token, caches, keeps the last good map on failure", async () => {
    let t = 0;
    const fetcher = vi.fn(async (_url: string, token: string) => {
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      return map;
    });
    const c = createSkuMapCache({ url: "http://127.0.0.1:3020/api/svc/sku-map", secret: "s".repeat(32), fetcher, nowMs: () => t });
    expect((await c.get())?.skus.MEN01?.seasons).toEqual(["Chanukah"]);
    await c.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    t = SKU_MAP_TTL_MS + 1;
    fetcher.mockRejectedValueOnce(new Error("down"));
    expect(await c.get()).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("throws with no map at all, rejects a bad shape", async () => {
    const c = createSkuMapCache({ url: "http://x", secret: "s".repeat(32), fetcher: async () => ({ nope: 1 }) });
    await expect(c.get()).rejects.toThrow();
  });
});

describe("SEASON_RULES default", () => {
  it("uses 2 past seasons while finance history only covers 2024 onwards", () => {
    expect(SEASON_RULES.pastSeasons).toBe(2);
  });
});
