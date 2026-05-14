# Project Backlog

Ideas captured but not yet scheduled. Each entry has rough scope + dependencies. Order is rough priority — top of list is "next up after the active project ships."

---

## Connections status panel
**Rough effort:** half day · **Dependencies:** none · **Priority:** high

Unified Settings dashboard showing health of every external integration. Already have QB connected status; extend to cover Vocatech, Shopify, Gmail, BullMQ/Redis, Anthropic API, Google Drive.

**Shape:** card per integration, each showing:
- ✓ / ✗ status (green/red dot)
- Last successful call timestamp ("connected · last check 12 min ago")
- One-click "Test connection" button per integration
- Quick error message inline when red

**Implementation:** each integration exposes/extends a `health()` helper that does a lightweight call (auth check, list a recent item, etc.). Settings page polls every minute, manual refresh button. Same Settings page section as the per-integration config blocks.

**Why it's high-priority:** single source of truth for "is the system actually working." When something breaks, the operator sees it here first. Cheap to build, lots of operational value.

---

## API credentials in Settings UI
**Rough effort:** 1-2 days · **Dependencies:** ideally pairs with the connections panel above · **Priority:** medium

Operator can rotate / configure service credentials (Vocatech API key, Shopify token, etc.) without touching `.env` files or the server.

**Architecture (DON'T mutate `.env`):**
- Use the existing `app_settings` table for service credentials (encrypted with the existing `CRYPTO_KEY` env var via AES-GCM)
- Bootstrap secrets stay in `.env` (`DATABASE_URL`, `CRYPTO_KEY`, `AUTH_SECRET`) — app needs these BEFORE it can read the DB
- Service credentials (Vocatech, Shopify token, Gmail OAuth refresh, etc.) move to DB
- Settings UI: dotted password input, save → encrypted insert, backend reads at call time with a cache
- No env-file mutation, no restart needed

**Migration path:**
1. Add encrypted-credentials storage helper (`src/lib/encrypted-settings.ts`)
2. For each existing env-stored credential, add fallback chain: env var → DB → null. App boots with `.env` as today; DB takes over as values are entered in Settings.
3. Settings UI per integration: existing config blocks gain a key input + save handler. Mask on display. Reveal-on-click optional.

**Why not env-file mutation:** running process has env values in memory; editing `.env` doesn't update them without restart. Writing `.env` from the running app weakens trust boundary (any RCE → rewritten secrets). DB-backed is the right pattern.

---

## Autopilot mode
**Rough effort:** 1-2 weeks · **Dependencies:** ideally the scheduled-tag-emails work this is building on · **Priority:** medium-high

Per-customer flag enabling rule-driven automation (auto-send statements 1st of month, auto-send chase emails, escalate based on time elapsed). Configurable in Settings.

**Key design questions** (from earlier brainstorm):
1. Rules hardcoded or operator-editable?
2. Trigger model: cron-driven (check daily) or event-driven (invoice goes overdue → fire)?
3. Coupling with AI agent — autopilot is deterministic, AI agent is probabilistic; should they merge or stay separate?

**Decided:** complementary not merged. Autopilot = deterministic rules. AI agent = personalization layer + Q&A + reply interpretation. Autopilot fires "send statement" → AI optionally personalizes the email body before send.

**Schema:**
- `customers.autopilot_enabled boolean`
- `autopilot_rules` table for operator-editable rule definitions
- `audit_log` rows for every autopilot action include `automated: true` flag

**UI:**
- Per-customer enable toggle on customer-detail page (clear "AUTOPILOT" badge when on)
- Settings → Autopilot section: rule editor
- Customer activity timeline marks every autopilot action distinctly

---

## AI agent (deferred until system surface is stable)
**Rough effort:** 4-6 weeks across phases · **Dependencies:** Vocatech complete + autopilot complete + tool surface settled · **Priority:** highest long-term value, lowest urgency

Conversational + agentic LLM layer:
- Q&A about the whole system ("how many RMAs are approved without tracking?")
- Multi-turn workflows ("now chase those customers")
- Reply interpretation (customer responds with tracking → agent extracts → updates RMA)
- Profile editing via natural language
- Per-customer-autopilot personalization layer

**Phasing:**
1. Tool registry + chat panel UI + read-only Q&A (low risk, high value, ships first)
2. Write tools + permissions model + confirmation gates (after system stabilizes)
3. Reply interpretation + auto-update with confidence threshold + audit
4. Autopilot ↔ AI integration

**Decided:** read-only Q&A can ship in parallel with autopilot. Write actions wait for stable tool surface.

---

## Returns redesign Phase 5 cutover
**Rough effort:** 1 hour · **Dependencies:** operator validation in real use · **Priority:** operator-gated, do when ready

Delete legacy `ReturnReceiptReviewDialog` + `RmaCreditMemoDialog` files. Both still on disk for the co-existence period during operator validation of the new flow.

Operator says "good to go" → run the deletion task in `docs/superpowers/plans/2026-05-07-returns-redesign.md` Task 5.1.

---

## Customer activities timeline `bodyHtml`
**Rough effort:** 1 hour · **Dependencies:** none · **Priority:** low

The `activities` table has a `bodyHtml` column that's currently always written as `null`. Email-related activities should populate it from the email's HTML body (same source the returns redesign uses on receipt cards) so the customer-detail timeline shows rich formatting matching the Today tab / RMA detail rendering.

Cheap follow-up flagged by the returns redesign reviewer (2026-05-07).

---

## Process notes for future projects

Patterns that worked well during the URL state + returns redesign + Vocatech projects:

- **Subagent-driven execution with worktree fan-out** where files are disjoint. Real parallelism with zero merge conflicts (file-disjointness checked upfront).
- **Opus for all code-quality reviewers**, sonnet for most implementers (opus for the heaviest implementer tasks). Catches real bugs that sonnet implementers miss.
- **Two-stage review per task** — spec compliance first, code quality second. Each stage's failures fix before next stage.
- **Live progress tracker file per project** in `docs/superpowers/plans/<date>-<project>-progress.md`. Updated after every task + pushed to origin so it survives auto-compact.
- **Push feature branch to origin after every wave merge.** Don't accumulate 200+ unpushed commits. Documented in memory `feedback_git_push_cadence.md`.
- **Post-plan polish loop** — after operator uses the new feature on real data, expect 5-10 follow-up bugs/UX gaps. Reserve time for it.

---

## Vocatech post-ship polish (deferred from W5 review, 2026-05-13)

Non-blocking items flagged by the W5 opus reviewer + earlier rounds. Capture here so they're not lost.

- **Long-call duration formatting** — `formatDuration(seconds)` outputs `m:ss`; calls over 60 min render as `73:12` instead of `1:13:12`. Affects three places: `customers.ts:formatDurationServer`, `calls-sms-tab.tsx:formatDuration`, `unmatched-phone-comm-inbox.tsx:formatDuration`. Worth deduping into `src/lib/format.ts` while fixing.
- **Multi-operator-match race surfacing** — currently last-write-wins on `POST /api/vocatech/communications/:id/match`. Add `WHERE customer_id IS NULL` clause to the UPDATE; surface zero-rows-affected as a 409 with a "this row was just matched by another operator" message. Reload the inbox query on 409.
- **`VocatechWebhook.id` type** — currently typed `string` in client.ts but OpenAPI spec says `integer`. Works at runtime (JS coerces to string in URL paths) but the type is a lie. One-line fix in `src/integrations/vocatech/client.ts`.
- **`testWebhook` client wrapper response shape** — wrapper claims `{ok: true}` but Vocatech actually returns `{success, status_code, error}`. Settings UI may say "Sent" when Vocatech actually couldn't reach our endpoint. Update wrapper + UI to surface real status.
- **Webhook attachment storage** — `message.received` payloads include an `attachments[]` array. Currently we capture only the body text; attachments are discarded. A new table `phone_communication_attachments` keyed on `phone_communication_id` + the attachment id, plus a fetch-and-store hook in the handler, would close the gap. Defer until a real attachment-bearing message arrives so we can confirm payload shape.
- **Additional webhook events** — we only subscribe to 4 of Vocatech's 7 published event types. `call.started`, `call.answered`, and `message.sent` are unsubscribed. Add if useful (e.g. live "incoming call" toast in the UI from `call.started`).
- **Cloudflared dev tunnel** — still running on local laptop, no longer in active use since prod webhook owns the event stream. Stop the local process (or document for someone wanting to spin it back up for branch testing).

## Production deployment hygiene (deferred from 2026-05-13 cutover)

- **Refresh-local-from-prod script** — convenience tool to mysqldump prod and restore to local. Useful for testing new features against current customer state. ~20-line script, prompts for confirmation since it overwrites local data.
- **Lock down `/etc/sudoers.d/deploy-bootstrap`** — currently grants `deploy` NOPASSWD sudo for ALL commands. Replace with a scoped allowlist of just the commands we ever use (`apt`, `nginx`, `systemctl`, `certbot`, `mysql`, `tee /etc/nginx/sites-*`, `ln`, `rm /etc/nginx/sites-enabled/*`). Same operational reach, smaller blast radius if the deploy key leaks.
- **Webhook URL rotation playbook** — if `finance.feldart.com` ever changes (move VPS, switch domain), the Vocatech webhook needs PATCHing. Document the steps in a runbook so it's not on muscle memory: `scripts/smoke/repoint-webhook-to-prod.ts` is the template; secret stays the same on PATCH.
- **Memurai dev fallback** — local Memurai needs `Start-Service Memurai` from admin PowerShell after a Windows reboot. Currently runs as foreground process from prior session. If we keep using local dev, formalize this in setup docs.
