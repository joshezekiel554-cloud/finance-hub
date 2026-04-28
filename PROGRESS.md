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

**Week 1-2 — Foundation.** ~95% complete. Cross-cutting review in progress.

## Latest checkpoint

**Date**: 2026-04-28
**Commit on `main`**: `769a40f` (Wrap server plugins with fastify-plugin)
**GitHub**: https://github.com/joshezekiel554-cloud/finance-hub
**Local repo**: `C:\Users\user\Documents\finance-hub`

## What's done

- ✅ **Project scaffold** (commit 9e70130) — Fastify v5 + Vite + React 18 + Tailwind v4 + UI primitives in `src/web/components/ui/`. Strict TS, env-validated boot via zod.
- ✅ **Stack pivots applied** (commits 53c8882, 4d58e1b) — Postgres → MySQL 8 (mysql2 driver), Lucia → Auth.js v5 (@auth/core + @auth/drizzle-adapter), Caddy → nginx, Docker (prod) → pm2. Reuses VPS infra from `orders.feldart.com`.
- ✅ **Drizzle schema** (in bundle 23a2d30) — 24 tables across 8 domain modules, 28 FKs, 51 indexes. Initial migration at `migrations/0000_dashing_mikhail_rasputin.sql`.
- ✅ **Auth.js v5 + crypto** (bundle + 0e54b67) — Google SSO, allow-list gate, AES-256-GCM (10/10 tests pass), OAuth callback skeleton for QB/Gmail/Shopify.
- ✅ **Observability** (bundle + 769a40f) — Pino structured JSON logger, /health (DB+Redis), error middleware (zod 400, sanitized 5xx), Sentry-ready hook.
- ✅ **Deploy infra** (in bundle) — `.github/workflows/deploy.yml` mirrors orders.feldart.com pattern, `ecosystem.config.cjs` (pm2), `deployment/nginx-finance.feldart.com.conf`, `deployment/vps-setup.md` (week-9 checklist), `CLAUDE.md`.

## In progress

- 🟡 **Cross-cutting review (task #5)** — `reviewer` agent currently examining all week 1-2 work. Findings will land in next checkpoint.

## What's next (week 3 — first work in progress)

1. **Review fixes** (if reviewer flags any) — small commits per finding.
2. **Lift QB sync engine from 1.0** — `dashboard/sync-engine.js` → `src/integrations/qb/sync.ts`. Targets `customers` and `invoices` tables. Drizzle queries replace better-sqlite3.
3. **Lift Gmail polling** — `dashboard/gmail-engine.js` → `src/integrations/gmail/poller.ts`. Activity ingestion writes to `activities` table.
4. **Lift chase digest** — `dashboard/chase-engine.js` → `src/modules/chase/`.
5. **Activity ingestion plumbing** — connect Gmail poll + QBO sync events into `activities` rows.
6. **Shadow mode begins end of week 3** — 2.0 reads + writes Postgres but does not send emails or write to QBO/Shopify. 1.0 stays operational.

See plan §Effort estimate.

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

- `9e70130` — Initial scaffold
- `53c8882` — Pivot deps: postgres→mysql2, +Auth.js v5
- `4d58e1b` — Document VPS deployment
- `23a2d30` — Week 1-2 foundation bundle (schema, auth, observability, deploy infra)
- `0e54b67` — Auth.js basePath fix
- `769a40f` — fastify-plugin wrap to break encapsulation for hooks

## Team status snapshot (finance-hub-init)

| Agent | Status | Last task |
|---|---|---|
| scaffolder | idle | #1 (completed) |
| schema-designer | idle | #2 (completed) |
| auth-engineer | idle | #3 (completed) |
| observability-engineer | idle | #4 (completed) |
| reviewer | running | #5 (in_progress) |
