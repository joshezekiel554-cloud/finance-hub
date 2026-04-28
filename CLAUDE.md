# CLAUDE.md — Feldart Finance Hub 2.0

Context for Claude Code sessions in this repo. Keep it short; rely on the
plan + reference docs for depth.

## What this project is

A web app + back-end CRM for the Feldart accounts team. Replaces the local
Electron tool at `C:\Users\user\Documents\QuickBooksSync\` (which is being
wound down). Sources of truth:

- **QuickBooks Online** — invoices, payments, customer balances
- **Shopify** — orders + product retail prices
- **Gmail** (single shared account with aliases) — inbound + outbound
  customer correspondence
- **Anthropic Claude** — AI agent for chase emails, summaries, drafts,
  task proposal, background account-watching

Multi-user: small team (no roles, everyone has full access). Deployed to
`finance.feldart.com` on a Hostinger VPS shared with `orders.feldart.com`.

## The plan

Authoritative reference: `C:\Users\user\.claude\plans\steady-crunching-kahn.md`.
Read it for: feature scope, data model, module boundaries, migration
strategy, week-by-week timeline. The "Stack pivots after VPS discovery"
section at the top supersedes any older statements about Postgres / Lucia
/ Caddy / Docker.

## Stack

| Layer | Choice |
|---|---|
| Backend | Fastify v5 + TypeScript (Node 20+) |
| Frontend | Vite + React 18 + Tailwind v4 + TanStack Query + TanStack Router |
| UI primitives | Radix (Dialog, Toast, Dropdown, Tabs) wrapped in `src/web/components/ui/` |
| DB | MySQL 8 (existing on VPS) + Drizzle ORM (mysql2 driver) |
| Job queue | BullMQ + Redis |
| Auth | Auth.js v5 (`@auth/core` + `@auth/drizzle-adapter`) with Google SSO + email allow-list |
| AI | `@anthropic-ai/sdk` Sonnet 4.6 with tool-use, prompt caching |
| Logging | Pino structured JSON (pretty in dev) |
| Reverse proxy | nginx (existing on VPS) |
| Process manager | pm2 (existing on VPS) |
| Deploy | GitHub Actions → rsync → VPS (mirrors `orders.feldart.com` pattern) |

## Where things live

```
src/
├── server/                # Fastify app
│   ├── server.ts          # entrypoint, plugin registration, listen
│   ├── plugins/           # auth.ts, logger.ts, error-handler.ts, sentry.ts
│   ├── routes/            # http handlers (api/*, oauth/*, etc.)
│   └── lib/               # server-only helpers (auth helpers, etc.)
├── web/                   # React + Vite app
│   ├── main.tsx           # entrypoint
│   ├── App.tsx            # layout shell
│   ├── pages/             # one folder per page
│   ├── components/        # shared components (ui/ has design primitives)
│   └── lib/               # web helpers (cn, fetch wrappers, etc.)
├── lib/                   # cross-cutting (env loader, crypto, logger, errors)
├── db/                    # Drizzle schema + relations + client
│   ├── index.ts           # mysql2 pool + drizzle() client
│   ├── schema/            # tables split per-domain (auth/customers/invoices/etc.)
│   └── relations.ts       # Drizzle relations() definitions
├── modules/               # feature modules
│   ├── b2b-invoicing/     # parser, reconciler, send action
│   ├── crm/               # activity ingestion, customer detail logic
│   ├── tasks/             # task system + AI proposal
│   ├── statements/        # QBO statement send
│   ├── holds/             # Shopify tag mutation
│   ├── email-compose/     # templates, alias picking, AI enhance
│   ├── notifications/     # SSE stream + email digest
│   ├── ai-agent/          # tool registry + agent loop
│   ├── chase/             # severity scoring, daily digest (1.0 port)
│   └── sync/              # QB→DB canonicalization (1.0 port)
├── integrations/          # external APIs
│   ├── qb/                # QuickBooks Online (OAuth + invoice/customer/payment APIs)
│   ├── shopify/           # Admin GraphQL
│   ├── gmail/             # poll + send + aliases
│   ├── monday/            # demoted; feature-flagged read-only mirror
│   └── anthropic/         # client + cost tracking + tool registry
└── jobs/                  # BullMQ queue defs + workers
```

`migrations/` — drizzle-kit generated SQL. Never hand-edit applied
migrations; create new ones for schema changes.

`deployment/` — VPS setup notes + nginx site config (not in runtime).

`.github/workflows/deploy.yml` — push-to-main deploy. See `deployment/vps-setup.md` for first-time setup.

## Local development

```bash
# 1. Install deps (one time)
npm install

# 2. Copy env template, fill in
cp .env.example .env

# 3. Start MySQL + Redis locally (one of):
#    a. docker-compose up      (if Docker is installed)
#    b. install MySQL 8 + Redis 7 natively on your machine
#    c. point at hosted (PlanetScale free + Upstash free)

# 4. Run migrations
npm run db:push          # dev: push schema directly (no migration file)
# or
npm run db:generate      # generate a migration
npm run db:migrate       # apply migrations

# 5. Start dev servers (in two terminals OR via concurrently)
npm run dev              # both server + web concurrently
# or
npm run dev:server       # Fastify on :3001 only
npm run dev:web          # Vite on :5173 only (proxies /api → :3001)
```

## Conventions

- **TypeScript strict mode.** Zero `any` (use `unknown` + narrow). Prefer
  `type` over `interface` unless extending. Drizzle infers types from
  schema — use `InferSelectModel`/`InferInsertModel`.
- **Server imports use relative paths**, not `~/*` aliases (plain Node
  doesn't resolve tsconfig paths post-build). Web (Vite) can use aliases.
- **Env vars accessed only via `src/lib/env.ts`**, never via
  `process.env.X` directly. The env loader validates with zod at boot.
- **Logging via `createLogger()` from `src/lib/logger.ts`**, never
  `console.log`. Levels: trace/debug/info/warn/error/fatal.
- **DB writes go through audit_log** for any state change (customer
  edit, hold flip, invoice send, etc.). The audit row records before/after.
- **AI write tools require user confirmation.** Pattern: tool returns a
  proposal, user clicks Approve, BullMQ job executes. See plan §AI agentic
  surface.
- **No inline secrets** in code; everything from env.
- **Encrypted at rest:** OAuth tokens for QB/Gmail/Shopify in `oauth_tokens`
  table — encrypted via `src/lib/crypto.ts` (AES-256-GCM, key from env).

## Reference projects

- **`C:\Users\user\Documents\Claude\production-order-system\`** —
  `orders.feldart.com` source. The deploy pipeline, pm2 config, nginx
  setup, and Auth.js v5 + Google SSO patterns here are the canonical
  reference. Read its `DECISIONS.md` for the "why" behind infra choices.
- **`C:\Users\user\Documents\QuickBooksSync\`** — old 1.0 Electron app.
  Engines being lifted as portable Node modules: `dashboard/sync-engine.js`
  (QB sync), `dashboard/gmail-engine.js` (Gmail polling), `dashboard/gmail-client.js`
  (Gmail OAuth + retry), `dashboard/chase-engine.js` (severity scoring),
  `dashboard/ai-summarizer.js` (Claude prompts + cost tracking).
  Schema reference: `dashboard/database.js`. Fresh-start for data — no
  SQLite import.

## Open items

Tracked in the plan file's "Open items" section. Things that need real
answers before specific weeks land:

- VPS resource headroom (RAM check)
- QBO custom field IDs for tracking/ship-via/ship-date on B2B invoice template
- Feldart shipment email format consistency
- Shopify "active" tag name
- Gmail aliases list + context mapping
- Initial email templates (chase L1/L2/L3, etc.)
