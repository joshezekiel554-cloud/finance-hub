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

**Week 4 — B2B Invoicing module. 🟢 ~95% COMPLETE (feature-shipped, polish-grade).**

Reconciler + sender + `/invoicing/today` end-to-end interactive UI all live.
Send action goes through to QBO with email delivery + tracking pill.
Dozens of UX polishes shipped on top in the last 24h (see "What just shipped").

Done so far (week 4):
- Shopify OAuth callback wired (HMAC-verified, real code→token exchange,
  UPSERT to `oauth_tokens`) — `67c3576`, `d23b4be`
- Dev-only token rescue path (browser textarea + stdout banner when local
  MySQL is unavailable) — `ca94a74`
- Feldart shipment email parser + 16 unit tests — `01bf027`
- Shopify integration foundation (REST client, retry, pagination, orders
  read API) + 21 unit tests — `723b2c0`
- B2B invoice reconciler (keep / add / qty_change / set_metadata diff
  algorithm + 15 tests) — `180a1ab`
- QBO send action (sender.ts: builds sparse update, posts to QBO, handles
  401 retry, 15 tests) — `5856899`
- Local MySQL wired + 1.0 token migration script — `802e5dd`
- `/invoicing/today` end-to-end (route + page + Card UI) — `5be90b0`,
  `b5f7a87`, `1662cf7`, `36ad0e7`, `0ed2dbd`, `4ddb065`, `7d3f7d5`,
  `490f441`, `63451d9`, `5531e7c`
- QBO OAuth bootstrap script (`scripts/qb-oauth-connect.ts` +
  `qb-oauth-complete.ts`) — `0891542`, `063c1b4`
- Send → email customer (POST /invoice/{id}/send, "Sent to X at Y" pill)
  — `82ffeb5`
- Batch QBO invoice lookup (1 query instead of N) — `aeb7973`
- Suffix lookup (DocNumber=18303 → 18303-SP via date-windowed bulk fetch
  + client-side prefix match; QBO QL doesn't support OR) — `1925da3`,
  `1221eaf`
- QB token refresh fixes — single-flight mutex + CAS save (`956fca9`)
  AND the real bug: `x_refresh_token_expires_in` defaulting to 0 in
  `intuit-oauth` made `validateToken()` reject every refresh client-side
  (`f30526e`)
- Gmail speedup: htmlBody extracted during search + parallel fetches
  (10.7s → 2.4s on /today) — `76393fb`

Still to do for week 4 closeout:
1. ~~Invoice reconciler~~ ✅ shipped
2. ~~QBO send action~~ ✅ shipped
3. ~~`/invoicing/today` dashboard page~~ ✅ shipped
4. **BullMQ cron `0 11 * * *` Europe/London** — code exists, not yet
   registered in `src/jobs/schedule.ts`
5. **End-to-end shadow-mode validation** — pick 1-2 real invoices, send
   via 2.0, confirm QBO state matches what 1.0 would have produced

**Week 3 — ✅ COMPLETE** (engine ports + activity ingestion + BullMQ + shadow mode).
- Phase A: `7d662cc`, `33a4492`, `fc14554`. Phase B: `5b69ea2`, `e2a1c64`, `7e143b1`.
- All 8 review dimensions verified directly (reviewer agent didn't deliver).
- Crypto roundtrip, audit log atomicity, SHADOW_MODE gate, worker shutdown,
  scoped logging, no PII leakage, Europe/London timezone all confirmed.

## Latest checkpoint

**Date**: 2026-04-29
**Commit on `main`**: `f30526e` (QB refresh fix — `x_refresh_token_expires_in`)
**GitHub**: https://github.com/joshezekiel554-cloud/finance-hub (in sync, last push includes f30526e)
**Local repo**: `C:\Users\user\Documents\finance-hub`
**Status**: typecheck silent · **149/149 tests pass** · server running on :3001 via tsx watch
**Local dev**: MySQL running locally; QBO OAuth chain healthy (token rotates on refresh
without intervention now that the `intuit-oauth` validation bug is fixed)

## Active work

**None.** Week 4 substantially shipped. Awaiting direction on whether to:
- close week 4 (cron registration + 1-2 real-invoice parity check), or
- start week 6 (CRM core: customers list + detail + activity timeline + tasks)

## What just shipped (last 24h, 25 commits)

The whole interactive `/invoicing/today` experience plus three QB token
fixes culminating in the real one. Highlights:

**B2B invoicing UX:**
- Reconciler + sender, posts sparse update to QBO with full ship metadata
- Send → email invoice to customer's BillEmail (`POST /invoice/{id}/send`),
  "Sent to X at Y" pill in card header pulled from QBO's EmailStatus +
  DeliveryInfo.DeliveryTime
- Editable QB price + Shopify price column + qty_change auto-promote
- Customer memo (renders on invoice + statement) + DocNumber suffix (-SP for
  special-offer invoices, idempotent)
- Preview-in-QBO link
- + Add line picker with QB Item search (debounced autocomplete via new
  /api/invoicing/items/search)
- Email override block (To/CC/BCC; only sends overrides when changed
  from QBO defaults)
- Dismiss + Dismissed tab + reason dropdown (b2c_paid_upfront / etsy_faire
  / other-with-note); restorable
- Bulk dismiss for unparseable WMS noise rows
- Optimistic UI on dismiss/restore (no full refetch)
- Tab split: Open / Sent / Dismissed (Sent driven by EmailStatus = "EmailSent")

**Performance:**
- Batch QBO invoice lookup: 1 query instead of N for /today's row matching
- Suffix-renamed invoice lookup (18303 → 18303-SP) via single date-windowed
  bulk fetch + client-side prefix match (QBO QL has no OR support)
- Gmail speedup: htmlBody extracted during searchEmails + fully parallel
  detail fetches → /today went 10.7s → 2.4s

**QB token refresh — three layers of fix:**
- `956fca9` — single-flight Promise mutex per realm + compare-and-swap save
  (defends against concurrent refresh races + tsx-watch process restarts)
- `1221eaf` — replaced invalid `OR DocNumber LIKE ...` query (QBO 400)
  with date-windowed bulk fetch
- `f30526e` — **the actual root cause**: `intuit-oauth`'s `setToken()`
  defaults `x_refresh_token_expires_in` to 0 if you don't pass it. That
  makes `validateToken()` (called at the top of `refresh()`) throw "The
  Refresh token is invalid" client-side, before any HTTP call to Intuit.
  Every "expired" error we'd been chasing was this — re-OAuth always
  worked briefly because the OAuth callback path got the real expiry
  (~100 days) from Intuit's response, but our refresh code didn't carry
  it forward. Verified by direct probe: same stored refresh token went
  from rejected → succeeded once `x_refresh_token_expires_in` was passed.

**Deferred to later phases (still tracked):**
- Encrypt `accounts.access_token/refresh_token/id_token` (v2.1; Auth.js adapter wrapper)
- Dual-insert orphan in oauth_tokens callback (week 3, when Arctic flows land)
- Placeholder routes for `/customers /tasks /agent` (week 6+, not yet built)
- CSP tightening in helmet config (week 6, when asset origins are known)
- Persist `x_refresh_token_expires_in` to DB so we don't hardcode 100 days
  on every refresh (low priority — every successful refresh resets the
  100-day window anyway)

## What's done

**Week 1-2 — foundation:**
- ✅ **Project scaffold** (commit 9e70130) — Fastify v5 + Vite + React 18 + Tailwind v4 + UI primitives in `src/web/components/ui/`. Strict TS, env-validated boot via zod.
- ✅ **Stack pivots applied** (commits 53c8882, 4d58e1b) — Postgres → MySQL 8 (mysql2 driver), Lucia → Auth.js v5 (@auth/core + @auth/drizzle-adapter), Caddy → nginx, Docker (prod) → pm2. Reuses VPS infra from `orders.feldart.com`.
- ✅ **Drizzle schema** (in bundle 23a2d30) — 24 tables across 8 domain modules, 28 FKs, 51 indexes. Initial migration at `migrations/0000_dashing_mikhail_rasputin.sql`. Plus `dismissed_shipments` (added week 4).
- ✅ **Auth.js v5 + crypto** (bundle + 0e54b67) — Google SSO, allow-list gate, AES-256-GCM (10/10 tests pass), OAuth callback skeleton for QB/Gmail/Shopify.
- ✅ **Observability** (bundle + 769a40f) — Pino structured JSON logger, /health (DB+Redis), error middleware (zod 400, sanitized 5xx), Sentry-ready hook.
- ✅ **Deploy infra** (in bundle) — `.github/workflows/deploy.yml` mirrors orders.feldart.com pattern, `ecosystem.config.cjs` (pm2), `deployment/nginx-finance.feldart.com.conf`, `deployment/vps-setup.md` (week-9 checklist), `CLAUDE.md`.

**Week 3 — engines lifted, shadow mode live:**
- ✅ **QB integration** (`src/integrations/qb/`) — `client.ts` (axios + intuit-oauth, query/queryAll, sync routines), `tokens.ts` (encrypted DB storage, single-flight refresh mutex, CAS save), `sync.ts` (customer/invoice/payment/credit-memo sync writing to Drizzle).
- ✅ **Gmail integration** (`src/integrations/gmail/`) — `client.ts` (OAuth wrapper, withRetry, search + message fetch, htmlBody during search), `poller.ts` (scheduled poll → activity emission).
- ✅ **Activity ingestion** — Gmail poll matches sender → inserts `activities(kind=email_in)`. QBO sync emits activities for invoice_sent / payment_received / balance_change.
- ✅ **Chase logic lifted** (`src/modules/chase/`) — severity scoring + tier filtering, AI digest function. 26 tests.
- ✅ **Anthropic SDK pattern lifted** (`src/integrations/anthropic/`) — cost tracking + tool registry foundation. 13 tests.
- ✅ **BullMQ wiring** (`src/jobs/worker.ts`) — separate pm2 process, sync-every-30-min repeatable + chase-digest 5pm daily. SHADOW_MODE gate verified.

**Week 4 — B2B Invoicing (the big one — see "Current phase" above for full breakdown):**
- ✅ Parser + Shopify integration + reconciler + sender + interactive `/invoicing/today` UI + email delivery + tab split (Open/Sent/Dismissed) + dismiss/restore + bulk dismiss + suffix-rename support + QB token refresh fully working.

## In progress

**None.** Awaiting direction on next phase.

## What's next — close week 4 + start week 6

**Week 4 closeout (~1 hour total):**

1. **Register the 11am invoicing cron in `src/jobs/schedule.ts`** —
   the cron job code exists; just needs registration so it fires daily
   at `0 11 * * *` Europe/London.
2. **Real-invoice parity check** — pick one B2B invoice, send via 2.0,
   confirm QBO state matches what 1.0 would have produced. Validates
   the entire B2B invoicing pipeline end-to-end with real data.

**Week 6 — CRM core (next major scope, per plan):**

1. **Customers list** — table view of all customers with filter/search,
   pulling from `customers` table (already populated by week 3 sync).
2. **Customer detail page** — single-customer view with invoice history,
   open balance, recent activity, contact info, notes.
3. **Activity timeline** — chronological feed of `activities` rows
   (email_in, email_out, invoice_sent, payment_received, etc.) with
   filters by kind and date range.
4. **Tasks CRUD** — create/edit/complete tasks tied to a customer or
   activity. Schema already in `db/schema/crm.ts`.
5. **Placeholder routes activated** — `/customers`, `/customer/:id`,
   `/tasks` were stubbed in week 1-2; now wire real data + UI.

## Open items (need human input)

These don't block current work but block specific later phases:

| Item | Needed by | Status |
|---|---|---|
| Create DNS A record `finance.feldart.com → 187.77.100.23` | Week 9 (deploy) | Pending — user can do anytime |
| Verify VPS RAM headroom (KVM1 vs KVM2) | Week 9 | User offered to upgrade if needed |
| ~~QBO custom field IDs (tracking_number, ship_via, ship_date)~~ | ~~Week 5~~ | ✅ Resolved during week 4 — IDs known + wired in `sender.ts` |
| ~~Feldart shipment email format consistency check~~ | ~~Week 4~~ | ✅ Resolved — parser handles real-world variants; bulk-dismiss covers WMS noise |
| Shopify "active" tag name | Week 7 (Shopify hold) | Pending |
| List of Gmail aliases + context mapping | Week 7 (email compose) | Pending |
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

**Week 1-2** (scaffold + auth + schema + observability + deploy infra):

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
- `39f83a7` — Observability fix: error handler before routes, sentry timing
- `ab601e2` — Auth fix: multi-cookie, atomic state, trustProxy, cookie order, fp wrap
- `f4aef0f` — Wave 2: tsc-alias build + security plugins + smoke path + cleanups

**Week 3** (engine ports + activity + BullMQ + shadow mode):
- Phase A: `7d662cc`, `33a4492`, `fc14554`
- Phase B: `5b69ea2`, `e2a1c64`, `7e143b1`

**Week 4 — B2B Invoicing** (the big one — ~30 commits):

- `01bf027` — Feldart shipment email parser + 16 tests
- `723b2c0` — Shopify integration foundation (REST + retry + pagination)
- `180a1ab` — B2B invoice reconciler + 15 tests
- `5856899` — QBO send action (sender.ts) + 15 tests
- `802e5dd` — Local MySQL + token migration script
- `5be90b0` — `/invoicing/today` end-to-end (route + page)
- `ec937c1` — Fix LIVE banner false positive
- `b5f7a87` — Make page interactive (live send, edits, discount, notes)
- `1662cf7` — Final qty editable on every line (keep ⇄ qty_change auto-promote)
- `36ad0e7` — Always blank CustomerMemo on send + SalesTermRef override
- `0891542` — Real QBO OAuth exchange + connect script
- `063c1b4` — `qb-oauth-complete.ts` playground-redirect fallback
- `b0ee2ad` — Clear PrivateNote on send (kill auto-sync junk)
- `82ffeb5` — Email invoice to customer after update (Sent to X at Y pill)
- `aeb7973` — Batch QBO invoice lookup (1 query not N)
- `0ed2dbd` — Editable QB price + Shopify price col + customer memo + DocNumber suffix + preview link
- `1925da3` — Backend foundation: suffix lookup + email/history/tracking exposure
- `4ddb065` — + Add line picker with QB Item search
- `7d3f7d5` — Email override To/CC/BCC
- `490f441` — Dismiss + Dismissed tab + reason dropdown
- `63451d9` — Bulk dismiss + optimistic dismiss/restore
- `76393fb` — Speed up Gmail fetch (htmlBody during search + parallel get)
- `956fca9` — Single-flight refresh mutex + CAS save (concurrency defense)
- `1221eaf` — Suffix-lookup uses bulk fetch (QBO QL has no OR)
- `5531e7c` — Split Active tab into Open + Sent
- `f30526e` — **Real fix for "Refresh token is invalid"**: pass
  `x_refresh_token_expires_in` to `intuit-oauth.setToken` so its
  client-side `validateToken()` doesn't reject every refresh

## Team status snapshot

The `finance-hub-init` multi-agent team idled after week 1-2 closed.
Week 3-4 work was done conversationally with the lead model rather than
spawning agents. Team can be re-spawned for week 6 CRM scope if pair-
implementation pattern is wanted again — or week 6 can proceed
conversationally like week 3-4 did.
