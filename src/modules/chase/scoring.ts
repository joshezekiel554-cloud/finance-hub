// Severity scoring for overdue customers.
//
// Ported from 1.0's `dashboard/chase-engine.js` (computeScore + tierForScore).
// Formula and tier thresholds come from the team-lead brief for the 2.0 port:
//
//   score = overdue × min(daysOverdue, 365) / 30
//
//   tier = CRITICAL  if score >= 50000
//          HIGH      if score >= 20000
//          MEDIUM    if score >= 5000
//          LOW       otherwise
//
// Day cap at 365 prevents long-aged debt from dominating the ranking purely on
// staleness — a £100 invoice 3 years overdue shouldn't outweigh a £10k invoice
// 60 days overdue. Pure function; no DB access. See chase.test.ts for boundary
// coverage.

import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type { Severity, ChaseTier } from "./types.js";

const DAY_MS = 1000 * 60 * 60 * 24;
const MAX_DAYS = 365;

const CRITICAL_THRESHOLD = 50000;
const HIGH_THRESHOLD = 20000;
const MEDIUM_THRESHOLD = 5000;

export function tierForScore(score: number): ChaseTier {
  if (score >= CRITICAL_THRESHOLD) return "CRITICAL";
  if (score >= HIGH_THRESHOLD) return "HIGH";
  if (score >= MEDIUM_THRESHOLD) return "MEDIUM";
  return "LOW";
}

export function daysBetween(from: Date | string | null, to: Date = new Date()): number {
  if (!from) return 0;
  const d = typeof from === "string" ? new Date(from) : from;
  if (Number.isNaN(d.getTime())) return 0;
  const diff = to.getTime() - d.getTime();
  return Math.max(0, Math.floor(diff / DAY_MS));
}

export function computeScore(totalOverdue: number, daysOverdue: number): number {
  if (!totalOverdue || totalOverdue <= 0) return 0;
  const cappedDays = Math.min(Math.max(0, daysOverdue), MAX_DAYS);
  return Math.round(totalOverdue * (cappedDays / 30));
}

// Sums balance of customer's invoices that are past due AND still have balance.
// Mirrors 1.0's overdue calculation: dueDate < today && balance > 0.
// Customers carry a denormalized `overdueBalance` (DECIMAL stored as string in
// MySQL); use that as the authoritative figure when present, falling back to
// summing the supplied invoice list. Both paths align because QB sync is what
// populates the denormalized column.
export function computeSeverity(customer: Customer, invoices: Invoice[]): Severity {
  const today = startOfDayUtc(new Date());

  const openOverdue = invoices.filter((inv) => {
    const balance = parseMoney(inv.balance);
    if (balance <= 0) return false;
    if (!inv.dueDate) return false;
    const due = startOfDayUtc(toDate(inv.dueDate));
    return due.getTime() < today.getTime();
  });

  const totalOverdueFromInvoices = openOverdue.reduce(
    (sum, inv) => sum + parseMoney(inv.balance),
    0,
  );

  const denormalizedOverdue = parseMoney(customer.overdueBalance);
  const totalOverdue =
    denormalizedOverdue > 0 ? denormalizedOverdue : totalOverdueFromInvoices;

  let oldestDate: Date | null = null;
  for (const inv of openOverdue) {
    if (!inv.dueDate) continue;
    const due = toDate(inv.dueDate);
    if (oldestDate === null || due.getTime() < oldestDate.getTime()) {
      oldestDate = due;
    }
  }

  const daysOverdue = oldestDate ? daysBetween(oldestDate, today) : 0;
  const score = computeScore(totalOverdue, daysOverdue);
  const tier = tierForScore(score);

  return {
    score,
    tier,
    daysOverdue,
    totalOverdue: round2(totalOverdue),
    oldestUnpaidDate: oldestDate ? oldestDate.toISOString().slice(0, 10) : null,
  };
}

function parseMoney(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toDate(v: string | Date): Date {
  if (v instanceof Date) return v;
  // Drizzle stores `date` columns as 'YYYY-MM-DD'. Construct UTC to keep
  // date-only semantics; otherwise local TZ shifts could roll the day.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return new Date(v);
}

function startOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
