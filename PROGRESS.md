# Progress Log

**Source of truth for "where are we right now."** Updated after every
meaningful commit so any new Claude session (or human picking up work)
can re-orient in 60 seconds.

If you're new to this file:
- **Plan**: `C:\Users\user\.claude\plans\steady-crunching-kahn.md` (full roadmap)
- **Conventions**: `CLAUDE.md` in this repo
- **Memory**: `C:\Users\user\.claude\projects\C--Users-user-Documents-QuickBooksSync\memory\project_finance_hub_2.md`

---

## Current phase

**Week 3 — Engine ports + activity ingestion + BullMQ + shadow mode.**
- Phase A in flight: qb-porter, gmail-porter, anthropic-porter (parallel)
- Phase B queued: activity-ingester, chase-porter, bullmq-engineer (after Phase A)
- Reviewer + shadow mode trigger close out the week

## Latest checkpoint

**Date**: 2026-04-28
**Commit on `main`**: `f4aef0f` (Wave 2 fixes: build, smoke path, security plugins, cleanups)
**GitHub**: https://github.com/joshezekiel554-cloud/finance-hub
**Local repo**: `C:\Users\user\Documents\finance-hub`
**Status**: typecheck clean, 10/10 tests pass, build clean, server boots in production mode without errors

## Active work

**None — week 1-2 closed.** Next batch (week 3) ready to spawn when human gives the go-ahead.

**Wave 1 review fixes shipped:**
- `21f46bc` (schema): oauth_tokens widened, unique constraint, migration 0002
- `39f83a7` (observability): error handler order, sentry timing, session preHandler
- `ab601e2` (auth): multi-cookie response, atomic state, trustProxy, cookie order, fp wrap, accounts plaintext doc

**Wave 2 review fixes shipped (`f4aef0f`):**
- tsc-alias `-f` build pipeline (fixes `npm start` boot)
- Smoke path corrected (`/api/health` → `/health`)
- Security plugin stack registered (helmet, cors, rate-limit, cookie, sensible). Rate-limit partitioned by path family, /health allow-listed, /api/auth tighter
- argon2 removed, React type imports fixed, hand-rolled keyframes for Radix transitions (no tailwindcss-animate dep)

**Deferred to later phases (still tracked):**
- Encrypt `accounts.access_token/refresh_token/id_token` (v2.1; Auth.js adapter wrapper)
- Dual-insert orphan in oauth_tokens callback (week 3, when Arctic flows land)
- Placeholder routes for `/customers /invoicing /tasks /agent` (week 6, CRM UI)
- CSP tightening in helmet config (week 6, when asset origins are known)

## What's done

- ✅ **Project scaffold** (commit 9e70130) — Fastify v5 + Vite + React 18 + Tailwind v4 + UI primitives in `src/web/components/ui/`. Strict TS, env-validated boot via zod.
- ✅ **Stack pivots applied** (commits 53c8882, 4d58e1b) — Postgres → MySQL 8 (mysql2 driver), Lucia → Auth.js v5 (@auth/core + @auth/drizzle-adapter), Caddy → nginx, Docker (prod) → pm2. Reuses VPS infra from `orders.feldart.com`.
- ✅ **Drizzle schema** (in bundle 23a2d30) — 24 tables across 8 domain modules, 28 FKs, 51 indexes. Initial migration at `migrations/0000_dashing_mikhail_rasputin.sql`.
- ✅ **Auth.js v5 + crypto** (bundle + 0e54b67) — Google SSO, allow-list gate, AES-256-GCM (10/10 tests pass), OAuth callback skeleton for QB/Gmail/Shopify.
- ✅ **Observability** (bundle + 769a40f) — Pino structured JSON logger, /health (DB+Redis), error middleware (zod 400, sanitized 5xx), Sentry-ready hook.
- ✅ **Deploy infra** (in bundle) — `.github/workflows/deploy.yml` mirrors orders.feldart.com pattern, `ecosystem.config.cjs` (pm2), `deployment/nginx-finance.feldart.com.conf`, `deployment/vps-setup.md` (week-9 checklist), `CLAUDE.md`.

## In progress

- 🟡 **Cross-cutting review (task #5)** — `reviewer` agent currently examining all week 1-2 work. Findings will land in next checkpoint.

## What's next — Week 3

Per the plan §Effort estimate. Goal: parity with 1.0's QB+Gmail+chase functionality, running in shadow mode against Postgres alongside 1.0's SQLite.

1. **Lift QB integration** — `dashboard/sync-engine.js` (1,263 lines) → `src/integrations/qb/`. OAuth + intuit-oauth + customer/invoice/payment sync logic. Drizzle queries replace better-sqlite3. Writes to `customers`, `invoices`, `invoice_lines`, `oauth_tokens`.
2. **Lift Gmail integration** — `dashboard/gmail-engine.js` + `gmail-client.js` → `src/integrations/gmail/`. Polling, message parsing, send.ts. `withRetry` helper preserved.
3. **Activity ingestion** — wire Gmail poll → match sender → insert `activities(kind=email_in)`. Wire QBO sync → emit activities for invoice_sent / payment_received / balance_change.
4. **Lift chase logic** — `dashboard/chase-engine.js` → `src/modules/chase/`. Severity scoring + tier filtering. AI digest function.
5. **Lift Anthropic SDK pattern** — `dashboard/ai-summarizer.js` → `src/integrations/anthropic/`. Cost tracking + tool registry foundation.
6. **BullMQ wiring** — `src/jobs/worker.ts` (separate pm2 process), repeatable jobs for sync (every 30 min) + chase digest (5pm daily). Update `ecosystem.config.cjs` to enable the worker process.
7. **Shadow-mode trigger end of week 3** — sync runs against Postgres, no emails sent, 1.0 stays operational. Compare daily output side-by-side for parity.

## Open items (need human input)

These don't block week 3 work but block specific later phases:

| Item | Needed by | Status |
|---|---|---|
| Create DNS A record `finance.feldart.com → 187.77.100.23` | Week 9 (deploy) | Pending — user can do anytime |
| Verify VPS RAM headroom (KVM1 vs KVM2) | Week 9 | User offered to upgrade if needed |
| QBO custom field IDs (tracking_number, ship_via, ship_date) | Week 5 | Pending |
| Feldart shipment email format consistency check | Week 4 | Pending |
| Shopify "active" tag name | Week 7 | Pending |
| List of Gmail aliases + context mapping | Week 7 | Pending |
| Initial email templates (chase L1/L2/L3, etc.) | Week 7 | Pending |
| GitHub Actions secrets (`VPS_SSH_KEY`, `VPS_HOST`) | Week 9 | Reuse from orders project |
| Auth.js Google OAuth client redirect URI for `finance.feldart.com` | Week 9 | Add to existing client |
| MySQL DB + user provisioned on VPS (`feldart_finance` / `feldart_finance_app`) | Week 9 | See `deployment/vps-setup.md` step 2 |

## Conventions established

- **All agents commit their work before going idle.** No uncommitted work left in the working tree at the end of a turn — too easy to lose if a session restarts.
- **Team-lead pushes to GitHub** after every batch of agent work completes (don't push mid-flight to avoid races).
- **PROGRESS.md updated after every checkpoint** — this file. Agents can update too if they're tracking phase boundaries.
- **Plan file (`steady-crunching-kahn.md`)** is the spec. PROGRESS.md tracks execution against it. CLAUDE.md is the developer manual.
- **CLAUDE.md** at repo root carries project context — read first in any new session.
- **Memory file** at `C:\Users\user\.claude\projects\C--Users-user-Documents-QuickBooksSync\memory\project_finance_hub_2.md` carries cross-session context.

## Recovery procedure (if session dies mid-task)

1. Read `PROGRESS.md` (this file) → know latest checkpoint commit
2. Read `CLAUDE.md` → know stack + conventions
3. Read `C:\Users\user\.claude\plans\steady-crunching-kahn.md` → know roadmap
4. Run `git log --oneline -20` in finance-hub → see commit history
5. Run `git status` in finance-hub → see if anything was uncommitted
6. Pick up from "What's next" section above

## Commit log highlights

Week 1-2 (chronological):

- `9e70130` — Initial scaffold
- `53c8882` — Pivot deps: postgres→mysql2, +Auth.js v5
- `4d58e1b` — Document VPS deployment
- `23a2d30` — Week 1-2 foundation bundle (schema, auth, observability, deploy infra)
- `0e54b67` — Auth.js basePath fix
- `769a40f` — fastify-plugin wrap to break encapsulation for hooks
- `6707674` — TODO note on dual-insert orphan in oauth callback
- `13736a6` — oauth_tokens indexes + cleanup
- `51912ed` — PROGRESS.md added (resilience layer)
- `f0d357a` — CI workflow on push/PR
- `21f46bc` — Schema fix: oauth_tokens widening + unique constraint
- `41535ce` — PROGRESS update: review dispatched
- `39f83a7` — Observability fix: error handler before routes, sentry timing
- `ab601e2` — Auth fix: multi-cookie, atomic state, trustProxy, cookie order, fp wrap
- `aa5c954` — PROGRESS update: Wave 1 done
- `f4aef0f` — Wave 2: tsc-alias build + security plugins + smoke path + cleanups

## Team status snapshot (finance-hub-init)

| Agent | Status | Last work |
|---|---|---|
| scaffolder | idle | Wave 2 fixes (`f4aef0f`) |
| schema-designer | idle | oauth_tokens schema fixes (`21f46bc`) |
| auth-engineer | idle | Auth Wave 1 fixes (`ab601e2`) |
| observability-engineer | idle | Observability Wave 1 fixes (`39f83a7`) |
| reviewer | idle | Cross-cutting review (text deliverable; no commit) |

All week 1-2 tasks closed. Team can be reused for week 3 (will need fresh briefs scoped to the 1.0 → 2.0 engine ports).
