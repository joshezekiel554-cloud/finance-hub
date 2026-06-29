# Team Activity report — PROGRESS

Spec: `docs/superpowers/specs/2026-06-29-team-activity-report.md` (APPROVED 2026-06-29).
Mockup: `.superpowers/team-activity-mockup.html` (operator approved on radio).

## Decisions locked
- Admin-only finance-hub page, generic per-teammate. Gate = `isAdmin()` (prod ADMIN_EMAILS already = Josh×2 + Shaya, excludes Hillel). No new env.
- Data spans finance + inbox. De-dup boundary: inbox = native replies + tasks + comments/@mentions + notes; finance = its own emails/calls/holds/statements/invoices/proposals. Each email sent through exactly one app → counted once.
- Active time = heartbeat, forward-only, MINUTE granularity; combined = UNION of finance+inbox minute-sets (both-tabs-open dedupes).
- Tasks: Option B — inbox adds forward-only task-activity log → "Tasks completed" (+ "created" from history).
- Extension 102 → Hillel (calls attributed via app_settings `phone_extension_user_map`).

## Build status — SHIPPED 2026-06-29 (operator live-smoke pending)
- [x] Spec + mockup approved by operator (~15:40)
- [x] Inbox endpoint contract handed over; INBOX side DEPLOYED + verified live (member-activity endpoint, minute-heartbeat, forward-only TaskActivity log). Inbox main `8c3e1f7`+ (ActiveMinute/TaskActivity migrations).
- [x] FINANCE build (worktree subagent `ta-builder`): DB user_active_minutes + migration 0054, POST /api/heartbeat + app-wide hook, src/modules/team-activity aggregation+merge, routes incl CSV, /team-activity page + nav, tests.
- [x] Review (did it myself on Opus 4.8 — the 2 spawned Opus reviewers hung). Found+fixed: inbox event-type categorization (commit `1f51159`), CSV formula-injection, lock-badge + Today-prefix mockup polish.
- [x] Merged to main `d87b087` (migration 0054). Pushed.
- [x] DEPLOYED — GH Actions hit the Hostinger SSH flake (VPS unreachable 2222+22), so deployed MANUALLY over `ssh finance-vps` (local `npm run build` → tar dist → `set -a; . ./.env.production` → `npm run db:migrate` → `pm2 reload finance-hub`). /health 200, route 401-guarded.
- [x] Seeded prod `phone_extension_user_map` = {"102":"4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7"} (Hillel).
- [x] POST-DEPLOY FIXES (manual redeploys, GH flake ongoing):
  - `e667f1d` — `["me"]` query cache-shape collision: UserPill/useFilterPersistence/invoice-reminder cache the WRAPPED {user}; the new useMe + route guard cached UNWRAPPED under the same key → crash on /team-activity (guard-first) + hidden nav link (pill-first). Fix: all consumers cache wrapped; useMe uses `select`. VERIFIED via a focused render harness (UserPill renders + isAdmin=true, no crash).
  - `f9143cb` — finance-hub MANUAL composes weren't counted: the poller writes email_log outbound with userId=NULL; per-user attribution is in `activities` (kind email_out, userId). Added that source (disjoint from email_log AI-agent path → no double-count). 32 tests green.
- [ ] OPERATOR LIVE SMOKE — pending. Operator must HARD-refresh (Ctrl+Shift+R) to clear the old cached bundle, then: link shows under Settings, page loads clean, pick Josh (inbox-rich) + Hillel (finance-heavy), email counts include hand-composed finance-hub emails.

## Cleanup TODO
- Remove the merged worktree `worktree-feat+team-activity` + branch once confirmed.
- The 2 hung reviewer agents (ta-review-sec/ta-review-design) — abandoned.

## Notes
- Hillel finance userId = `4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7` (hschijves@gmail.com).
- Shaya = info@feldartcollection.co.uk; Josh = joshezekiel554@gmail.com + info@feldart.com.
- inbox base loopback http://127.0.0.1:3002, INBOX_SERVICE_TOKEN set in finance .env.production.
