# Feldart Finance Hub 2.0

Single-package TypeScript monorepo: Fastify backend + Vite/React/Tailwind frontend, Postgres via Drizzle, Redis + BullMQ, Anthropic SDK, multi-user CRM.

## Setup

1. Clone the repo and `cd finance-hub`.
2. `npm install` — installs both server and web deps.
3. Copy `.env.example` to `.env` and fill in the values. See [Environment variables](#environment-variables).
4. Bring up Postgres + Redis via Docker:
   ```sh
   docker compose up -d
   ```
5. Push the Drizzle schema to the dev DB:
   ```sh
   npm run db:push
   ```
6. Start the dev servers:
   ```sh
   npm run dev
   ```
   - Fastify backend on `http://localhost:3000`
   - Vite frontend on `http://localhost:5173` (proxies `/api/*` to the backend)

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run server + web in parallel via `concurrently` |
| `npm run dev:server` | Fastify with `tsx watch` (auto-restart) |
| `npm run dev:web` | Vite dev server |
| `npm run build` | `tsc -b` (server) + `vite build` (web) |
| `npm start` | Run the compiled server (`dist/server/server.js`) |
| `npm run typecheck` | `tsc --noEmit` across the project |
| `npm run db:generate` | Generate Drizzle SQL migrations from schema |
| `npm run db:push` | Push schema changes to the dev DB (no migration files) |
| `npm run db:migrate` | Apply generated migrations |
| `npm run db:studio` | Launch Drizzle Studio |
| `npm test` | Run Vitest |

## Environment variables

All required vars are listed in `.env.example`. The app validates them via `src/lib/env.ts` (zod) at boot and fails loudly if anything critical is missing.

| Var | Purpose |
|---|---|
| `NODE_ENV` | `development` / `production` |
| `PORT` | Backend listen port (default 3000) |
| `PUBLIC_URL` | Public-facing URL (used in OAuth redirects, emails) |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string (for BullMQ + cache) |
| `CRYPTO_KEY` | 32-byte hex key for AES-256-GCM token encryption |
| `COOKIE_SECRET` | Signs session cookies |
| `ANTHROPIC_API_KEY` | Claude API |
| `QB_CLIENT_ID` / `QB_CLIENT_SECRET` / `QB_REALM_ID` / `QB_REDIRECT_URI` | QuickBooks OAuth |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth |
| `SHOPIFY_STORE_DOMAIN` / `SHOPIFY_ADMIN_TOKEN` / `SHOPIFY_API_VERSION` | Shopify Admin API |
| `MONDAY_API_TOKEN` / `MONDAY_ENABLED` | Optional Monday.com mirror |
| `SENTRY_DSN` | Error reporting |

## Project layout

```
src/
  server/         Fastify entrypoint, routes, plugins
  web/            React app (Vite-built)
    components/ui/  Design-system primitives (Button, Card, Input, ...)
    pages/        Page-level components
  lib/            Shared helpers (env, crypto, logger, ...)
  db/             Drizzle schema + queries (populated by schema agent)
  modules/        Feature modules (b2b-invoicing, crm, tasks, ...)
  integrations/   QB, Gmail, Shopify, Monday, Anthropic clients
  jobs/           BullMQ definitions + workers
migrations/       Drizzle SQL migrations
```

## Notes

### Native deps on Windows

`argon2` ships prebuilt binaries (since v0.26) for common platforms including Windows x64, so `npm install` should not need a C++ toolchain. If the prebuild lookup fails on your machine, install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload) and retry, or substitute with the pure-JS `@node-rs/argon2` package.

### Tailwind v4

This project uses Tailwind v4 via the `@tailwindcss/vite` plugin. There is **no `tailwind.config.ts`** in the v3 sense — design tokens are declared inline in `src/web/styles.css` via the `@theme` directive. See that file for the token definitions.
