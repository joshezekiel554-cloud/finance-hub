# Spec — Team Activity report (admin-only)

Status: APPROVED (operator signed off mockup + Option B), 2026-06-29.
Mockup: `.superpowers/team-activity-mockup.html` (rendered → operator approved).

## Goal

An admin-only finance-hub page that shows **everything a teammate has done** over a
date range — emails sent, phone calls, tasks, finance actions (holds/statements/
invoices), notes, and **active time** — merged into one chronological timeline with
summary stat tiles and CSV export. Data spans BOTH apps: finance (this app) + the
co-tenant inbox. Generic per-teammate (not just Hillel).

## Access control

- Gate every route + the nav link + the page `beforeLoad` on `isAdmin(user)`
  (`src/server/lib/auth.ts:150`). Prod `ADMIN_EMAILS` is already exactly
  `joshezekiel554@gmail.com,info@feldart.com,info@feldartcollection.co.uk`
  (Josh's two accounts + Shaya) and EXCLUDES Hillel (hschijves@gmail.com). No new env.
- Non-admins: nav link hidden; direct nav redirects to `/`; API returns 403.

## Data model (new)

### 1. `user_active_minutes` (heartbeat → active time)
Distinct UTC epoch-minute stamps per user. Set semantics (idempotent).
```
userId    varchar(255) FK users.id, notNull
minuteUtc int  notNull            -- floor(unixSeconds / 60)
PRIMARY KEY (userId, minuteUtc)
index (userId, minuteUtc)
```
Migration: new table only. Forward-only data.

### 2. Phone extension → user map
Store as `app_settings` key `phone_extension_user_map` = JSON `{ "102": "<userId>" }`.
Seed `102` → Hillel's userId (`4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7`) on prod after deploy.
No schema change.

## Backend

### Heartbeat
- `POST /api/heartbeat` (requireAuth, any user): upsert `(userId, floor(now/60))` into
  `user_active_minutes` (INSERT IGNORE / onDuplicateKeyUpdate noop). Cheap, no body.
- Frontend pings every 60s while the tab is **visible AND the user is active**
  (mousemove/keydown/scroll within the last 60s; skip if idle or hidden).

### Aggregation module `src/modules/team-activity/`
`gatherFinanceActivity(userId, fromIso, toIso): Promise<FinanceActivity>`
Pulls + normalizes finance-side events into a common `ActivityEvent` shape:
```
type ActivityEvent = {
  id: string;
  at: string;                 // ISO UTC
  source: "finance" | "inbox";
  type: string;               // see types below
  title: string;
  detail?: string | null;
  customerId?: string | null; // finance customer id
  customerName?: string | null;
  link?: { kind: string; id: string } | null;
}
```
Finance sources (all attributed by userId, timestamped):
- **email_sent** — `email_log` where `direction='outbound'` AND `userId=?`. Title
  `Emailed {customer} — "{subject}"`. (Finance-app sends only; inbox sends come from inbox.)
- **call** — `phone_communications` where `extensionNumber` maps (via the ext map) to `userId`,
  `startedAt` in range. Title `Outbound/Inbound call · {customer} · {mm:ss}`; detail ext + number;
  link transcript if `recordingMediaId`/`transcription`.
- **finance actions** — `audit_log` where `userId=?` in range, for the action set that matters
  (hold placed/released/cancelled, statement sent, invoice sent, return actions, proposal decided,
  note edits). Map each `action` to a friendly title. Use before/after for detail where useful.
- Also fold `statement_sends.sentByUserId` + `invoices.sentByUserId` directly if not already in
  audit_log (dedupe by entity id so a send isn't doubled).
- **active markers** — first + last `minuteUtc` per day from `user_active_minutes` →
  synthetic "Started working" / "Last activity" rows (finance side; inbox markers from its set).

Counts (finance): emailsSent, calls (+ totalTalkSeconds), holds, statements, invoices.
Active minutes (finance): the raw distinct `minuteUtc[]` in range.

### Merge with inbox
- `GET /api/svc/member-activity?memberId=&from=&to=` via `inboxFetch` (already wired,
  `INBOX_SERVICE_TOKEN` + `INBOX_BASE_URL`). Resolve finance user → inbox memberId via
  `resolveMemberByEmail` (`src/integrations/inbox/members.ts`).
- Map inbox events → `ActivityEvent` (source:"inbox"). `customerFinanceId` → customerId.
- **Active time combined** = `union(financeMinuteSet, inboxMinuteSet)` (distinct minute ints) →
  total minutes; per-app totals = each set's size; per-day rollups by grouping minutes by
  calendar day in **Europe/London**.
- Timeline = finance events + inbox events, sorted by `at` desc, grouped by day (Europe/London).
- If inbox is unreachable, degrade gracefully: show finance-only + a soft "inbox data unavailable" note.

### Routes (all admin-gated except heartbeat)
- `GET /api/team-activity/members` → `[{ userId, name, email, inboxMemberId|null }]` for the picker
  (finance `user` table; everyone, incl. Hillel — he's a valid REPORT SUBJECT, just not a viewer).
- `GET /api/team-activity?userId=&from=&to=` → `{ subject, range, counts, activeTime, events }`.
- `GET /api/team-activity/export.csv?userId=&from=&to=` → `text/csv` attachment of the timeline
  (columns: date, time, source, type, title, detail, customer). Use `papaparse` if present else manual.
- `POST /api/heartbeat` → 204.

## Frontend `src/web/pages/team-activity.tsx`
- Route in `src/web/main.tsx` (`/team-activity`, `beforeLoad` isAdmin redirect).
- Nav item in `src/web/App.tsx` `baseNavItems`, filtered out for non-admins (needs the session
  user's admin flag client-side — expose via the existing session/me endpoint or a small `isAdmin`
  field on the user context).
- Controls: teammate picker (default = first non-admin teammate, or remembered), date-range segmented
  (Today / This week / Last 7 days / This month / Custom), Export CSV button.
- Stat tiles: **Active time is the HERO tile** (larger), then Emails sent, Calls (+talk-time),
  Tasks (completed · created), Finance actions — secondary.
- Filter chips: All / Emails / Calls / Tasks / Actions (NO "active time" chip — it's markers+totals).
- Timeline: day-grouped (day header shows per-day active total), each row = time · token-colored dot ·
  title · detail · click-through link. Row-dot colors MUST use the finance design tokens
  (accent-info=email, accent-success=call, 290-hue=task, accent-warning=action, accent-primary=send,
  muted=active marker) — no ad-hoc hex.
- **Empty state** ("No activity for {name} in this range") + **loading skeleton**.
- Mobile: row-card fallback is nice-to-have, not required for v1.

## Tests
- aggregation: extension→user mapping, audit→title mapping, active-minute union (both-tabs dedupe),
  email outbound filter, date-range boundaries.
- routes: admin gate (Hillel 403, Josh/Shaya 200), heartbeat upsert idempotent, CSV shape.
- inbox-unreachable degradation.

## Out of scope (v1)
- Weekly emailed digest (later).
- Backfill of active-time / task-completion (forward-only by nature).
