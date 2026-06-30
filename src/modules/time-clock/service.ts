// DB-backed Time Clock service. Wraps the pure helpers with the persistence +
// audit + allow-list reads. Enabled only for users in the `time_clock_user_ids`
// app-setting (Hillel today). Every clock-in / clock-out writes an audit row.
//
// "At most one open session per user" is enforced here, not in the schema:
// clockIn refuses when an open session exists; clockOut closes the open one.

import { and, asc, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  timeClockSessions,
  type TimeClockSession,
} from "../../db/schema/time-clock-sessions.js";
import { createLogger } from "../../lib/logger.js";
import type { ActivityEvent } from "../team-activity/types.js";
import {
  clampedMinutes,
  isStaleOpen,
  perDayMinutes,
  startOfLondonDay,
  startOfLondonWeek,
  type SessionInterval,
} from "./helpers.js";

const log = createLogger({ component: "time-clock.service" });

// --- allow-list -------------------------------------------------------------

/**
 * Parse the `time_clock_user_ids` app-setting (JSON array of userIds). Tolerates
 * missing / blank / malformed values → empty list (feature off), never throws.
 */
export function parseAllowList(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
}

async function loadAllowList(): Promise<string[]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "time_clock_user_ids"))
    .limit(1);
  return parseAllowList(rows[0]?.value);
}

/** Is the Time Clock enabled for this user (i.e. userId ∈ allow-list)? */
export async function isClockEnabled(userId: string): Promise<boolean> {
  const list = await loadAllowList();
  return list.includes(userId);
}

// --- queries ----------------------------------------------------------------

async function getOpenSession(
  userId: string,
): Promise<TimeClockSession | null> {
  const rows = await db
    .select()
    .from(timeClockSessions)
    .where(
      and(
        eq(timeClockSessions.userId, userId),
        isNull(timeClockSessions.clockOutAt),
      ),
    )
    // Defensive: if more than one ever leaked in, act on the newest.
    .orderBy(desc(timeClockSessions.clockInAt))
    .limit(1);
  return rows[0] ?? null;
}

async function writeAudit(args: {
  userId: string;
  action: "time_clock.in" | "time_clock.out";
  sessionId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId: args.userId,
    action: args.action,
    entityType: "time_clock_session",
    entityId: args.sessionId,
    before: args.before ?? undefined,
    after: args.after,
  });
}

// --- mutations --------------------------------------------------------------

export type ClockResult =
  | { ok: true; session: TimeClockSession }
  | { ok: false; reason: "already_open" | "not_open" };

/** Open a new clock session. Refuses (already_open) if one is already open. */
export async function clockIn(userId: string): Promise<ClockResult> {
  const open = await getOpenSession(userId);
  if (open) return { ok: false, reason: "already_open" };

  const id = nanoid(24);
  const clockInAt = new Date();
  await db.insert(timeClockSessions).values({ id, userId, clockInAt });

  const rows = await db
    .select()
    .from(timeClockSessions)
    .where(eq(timeClockSessions.id, id))
    .limit(1);
  const session = rows[0]!;

  await writeAudit({
    userId,
    action: "time_clock.in",
    sessionId: id,
    before: null,
    after: { clockInAt: clockInAt.toISOString() },
  });
  log.info({ userId, sessionId: id }, "clock in");
  return { ok: true, session };
}

/** Close the user's open session. Returns not_open if none is open. */
export async function clockOut(userId: string): Promise<ClockResult> {
  const open = await getOpenSession(userId);
  if (!open) return { ok: false, reason: "not_open" };

  const clockOutAt = new Date();
  await db
    .update(timeClockSessions)
    .set({ clockOutAt })
    .where(eq(timeClockSessions.id, open.id));

  const rows = await db
    .select()
    .from(timeClockSessions)
    .where(eq(timeClockSessions.id, open.id))
    .limit(1);
  const session = rows[0]!;

  await writeAudit({
    userId,
    action: "time_clock.out",
    sessionId: open.id,
    before: { clockInAt: open.clockInAt.toISOString(), clockOutAt: null },
    after: {
      clockInAt: open.clockInAt.toISOString(),
      clockOutAt: clockOutAt.toISOString(),
    },
  });
  log.info({ userId, sessionId: open.id }, "clock out");
  return { ok: true, session };
}

// --- status -----------------------------------------------------------------

export type ClockStatus = {
  enabled: boolean;
  /** The currently-open session's clock-in instant (ISO), or null. */
  open: { clockInAt: string } | null;
  /** True when the open session is stale (across a London midnight or >16h). */
  stale: boolean;
  todayMinutes: number;
  weekMinutes: number;
};

function toInterval(s: TimeClockSession): SessionInterval {
  return {
    inMs: s.clockInAt.getTime(),
    outMs: s.clockOutAt ? s.clockOutAt.getTime() : null,
  };
}

/**
 * Status for the dashboard card: enabled flag, the open session (if any) + its
 * stale flag, and today / this-week minute totals (Europe/London; week is
 * Monday-start). Disabled users get enabled:false and zeroed totals — the card
 * hides on that.
 */
export async function getStatus(userId: string): Promise<ClockStatus> {
  const enabled = await isClockEnabled(userId);
  if (!enabled) {
    return { enabled: false, open: null, stale: false, todayMinutes: 0, weekMinutes: 0 };
  }

  const nowMs = Date.now();
  const dayStart = startOfLondonDay(nowMs);
  const weekStart = startOfLondonWeek(nowMs);

  // Pull every session that could overlap [weekStart, now]: any session whose
  // clock-out is null (open) OR whose clock-out is ≥ weekStart, AND that started
  // before now. Cheapest correct filter: clockInAt < now AND (open OR clockOutAt
  // ≥ weekStart). We over-fetch slightly (open sessions started long ago) and
  // let the clamp zero them out of the window.
  const rows = await db
    .select()
    .from(timeClockSessions)
    .where(
      and(
        eq(timeClockSessions.userId, userId),
        lt(timeClockSessions.clockInAt, new Date(nowMs)),
        gte(timeClockSessions.clockInAt, new Date(weekStart - WEEK_LOOKBACK_MS)),
      ),
    );

  const toExclusive = nowMs; // [from, now)
  let todayMinutes = 0;
  let weekMinutes = 0;
  let open: { clockInAt: string } | null = null;
  let stale = false;
  for (const r of rows) {
    const iv = toInterval(r);
    todayMinutes += clampedMinutes(iv, dayStart, toExclusive, nowMs);
    weekMinutes += clampedMinutes(iv, weekStart, toExclusive, nowMs);
    if (iv.outMs === null) {
      open = { clockInAt: r.clockInAt.toISOString() };
      stale = isStaleOpen(iv, nowMs);
    }
  }

  return { enabled: true, open, stale, todayMinutes, weekMinutes };
}

// Open sessions can have started before the week began (e.g. a forgotten
// clock-out from days ago). Look back far enough to catch a stale open session
// while keeping the query bounded. 30 days comfortably covers any realistic
// forgotten-out, and the clamp still credits only in-window minutes.
const WEEK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// --- Team Activity merge ----------------------------------------------------

export type ClockedActivity = {
  /** Total clocked minutes inside [from, to): completed sessions clamped +
   * the open session's elapsed clamped to now. */
  clockedMinutes: number;
  /** Per-Europe/London-day clocked minutes, keyed YYYY-MM-DD. */
  perDayMinutes: Record<string, number>;
  /** True if an open session overlapping the window is stale. */
  openSessionStale: boolean;
  /** Clock-in / clock-out timeline rows (type "action"). */
  events: ActivityEvent[];
};

const clockTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Clocked-time slice for the Team Activity report over [fromIso, toIso).
 * Kept SEPARATE from the active-time sessionization — these are declared
 * timesheet hours, surfaced as their own tile + timeline rows.
 */
export async function getClockedActivity(
  userId: string,
  fromIso: string,
  toIso: string,
): Promise<ClockedActivity> {
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  const nowMs = Date.now();

  // Sessions that could overlap the window: started before `to`, and either
  // open or clocked-out at/after `from`. The clamp drops non-overlap.
  const rows = await db
    .select()
    .from(timeClockSessions)
    .where(
      and(
        eq(timeClockSessions.userId, userId),
        lt(timeClockSessions.clockInAt, new Date(toMs)),
      ),
    )
    .orderBy(asc(timeClockSessions.clockInAt));

  let clockedMinutes = 0;
  const perDay: Record<string, number> = {};
  let openSessionStale = false;
  const events: ActivityEvent[] = [];

  for (const r of rows) {
    const iv = toInterval(r);
    const mins = clampedMinutes(iv, fromMs, toMs, nowMs);
    clockedMinutes += mins;
    const split = perDayMinutes(iv, fromMs, toMs, nowMs);
    for (const [day, n] of Object.entries(split)) {
      perDay[day] = (perDay[day] ?? 0) + n;
    }

    // Clock-in row (only when the in-instant is inside the window).
    if (r.clockInAt.getTime() >= fromMs && r.clockInAt.getTime() < toMs) {
      events.push({
        id: `clock-in-${r.id}`,
        at: r.clockInAt.toISOString(),
        source: "finance",
        type: "action",
        title: "Clocked in",
        detail: `started ${clockTimeFmt.format(r.clockInAt)}`,
        link: null,
      });
    }

    if (r.clockOutAt) {
      // Clock-out row (only when the out-instant is inside the window).
      if (r.clockOutAt.getTime() >= fromMs && r.clockOutAt.getTime() < toMs) {
        const durMin = Math.max(
          0,
          Math.floor((r.clockOutAt.getTime() - r.clockInAt.getTime()) / 60_000),
        );
        events.push({
          id: `clock-out-${r.id}`,
          at: r.clockOutAt.toISOString(),
          source: "finance",
          type: "action",
          title: "Clocked out",
          detail: `${clockTimeFmt.format(r.clockOutAt)} · ${fmtDuration(durMin)} session`,
          link: null,
        });
      }
    } else if (isStaleOpen(iv, nowMs)) {
      openSessionStale = true;
    }
  }

  return { clockedMinutes, perDayMinutes: perDay, openSessionStale, events };
}
