// Pure time-math tests for the Time Clock helpers. No DB, no network — all
// instants are explicit epoch-ms so the math is deterministic. London is BST
// (UTC+1) at the end of June, which the per-day / boundary cases rely on.

import { describe, expect, it } from "vitest";
import {
  clampedMinutes,
  isStaleOpen,
  londonDayKey,
  openElapsedMinutes,
  perDayMinutes,
  startOfLondonDay,
  startOfLondonWeek,
  STALE_OPEN_MS,
} from "./helpers.js";

const ms = (iso: string) => Date.parse(iso);

describe("clampedMinutes", () => {
  it("counts a completed session fully inside the window", () => {
    const s = { inMs: ms("2026-06-29T09:00:00Z"), outMs: ms("2026-06-29T11:30:00Z") };
    expect(clampedMinutes(s, ms("2026-06-29T00:00:00Z"), ms("2026-06-30T00:00:00Z"), ms("2026-06-29T12:00:00Z"))).toBe(150);
  });

  it("clamps to the window boundaries", () => {
    const s = { inMs: ms("2026-06-28T23:00:00Z"), outMs: ms("2026-06-29T01:00:00Z") };
    // window starts at 00:00 → only the 00:00–01:00 hour counts.
    expect(clampedMinutes(s, ms("2026-06-29T00:00:00Z"), ms("2026-06-30T00:00:00Z"), ms("2026-06-29T12:00:00Z"))).toBe(60);
  });

  it("treats an open session as running until now, clamped to the window", () => {
    const s = { inMs: ms("2026-06-29T09:00:00Z"), outMs: null };
    expect(clampedMinutes(s, ms("2026-06-29T00:00:00Z"), ms("2026-06-30T00:00:00Z"), ms("2026-06-29T09:45:00Z"))).toBe(45);
  });

  it("returns 0 for a session entirely outside the window", () => {
    const s = { inMs: ms("2026-06-20T09:00:00Z"), outMs: ms("2026-06-20T10:00:00Z") };
    expect(clampedMinutes(s, ms("2026-06-29T00:00:00Z"), ms("2026-06-30T00:00:00Z"), ms("2026-06-29T12:00:00Z"))).toBe(0);
  });
});

describe("openElapsedMinutes", () => {
  it("is 0 for a completed session", () => {
    const s = { inMs: ms("2026-06-29T09:00:00Z"), outMs: ms("2026-06-29T10:00:00Z") };
    expect(openElapsedMinutes(s, ms("2026-06-29T12:00:00Z"))).toBe(0);
  });
  it("is the elapsed whole minutes for an open session", () => {
    const s = { inMs: ms("2026-06-29T09:00:00Z"), outMs: null };
    expect(openElapsedMinutes(s, ms("2026-06-29T09:30:30Z"))).toBe(30);
  });
});

describe("perDayMinutes", () => {
  it("splits a session across London-midnight into two day buckets", () => {
    // 23:30 BST (22:30Z) → 00:30 BST (23:30Z) = 60 minutes spanning the London
    // midnight (00:00 BST = 23:00Z). 30 min in each London day.
    const s = { inMs: ms("2026-06-29T22:30:00Z"), outMs: ms("2026-06-29T23:30:00Z") };
    const split = perDayMinutes(s, ms("2026-06-29T00:00:00Z"), ms("2026-07-01T00:00:00Z"), ms("2026-06-30T12:00:00Z"));
    expect(split["2026-06-29"]).toBe(30);
    expect(split["2026-06-30"]).toBe(30);
  });

  it("clamps an open session to now and to the window", () => {
    const s = { inMs: ms("2026-06-29T09:00:00Z"), outMs: null };
    const split = perDayMinutes(s, ms("2026-06-29T00:00:00Z"), ms("2026-06-30T00:00:00Z"), ms("2026-06-29T09:20:00Z"));
    expect(split["2026-06-29"]).toBe(20);
  });
});

describe("isStaleOpen", () => {
  it("is false for a completed session", () => {
    const s = { inMs: ms("2026-06-29T09:00:00Z"), outMs: ms("2026-06-29T10:00:00Z") };
    expect(isStaleOpen(s, ms("2026-06-30T12:00:00Z"))).toBe(false);
  });

  it("is true when an open session has run past the 16h ceiling", () => {
    const inMs = ms("2026-06-29T01:00:00Z");
    const s = { inMs, outMs: null };
    expect(isStaleOpen(s, inMs + STALE_OPEN_MS + 1)).toBe(true);
  });

  it("is true when an open session crossed a London midnight (different day)", () => {
    // In yesterday (BST), now today, well under 16h.
    const s = { inMs: ms("2026-06-29T22:00:00Z"), outMs: null }; // 23:00 BST 29th
    const now = ms("2026-06-30T06:00:00Z"); // 07:00 BST 30th → 8h, but new day
    expect(isStaleOpen(s, now)).toBe(true);
  });

  it("is false for a fresh same-day open session", () => {
    const s = { inMs: ms("2026-06-29T09:00:00Z"), outMs: null };
    expect(isStaleOpen(s, ms("2026-06-29T11:00:00Z"))).toBe(false);
  });
});

describe("London day/week boundaries (BST = UTC+1 at end of June)", () => {
  it("startOfLondonDay lands on London-local midnight (23:00Z prior day in BST)", () => {
    const start = startOfLondonDay(ms("2026-06-29T14:00:00Z"));
    // London midnight on 2026-06-29 (BST) = 2026-06-28T23:00:00Z.
    expect(new Date(start).toISOString()).toBe("2026-06-28T23:00:00.000Z");
    expect(londonDayKey(start)).toBe("2026-06-29");
  });

  it("startOfLondonWeek lands on Monday 00:00 London", () => {
    // 2026-06-29 is a Monday; 2026-07-01 is a Wednesday.
    const wed = ms("2026-07-01T14:00:00Z");
    const weekStart = startOfLondonWeek(wed);
    // Monday 2026-06-29 London midnight = 2026-06-28T23:00:00Z.
    expect(new Date(weekStart).toISOString()).toBe("2026-06-28T23:00:00.000Z");
    expect(londonDayKey(weekStart)).toBe("2026-06-29");
  });

  it("week-start of a Monday is that same Monday's midnight", () => {
    const mon = ms("2026-06-29T10:00:00Z");
    expect(startOfLondonWeek(mon)).toBe(startOfLondonDay(mon));
  });
});
