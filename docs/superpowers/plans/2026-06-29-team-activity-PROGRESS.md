# Team Activity report — PROGRESS

Spec: `docs/superpowers/specs/2026-06-29-team-activity-report.md` (APPROVED 2026-06-29).
Mockup: `.superpowers/team-activity-mockup.html` (operator approved on radio).

## Decisions locked
- Admin-only finance-hub page, generic per-teammate. Gate = `isAdmin()` (prod ADMIN_EMAILS already = Josh×2 + Shaya, excludes Hillel). No new env.
- Data spans finance + inbox. De-dup boundary: inbox = native replies + tasks + comments/@mentions + notes; finance = its own emails/calls/holds/statements/invoices/proposals. Each email sent through exactly one app → counted once.
- Active time = heartbeat, forward-only, MINUTE granularity; combined = UNION of finance+inbox minute-sets (both-tabs-open dedupes).
- Tasks: Option B — inbox adds forward-only task-activity log → "Tasks completed" (+ "created" from history).
- Extension 102 → Hillel (calls attributed via app_settings `phone_extension_user_map`).

## Build status
- [x] Spec + mockup approved by operator (2026-06-29 ~15:40)
- [x] Inbox endpoint contract handed to inbox team (GET /api/svc/member-activity)
- [~] FINANCE side — building in worktree via subagent `ta-builder` (DB user_active_minutes + migration, POST /api/heartbeat + app-wide hook, src/modules/team-activity aggregation+merge, routes incl CSV, /team-activity page + nav, tests). NOT yet reviewed/merged/deployed.
- [ ] INBOX side — inbox team building: member-activity endpoint + minute-granularity heartbeat + forward-only task-activity log.
- [ ] Opus 4.8 review of finance diff
- [ ] Merge + deploy (GH Actions) + seed `phone_extension_user_map` {102: Hillel userId 4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7}
- [ ] Operator live smoke

## Notes
- Hillel finance userId = `4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7` (hschijves@gmail.com).
- Shaya = info@feldartcollection.co.uk; Josh = joshezekiel554@gmail.com + info@feldart.com.
- inbox base loopback http://127.0.0.1:3002, INBOX_SERVICE_TOKEN set in finance .env.production.
