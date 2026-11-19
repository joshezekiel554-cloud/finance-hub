// SKU → season map (served by the hub's proxy of the engine) and the pure
// "which season has this customer missed?" logic behind the season-missed
// signal. Fetching lives in sku-map.ts; everything here is pure.
//
// Map shape (hub, 2026-11-19): {generatedAt, windowWeeksBefore: 12,
//   skus: {"MEN01": {category, seasons: ["Chanukah"]}},   (SKUs upper-cased)
//   seasons: [{name, year, holiday: "YYYY-MM-DD", windowStart, windowEnd}]}
// windowStart = 12 weeks before the holiday. The map only lists this year +
// next, so the three PAST windows the rule needs are rebuilt from the Hebrew
// calendar (Intl's "hebrew" calendar) with the same offsets as the listed
// season — see pastWindows().

import { z } from "zod";
import { addDaysYmd } from "./story.js";
import { ymdDiffDays } from "../promises/promise-state.js";

export const skuMapSchema = z.object({
  generatedAt: z.string().optional(),
  windowWeeksBefore: z.number().optional(),
  skus: z.record(z.string(), z.object({ category: z.string().nullish(), seasons: z.array(z.string()).default([]) })),
  seasons: z.array(
    z.object({
      name: z.string().min(1),
      year: z.number().int(),
      holiday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      windowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      windowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
});
export type SkuMap = z.infer<typeof skuMapSchema>;
export type SeasonWindow = { name: string; year: number; windowStart: string; windowEnd: string; holiday?: string };

export const SEASON_RULES = {
  /** Lead before windowStart that still counts as buying for the season. */
  leadDays: 42,
  pastSeasons: 3,
};

// Hebrew-calendar date of each season's holiday (first day).
const HOLIDAY_HEBREW: Record<string, { month: string; day: number }> = {
  "rosh hashanah": { month: "Tishri", day: 1 },
  sukkos: { month: "Tishri", day: 15 },
  sukkot: { month: "Tishri", day: 15 },
  chanukah: { month: "Kislev", day: 25 },
  hanukkah: { month: "Kislev", day: 25 },
  pesach: { month: "Nisan", day: 15 },
  passover: { month: "Nisan", day: 15 },
};

const hebrewFmt = new Intl.DateTimeFormat("en-u-ca-hebrew", { month: "long", day: "numeric", timeZone: "UTC" });

/** Gregorian date (YYYY-MM-DD) of the season's holiday in `year`, or null if unknown. */
export function holidayYmd(season: string, year: number): string | null {
  const h = HOLIDAY_HEBREW[season.trim().toLowerCase()];
  if (!h) return null;
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86_400_000) {
    const parts = hebrewFmt.formatToParts(new Date(t + 12 * 3_600_000));
    const month = parts.find((p) => p.type === "month")?.value;
    const day = Number(parts.find((p) => p.type === "day")?.value);
    if (month === h.month && day === h.day) return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * The `n` windows of this season before `upcoming`: listed ones first, the
 * rest rebuilt from the holiday date with the upcoming window's offsets.
 * Returns fewer than n when a holiday can't be dated.
 */
export function pastWindows(map: SkuMap, upcoming: SeasonWindow, n = SEASON_RULES.pastSeasons): SeasonWindow[] {
  const listed = map.seasons
    .filter((s) => s.name === upcoming.name && s.year < upcoming.year)
    .sort((a, b) => b.year - a.year);
  const out: SeasonWindow[] = [];
  const hol = upcoming.holiday ?? holidayYmd(upcoming.name, upcoming.year);
  const startOff = hol ? ymdDiffDays(hol, upcoming.windowStart) : null;
  const endOff = hol ? ymdDiffDays(hol, upcoming.windowEnd) : null;
  for (let y = upcoming.year - 1; y >= upcoming.year - n; y--) {
    const l = listed.find((s) => s.year === y);
    if (l) {
      out.push(l);
      continue;
    }
    const h = holidayYmd(upcoming.name, y);
    if (!h || startOff === null || endOff === null) break;
    out.push({ name: upcoming.name, year: y, holiday: h, windowStart: addDaysYmd(h, startOff), windowEnd: addDaysYmd(h, endOff) });
  }
  return out;
}

export type SeasonPurchase = { customerId: string; date: string; values: Array<string | null>; amount: number };
export type SeasonMiss = {
  customerId: string;
  season: string;
  year: number;
  windowStart: string;
  windowEnd: string;
  pastYears: number[];
  /** Average spend on the season's SKUs per past window. */
  avgSpend: number;
};

/** Upper-cased SKU → its seasons. */
export function seasonIndex(map: SkuMap): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [sku, v] of Object.entries(map.skus)) {
    const k = sku.trim().toUpperCase();
    if (k && v.seasons.length) m.set(k, new Set(v.seasons));
  }
  return m;
}

/** The season windows that are "live" today: from windowStart − 6 weeks to windowEnd. */
export function liveSeasons(map: SkuMap, today: string): SeasonWindow[] {
  return map.seasons.filter((s) => today >= addDaysYmd(s.windowStart, -SEASON_RULES.leadDays) && today <= s.windowEnd);
}

/** Earliest purchase date the rule needs (for the loader's query). */
export function seasonLookbackFrom(map: SkuMap, today: string): string | null {
  let from: string | null = null;
  for (const up of liveSeasons(map, today)) {
    for (const w of pastWindows(map, up)) {
      const s = addDaysYmd(w.windowStart, -SEASON_RULES.leadDays);
      if (from === null || s < from) from = s;
    }
  }
  return from;
}

/**
 * season-missed: the customer bought the season's SKUs in each of the last 3
 * seasons' windows (or the 6 weeks before), has bought none this cycle
 * (from windowStart − 6 weeks), and today is between windowStart − 6 weeks
 * and windowEnd.
 */
export function findSeasonMisses(map: SkuMap, purchases: SeasonPurchase[], today: string): SeasonMiss[] {
  const idx = seasonIndex(map);
  const seasonsOf = (p: SeasonPurchase): Set<string> => {
    const out = new Set<string>();
    for (const v of p.values) {
      const s = v ? idx.get(v.trim().toUpperCase()) : undefined;
      if (s) for (const x of s) out.add(x);
    }
    return out;
  };
  const tagged = purchases.map((p) => ({ p, seasons: seasonsOf(p) })).filter((x) => x.seasons.size > 0);
  const out: SeasonMiss[] = [];
  for (const up of liveSeasons(map, today)) {
    const past = pastWindows(map, up);
    if (past.length < SEASON_RULES.pastSeasons) continue;
    const cycleFrom = addDaysYmd(up.windowStart, -SEASON_RULES.leadDays);
    const byCustomer = new Map<string, Array<{ date: string; amount: number }>>();
    for (const { p, seasons } of tagged) {
      if (!seasons.has(up.name)) continue;
      const arr = byCustomer.get(p.customerId) ?? [];
      arr.push({ date: p.date, amount: p.amount });
      byCustomer.set(p.customerId, arr);
    }
    for (const [customerId, buys] of byCustomer) {
      if (buys.some((b) => b.date >= cycleFrom && b.date <= today)) continue;
      const spends: number[] = [];
      for (const w of past) {
        const from = addDaysYmd(w.windowStart, -SEASON_RULES.leadDays);
        const inW = buys.filter((b) => b.date >= from && b.date <= w.windowEnd);
        if (inW.length === 0) break;
        spends.push(inW.reduce((s, b) => s + b.amount, 0));
      }
      if (spends.length < past.length) continue;
      out.push({
        customerId,
        season: up.name,
        year: up.year,
        windowStart: up.windowStart,
        windowEnd: up.windowEnd,
        pastYears: past.map((w) => w.year),
        avgSpend: Math.round(spends.reduce((s, x) => s + x, 0) / spends.length),
      });
    }
  }
  return out;
}
