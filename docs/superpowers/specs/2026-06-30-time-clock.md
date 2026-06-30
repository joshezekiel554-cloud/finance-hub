# Spec — Time Clock (Hillel timesheet)

Status: APPROVED by operator 2026-06-30 (radio). Finance-only; builds in parallel
with inbox's task/email reorder (no shared files).

## Goal

A manual clock-in / clock-out timesheet, enabled for Hillel only. He sees his
clocked hours on HIS dashboard; admins (Josh + Shaya) see his clocked hours on
the Team Activity page. This is DISTINCT from the auto "active time" already on
the report — clocked hours = declared timesheet, active time = app-observed.

## Access / gating

- Enabled for a configurable allow-list: app_settings key `time_clock_user_ids`
  (JSON array of userIds), SEED `["4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7"]` (Hillel).
- The dashboard card + the in/out routes are gated to users IN that list (403 / hidden otherwise).
- The Team Activity "Clocked hours" tile shows for any subject who HAS clock data
  (admins view it; gating there is the existing isAdmin page gate).
- Do NOT hardcode Hillel's id in code — read the allow-list from app_settings.

## Forgot-to-clock-out behavior (operator decision)

- NEVER auto-close a session. A session with no clockOut stays OPEN.
- An open session is FLAGGED when it's stale (open across a Europe/London midnight,
  OR open longer than, say, 16h). The UI shows "still clocked in since 9:02am — Nh"
  with a warning treatment. Flagging > silently inventing hours up to midnight.
- Completed sessions count toward hours; the open session shows running-but-flagged.

## Data model

`time_clock_sessions` (migration 0055):
```
id          varchar(24) PK
userId      varchar(255) FK users.id, notNull, index
clockInAt   timestamp notNull
clockOutAt  timestamp nullable
createdAt   timestamp default now
updatedAt   timestamp default now onUpdateNow
index (userId, clockInAt)
```
At most one OPEN (clockOutAt IS NULL) session per user — enforced in app logic
(clockIn refuses if one is open; clockOut closes the open one).

## Module `src/modules/time-clock/`

- `isClockEnabled(userId): Promise<boolean>` — userId ∈ app_settings allow-list.
- `clockIn(userId)` — if an open session exists → `{ ok:false, reason:"already_open" }`;
  else insert open session (audit `time_clock.in`). `{ ok:true, session }`.
- `clockOut(userId)` — close the open session (audit `time_clock.out`);
  `{ ok:false, reason:"not_open" }` if none.
- `getStatus(userId)` — `{ enabled, open: {clockInAt}|null, stale: boolean,
  todayMinutes, weekMinutes }` (today/week in Europe/London; week = Mon-start).
- `getClockedActivity(userId, fromIso, toIso)` — for the Team Activity merge:
  `{ clockedMinutes, perDayMinutes, openSessionStale, events: ActivityEvent[] }`
  where clockedMinutes = sum of completed sessions clamped to [from,to) + the open
  session's elapsed clamped to now; events = clock-in / clock-out timeline rows
  (type "action", title "Clocked in" / "Clocked out", detail the time/duration).
- Pure time math (clamping a session to a range, per-London-day split, stale
  detection) in a DB-free helpers file so it's unit-testable.

## Routes `src/server/routes/time-clock.ts` (registered at /api)

- `POST /api/time-clock/in`  (requireAuth; 403 if not clock-enabled) → 200 status | 409 already_open
- `POST /api/time-clock/out` (requireAuth; 403 if not enabled) → 200 status | 409 not_open
- `GET  /api/time-clock/status` (requireAuth) → the getStatus payload (enabled=false for non-allow-list users; the card hides on enabled=false)

## Frontend

- Dashboard card `src/web/pages/<dashboard>` (find the index/dashboard page): a
  "Time clock" card rendered ONLY when `GET /api/time-clock/status` returns
  enabled=true. Shows: status (Clocked in since H:MM / Clocked out), a live
  running timer while open, today's total, this week's total, an In/Out button
  (optimistic), and the stale flag when applicable. Finance design tokens only.
- Team Activity page `src/web/pages/team-activity.tsx`: add a "Clocked hours"
  stat tile (only render when the subject has clock data / clockedMinutes>0 or an
  open session), value = clocked hours, meta = e.g. "N sessions" + a flag if an
  open session is stale. Clock in/out rows already arrive via the timeline events.

## Team Activity wiring

In `report.ts` buildTeamActivityReport: call `getClockedActivity(subject.userId,
from, to)`, add its `events` to the timeline, and add `clockedMinutes` +
`clockedOpenStale` to the report (extend `ReportCounts` or a new `clocked` field
in the report type). The page reads it for the tile. Keep clocked SEPARATE from
activeTime — do not merge into the active-time sessionization.

## Tests

- module: clockIn refuses when open; clockOut closes; getStatus today/week math;
  getClockedActivity range-clamping + open-session elapsed + per-day split + stale.
- routes: non-enabled user → 403 on in/out + enabled:false on status; enabled user
  in→409-when-open, out→409-when-none; happy path.
- Team Activity: clocked tile data present for a subject with sessions.

## Out of scope (v1)

- Admin editing/correcting a session (later).
- Clock for users other than the allow-list.
