// Customer-level "promised to pay by" display helpers (customer page + chase
// queue). Plain .ts so the rule is testable without a DOM: a promise is
// active through the promised day (UTC calendar day) — same as the server's
// modules/promises/promise-state.ts.

export type CustomerPromiseFields = {
  promisedPayBy?: string | null;
  promiseNote?: string | null;
  promiseSetBy?: string | null;
  promiseSetAt?: string | null;
};

export type ActivePromise = {
  date: string;
  note: string | null;
  setBy: string | null;
  setAt: string | null;
};

export function activePromise(c: CustomerPromiseFields, now: Date = new Date()): ActivePromise | null {
  const date = (c.promisedPayBy ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (date < now.toISOString().slice(0, 10)) return null;
  return { date, note: c.promiseNote?.trim() || null, setBy: c.promiseSetBy ?? null, setAt: c.promiseSetAt ?? null };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 21 Nov 2026" from YYYY-MM-DD (no timezone or locale drift). */
export function formatPromiseDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return ymd;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * "Promised to pay by Thu 21 Nov 2026 — wire Friday — set by josh@… via hub".
 * Promises are only saved from the hub today (finance can only clear them).
 */
export function promiseLine(p: ActivePromise): string {
  const parts = [`Promised to pay by ${formatPromiseDate(p.date)}`];
  if (p.note) parts.push(p.note);
  if (p.setBy) parts.push(`set by ${p.setBy} via hub`);
  return parts.join(" — ");
}
