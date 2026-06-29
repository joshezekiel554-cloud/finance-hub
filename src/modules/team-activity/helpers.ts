// Pure, DB-free helpers for the Team Activity report. Kept separate from the
// DB-backed gatherers so the tricky logic (extension mapping, audit→title,
// active-minute union, Europe/London day grouping) is unit-testable with no
// network or database.

import type {
  ActivityEvent,
  TimelineDay,
} from "./types.js";

// --- Phone extension → user map ---------------------------------------------

/**
 * Parse the `phone_extension_user_map` app-setting value (JSON `{ ext: userId }`)
 * into a typed map. Tolerates empty/blank/garbage input — returns an empty map
 * rather than throwing, so a missing or malformed setting degrades to "no calls
 * attributed" instead of breaking the whole report.
 */
export function parseExtensionUserMap(raw: string | null | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [ext, userId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof userId === "string" && userId.trim()) {
      out[ext.trim()] = userId.trim();
    }
  }
  return out;
}

/**
 * Invert the ext→user map to user→ext list. A single user may own multiple
 * extensions; this is what the call gatherer uses to select the user's calls.
 */
export function extensionsForUser(
  extMap: Record<string, string>,
  userId: string,
): string[] {
  return Object.entries(extMap)
    .filter(([, uid]) => uid === userId)
    .map(([ext]) => ext);
}

// --- Audit action → friendly title ------------------------------------------

/** Maps an `audit_log.action` to a human title for the timeline. */
const AUDIT_TITLES: Record<string, string> = {
  "order.hold_started": "Placed hold on order",
  "order.hold_released": "Released hold on order",
  "order.hold_cancelled": "Cancelled order",
  "order.hold_auto_released": "Hold auto-released",
  "order.review_dismissed": "Dismissed order review",
  "statement.send": "Sent statement",
  "issue_credit_memo": "Issued credit memo",
  "rma.completed": "Completed return",
  "customer.hold_toggle": "Toggled customer hold",
  "customer.update": "Updated customer",
};

/**
 * Friendly title for a finance audit row. Unknown actions fall back to a
 * de-namespaced, humanized form (e.g. "origin_review.invoice.override" →
 * "Origin review invoice override") so a newly-added action still renders
 * something sensible rather than a raw machine string.
 */
export function auditActionTitle(action: string): string {
  const known = AUDIT_TITLES[action];
  if (known) return known;
  const words = action.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which `ActivityEvent.type` bucket a finance audit action belongs to. */
export function auditEventType(action: string): "send" | "action" {
  // Statement / invoice sends get the distinct "send" dot (per the mockup);
  // everything else is a generic finance "action".
  if (action === "statement.send" || action.startsWith("invoice.send")) {
    return "send";
  }
  return "action";
}

// --- Active-minute set math -------------------------------------------------

/**
 * Union two active-minute sets into a sorted, de-duplicated array. A minute the
 * user was active in BOTH apps is counted once — this is the whole point of the
 * union (combined active time, not double-counted per-app time).
 */
export function unionActiveMinutes(a: number[], b: number[]): number[] {
  const set = new Set<number>();
  for (const m of a) set.add(m);
  for (const m of b) set.add(m);
  return [...set].sort((x, y) => x - y);
}

// --- Europe/London day grouping ---------------------------------------------

// Cached formatters keyed by intent. Intl is relatively expensive to construct;
// the report can group hundreds of events so we build each formatter once.
const LONDON = "Europe/London";

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: LONDON,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayLabelFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  weekday: "short",
  day: "2-digit",
  month: "short",
});

/** YYYY-MM-DD calendar day in Europe/London for an ISO-UTC instant. */
export function londonDayKey(iso: string): string {
  // en-CA yields YYYY-MM-DD directly.
  return dayKeyFmt.format(new Date(iso));
}

/** Human day label (e.g. "Mon 29 Jun") in Europe/London for an ISO-UTC instant. */
export function londonDayLabel(iso: string): string {
  return dayLabelFmt.format(new Date(iso));
}

/**
 * Which Europe/London calendar day an epoch-minute (floor(unixSeconds/60))
 * falls in. Used to roll active minutes up per day for the day-header totals.
 */
export function londonDayKeyForMinute(minuteUtc: number): string {
  return londonDayKey(new Date(minuteUtc * 60_000).toISOString());
}

/** Per-day active-minute totals keyed by Europe/London YYYY-MM-DD. */
export function activeMinutesPerDay(minutes: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  // Distinct minutes only — caller may pass the already-unioned set, but guard
  // anyway so a per-day total can never exceed 1440.
  for (const m of new Set(minutes)) {
    const key = londonDayKeyForMinute(m);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Group a flat event stream into day buckets (Europe/London), newest day first
 * and newest event first within a day. Active-minute totals per day are folded
 * in from the supplied per-day map.
 */
export function groupEventsByDay(
  events: ActivityEvent[],
  perDayActiveMinutes: Record<string, number>,
): TimelineDay[] {
  const byDay = new Map<string, ActivityEvent[]>();
  for (const ev of events) {
    const key = londonDayKey(ev.at);
    const list = byDay.get(key) ?? [];
    list.push(ev);
    byDay.set(key, list);
  }

  // Include days that have active minutes but no discrete events (e.g. the user
  // was present but every action landed in another app's stream) — they still
  // deserve a day header with the active total.
  for (const key of Object.keys(perDayActiveMinutes)) {
    if (!byDay.has(key)) byDay.set(key, []);
  }

  const days: TimelineDay[] = [...byDay.entries()].map(([day, evs]) => {
    evs.sort((a, b) => b.at.localeCompare(a.at));
    const label = evs[0]
      ? londonDayLabel(evs[0].at)
      : londonDayLabel(new Date(`${day}T12:00:00Z`).toISOString());
    return {
      day,
      label,
      activeMinutes: perDayActiveMinutes[day] ?? 0,
      events: evs,
    };
  });

  days.sort((a, b) => b.day.localeCompare(a.day));
  return days;
}

// --- Misc formatting --------------------------------------------------------

/** mm:ss for a (possibly null) duration in seconds. */
export function formatTalkTime(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}
