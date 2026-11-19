// "Has this customer promised to pay?" — one answer for every chase path.
//
// customers.promised_pay_by is a calendar date (YYYY-MM-DD, compared as a UTC
// calendar day, same as the hub contract). The promise is ACTIVE while the
// date is today or later: chasing stays paused through the whole promised
// day and resumes the day after. Pure helpers + one SQL fragment; no DB I/O.

import { isNull, lt, or, type SQL } from "drizzle-orm";
import { customers } from "../../db/schema/customers.js";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's UTC calendar day as YYYY-MM-DD. */
export function todayYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Normalise a DATE column value (string or Date from mysql2) to YYYY-MM-DD. */
export function toYmd(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
  const s = v.trim().slice(0, 10);
  return YMD_RE.test(s) ? s : null;
}

/** True when `s` is a real calendar date in YYYY-MM-DD form (no 2026-02-30). */
export function isRealYmd(s: string): boolean {
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole days from calendar day `from` to calendar day `to` (both YYYY-MM-DD). */
export function ymdDiffDays(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

/** Active = promised date is today (UTC) or later. */
export function isPromiseActive(
  promisedPayBy: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const ymd = toYmd(promisedPayBy);
  return ymd !== null && ymd >= todayYmd(now);
}

/**
 * Validate a promise date coming from a caller. Returns an error message or
 * null when fine. Past dates (before today, UTC) are refused.
 */
export function promiseDateError(date: unknown, now: Date = new Date()): string | null {
  if (typeof date !== "string" || !isRealYmd(date)) return "date must be a real calendar date in YYYY-MM-DD form";
  if (date < todayYmd(now)) return "date is in the past";
  return null;
}

/**
 * SQL condition "this customer has NO active promise" for queries that read
 * the customers table. Pair it with a JS check (isPromiseActive) wherever the
 * row is loaded anyway, so tests with a mocked DB still exercise the rule.
 */
export function noActivePromiseSql(now: Date = new Date()): SQL {
  return or(isNull(customers.promisedPayBy), lt(customers.promisedPayBy, todayYmd(now))) as SQL;
}

/**
 * End of the promised day in New York (the warehouse's day) — the same
 * convention the order-level "pause chasing until" picker uses, so an order
 * paused from a customer promise behaves exactly like one paused by hand.
 */
export function endOfDayNewYork(ymd: string): Date | null {
  const d = new Date(`${ymd}T23:59:00-04:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Calendar date (YYYY-MM-DD) of an instant in New York. */
export function newYorkYmd(d: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
