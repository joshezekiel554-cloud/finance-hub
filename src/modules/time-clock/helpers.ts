// Pure, DB-free time math for the Time Clock feature. Kept separate from the
// DB-backed service so the tricky bits (range-clamping a session, per-
// Europe/London-day split, stale detection, today/week rollups) are unit-
// testable with no database.
//
// All instants are epoch-milliseconds. "Now" is always passed in explicitly so
// the math is deterministic under test.

const LONDON = "Europe/London";

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: LONDON,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD calendar day in Europe/London for an epoch-ms instant. */
export function londonDayKey(ms: number): string {
  return dayKeyFmt.format(new Date(ms));
}

// How long an open (un-clocked-out) session may run before it's flagged stale,
// independent of any midnight crossing. 16h is the spec's suggested ceiling.
export const STALE_OPEN_MS = 16 * 60 * 60 * 1000;

/** A clock session as the math needs it: an interval, possibly still open. */
export type SessionInterval = {
  /** clock-in instant, epoch-ms. */
  inMs: number;
  /** clock-out instant, epoch-ms; null = still open. */
  outMs: number | null;
};

/**
 * Minutes a session contributes inside the half-open window [fromMs, toMs).
 * An open session is treated as running until `nowMs` (then clamped to the
 * window). Returns a non-negative integer count of minutes (floored).
 */
export function clampedMinutes(
  session: SessionInterval,
  fromMs: number,
  toMs: number,
  nowMs: number,
): number {
  const endRaw = session.outMs ?? nowMs;
  const start = Math.max(session.inMs, fromMs);
  const end = Math.min(endRaw, toMs);
  if (end <= start) return 0;
  return Math.floor((end - start) / 60_000);
}

/** Elapsed whole minutes of an open session up to `nowMs` (0 if not open / future). */
export function openElapsedMinutes(
  session: SessionInterval,
  nowMs: number,
): number {
  if (session.outMs !== null) return 0;
  if (nowMs <= session.inMs) return 0;
  return Math.floor((nowMs - session.inMs) / 60_000);
}

/**
 * Split a session's minutes across the Europe/London calendar days it spans,
 * clamped to [fromMs, toMs) and (for open sessions) to `nowMs`. Keyed YYYY-MM-DD.
 *
 * Walks minute-by-minute over the clamped interval so DST boundaries and the
 * London-midnight split are handled by the formatter rather than hand-rolled
 * offset math. A clamped span is at most the report window, so the loop stays
 * bounded for realistic ranges.
 */
export function perDayMinutes(
  session: SessionInterval,
  fromMs: number,
  toMs: number,
  nowMs: number,
): Record<string, number> {
  const endRaw = session.outMs ?? nowMs;
  const start = Math.max(session.inMs, fromMs);
  const end = Math.min(endRaw, toMs);
  const out: Record<string, number> = {};
  if (end <= start) return out;
  // Align to minute boundaries; count each whole minute under the day it starts.
  const firstMinute = Math.floor(start / 60_000);
  const lastMinuteExclusive = Math.floor(end / 60_000);
  for (let m = firstMinute; m < lastMinuteExclusive; m++) {
    const key = londonDayKey(m * 60_000);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Is this open session stale? Stale = open AND (running ≥ STALE_OPEN_MS OR open
 * across at least one Europe/London midnight, i.e. clock-in day ≠ today's day).
 * A completed session is never stale.
 */
export function isStaleOpen(session: SessionInterval, nowMs: number): boolean {
  if (session.outMs !== null) return false;
  if (nowMs - session.inMs >= STALE_OPEN_MS) return true;
  return londonDayKey(session.inMs) !== londonDayKey(nowMs);
}

// --- Today / week window boundaries (Europe/London) -------------------------

// We derive London wall-clock parts via the formatter, then reconstruct the
// UTC instant of London-local midnight by subtracting the parts. This avoids a
// dependency while staying correct across DST (the offset is read from the same
// instant we're bucketing).

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type LondonParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday … 6 = Sunday. */
  weekdayMon0: number;
};

const WEEKDAY_MON0: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function londonParts(ms: number): LondonParts {
  const parts = partsFmt.formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24, // en-GB sometimes emits "24" at midnight
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekdayMon0: WEEKDAY_MON0[get("weekday")] ?? 0,
  };
}

/** Epoch-ms of the most recent Europe/London midnight at or before `nowMs`. */
export function startOfLondonDay(nowMs: number): number {
  const p = londonParts(nowMs);
  // Whole wall-clock ms since London midnight, INCLUDING the sub-second
  // remainder of `nowMs` (the formatter only gives whole seconds) — drop both
  // so the result lands exactly on midnight rather than drifting by <1s.
  const sinceMidnightMs =
    ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (nowMs % 1000);
  // Subtracting the wall-clock time since midnight lands on London-local
  // midnight regardless of the current UTC offset.
  return nowMs - sinceMidnightMs;
}

/** Epoch-ms of the most recent Monday-00:00 Europe/London at or before `nowMs`. */
export function startOfLondonWeek(nowMs: number): number {
  const startOfToday = startOfLondonDay(nowMs);
  const dow = londonParts(nowMs).weekdayMon0;
  // Step back `dow` London-days. Re-derive each day's midnight so a DST change
  // mid-week doesn't drift the boundary by an hour.
  let cursor = startOfToday;
  for (let i = 0; i < dow; i++) {
    cursor = startOfLondonDay(cursor - 1);
  }
  return cursor;
}
