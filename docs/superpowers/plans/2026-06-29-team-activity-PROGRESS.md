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
  - `813e96a` — **ACTIVE-TIME MODEL REDESIGN (operator-requested)**: replaced raw distinct-active-minute count with continuous-work SESSIONS. All signals (presence pings as 60s intervals + every event, calls occupying full talk-time) across both apps → sessionize: bridge gaps ≤15 min, floor each session at 3 min (so reading/thinking/calls count + a momentary one-off still registers). Active time = sum of session spans; per-app figures sessionized independently. Heartbeat now pings IMMEDIATELY on any interaction (click/key/scroll/move) + tab-focus, not just the 60s tick. Pre-heartbeat days shown as "(est.)" (event-timestamps only; forward-only exact from today). New helpers `sessionizedMinutes`/`minutesToSignals`/`eventsToSignals` (SESSION_GAP_SEC=900, SESSION_MIN_CREDIT_SEC=180); `durationSec` added to ActivityEvent for calls; `estimated`/`estimatedDays` added to types. 37 tests green. Inbox needs NO change (already sends minute-pings + event timestamps; its heartbeat already pings on-visible).
- [ ] OPERATOR LIVE SMOKE — pending. Operator must HARD-refresh (Ctrl+Shift+R) to clear the old cached bundle, then: link shows under Settings, page loads clean, pick Josh (inbox-rich) + Hillel (finance-heavy), email counts include hand-composed finance-hub emails.

## Review outcomes (both Opus reviewers DID return — not hung, just slow)
- **Security/correctness: SHIP** — no Critical/High. Confirmed: admin gate on all 3 routes (Hillel 403) + heartbeat correctly auth-only; active-minute UNION dedupes (no both-tabs double-count); statement dedupe works; invoice-chases never audited so no double-count; inbox merge degrades gracefully; SQL parameterized; heartbeat non-spoofable. My 2 fixes (inbox categorization, CSV injection) covered the only real gaps.
- **Design fidelity:** token usage clean (no ad-hoc hex), empty/loading states good, dot colors 1:1 with mockup. Confirmed the page correctly OMITS the active-time chip (mockup HTML is stale there).

## Polish backlog (OPTIONAL — operator reviewed + accepted the live render; ask before doing)
- Picker = bare <Select> vs mockup's avatar pill → **operator chose "dropdown please" — SETTLED, not a defect.**
- Finance ACTION rows (holds/statements from audit_log) aren't click-through to the customer (audit entityType=order/statement, not customer → customerId null → no link). Real minor UX gap; would need to resolve order→customer. Most worth doing of the lot.
- Timeline time column: code `text-right w-12`; mockup left-aligned ~58px.
- Call rows: duration shown in the title text ("· 6:12"); mockup also has an inline duration pill.
- Hero tile ring + larger value = INTENTIONAL (agreed Active-time-hero refinement); mockup's equal tiles are the older design — keep the hero.
- Hero meta "Xh finance · Yh inbox" can sum past the union total when both apps were open same minute (label only; the headline total is the correct union).

## Cleanup TODO
- [x] Removed merged worktree branch `worktree-feat+team-activity` (orphaned dir under gitignored .claude/ remains, harmless).
- The 2 reviewer agents returned SHIP/design findings (above) — done.

## Notes
- Hillel finance userId = `4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7` (hschijves@gmail.com).
- Shaya = info@feldartcollection.co.uk; Josh = joshezekiel554@gmail.com + info@feldart.com.
- inbox base loopback http://127.0.0.1:3002, INBOX_SERVICE_TOKEN set in finance .env.production.
