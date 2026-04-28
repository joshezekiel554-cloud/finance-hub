# Feldart Finance Hub 2.0

Single-package TypeScript monorepo: Fastify backend + Vite/React/Tailwind frontend, MySQL via Drizzle, Redis + BullMQ, Anthropic SDK, multi-user CRM. Authentication via Auth.js v5.

## Setup

1. Clone the repo and `cd finance-hub`.
2. `npm install` — installs both server and web deps.
3. Copy `.env.example` to `.env` and fill in the values. See [Environment variables](#environment-variables).
4. Bring up MySQL + Redis (one of):
   - Docker (recommended for dev): `docker compose up -d`
   - Native: install MySQL 8 + Redis 7 on Windows
   - Hosted: PlanetScale free tier for MySQL, Upstash free for Redis (set the URLs in `.env`)
5. Push the Drizzle schema to the dev DB:
   ```sh
   npm run db:push
   ```
6. Start the dev servers:
   ```sh
   npm run dev
   ```
   - Fastify backend on `http://localhost:3001`
   - Vite frontend on `http://localhost:5173` (proxies `/api/*` and `/oauth/*` to the backend)

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
| `PORT` | Backend listen port (default 3001 — orders.feldart.com is on 3000) |
| `PUBLIC_URL` | Public-facing URL (used in OAuth redirects, emails) |
| `DATABASE_URL` | MySQL connection string |
| `REDIS_URL` | Redis connection string (for BullMQ + cache) |
| `AUTH_SECRET` | Auth.js v5 secret — signs session cookies + CSRF |
| `AUTH_URL` | Public origin Auth.js sees in callbacks |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Google OAuth client used for **user login** |
| `ALLOWED_EMAILS` | Comma-separated allow-list of emails permitted to sign in (gates account creation) |
| `CRYPTO_KEY` | 32-byte hex key for AES-256-GCM encryption of integration tokens at rest |
| `ANTHROPIC_API_KEY` | Claude API |
| `QB_CLIENT_ID` / `QB_CLIENT_SECRET` / `QB_REALM_ID` / `QB_REDIRECT_URI` | QuickBooks OAuth |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client used by Gmail integration (shared mailbox) |
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

## Production deployment

Production runs on the same Hostinger VPS as `orders.feldart.com` (`187.77.100.23`) under the hostname `finance.feldart.com`.

- Process management: **pm2** (not Docker). The orders project already uses pm2; we add a second app.
- TLS termination: **nginx + certbot** (not Caddy). The existing nginx adds a server block + Let's Encrypt cert for `finance.feldart.com`.
- MySQL + Redis: native installs on the VPS, shared with `orders.feldart.com` where appropriate (separate database for finance hub).

The `docker-compose.yml` in the repo is for **local dev convenience only** — it is not used in production.

## Notes

### Native deps on Windows

`argon2` ships prebuilt binaries (since v0.26) for common platforms including Windows x64, so `npm install` should not need a C++ toolchain. If the prebuild lookup fails on your machine, install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload) and retry, or substitute with the pure-JS `@node-rs/argon2` package.

### Tailwind v4

This project uses Tailwind v4 via the `@tailwindcss/vite` plugin. There is **no `tailwind.config.ts`** in the v3 sense — design tokens are declared inline in `src/web/styles.css` via the `@theme` directive. See that file for the token definitions.

### Auth.js vs. Arctic

We use **Auth.js v5** (`@auth/core`, framework-agnostic) for **user sign-in** to the app (Google SSO). We use **Arctic** for **integration OAuth** flows (QuickBooks, Shopify) where Auth.js providers don't help — Arctic is a thin wrapper for OAuth 2.0 token exchange. Both can coexist.

## Authentication

Sign-in is handled by **Auth.js v5** (`@auth/core`) with the **Google** provider and **database sessions** stored in MySQL via the Drizzle adapter. The handler is mounted as a Fastify plugin at `/api/auth/*` (`src/server/plugins/auth.ts`); session cookies are read in `src/server/lib/auth.ts` (`getSession`, `getCurrentUser`, `requireAuth`). The Auth.js handler converts Fastify `req`/`reply` into Web `Request`/`Response` and back, then delegates to `Auth(request, config)` from `@auth/core`.

### Email allow-list

Account creation and sign-in are gated by the `ALLOWED_EMAILS` env var — a comma-separated list of emails permitted to authenticate. The check runs in the Auth.js `signIn` callback, so non-allowed users never get a `user` row created in the database. Empty allow-list is permitted in dev (server logs a warning and rejects all sign-ins); production must configure at least one email.

### Adding a new user

1. SSH to the VPS.
2. Edit `/var/www/finance-hub/.env.production` and append the email to `ALLOWED_EMAILS` (comma-separated).
3. `pm2 restart finance-hub` so the new env is picked up.
4. The user signs in at `https://finance.feldart.com/login` with their Google account — Auth.js creates the `user` row on first successful sign-in.

### Removing a user

Remove the email from `ALLOWED_EMAILS` and restart the process. Existing sessions remain valid until they expire from the `session` table — to force a sign-out, delete the user's rows from `session` (and optionally `user` + `account`).

### Crypto helper for integration tokens at rest

`src/lib/crypto.ts` exposes `encrypt(plaintext, key?)` / `decrypt(ciphertext, key?)` using AES-256-GCM with a random 12-byte IV per encryption. Key defaults to `env.CRYPTO_KEY` (32 raw bytes decoded from 64 hex chars); the auth tag prevents tampering — any modification to the ciphertext or tag causes `decrypt` to throw. Output is `base64(iv || ciphertext || authTag)`, suitable for a TEXT column. Use it for storing third-party OAuth tokens (QB, Gmail, Shopify) in `oauth_tokens.access_token_enc` / `refresh_token_enc`.

## Observability

Logging is structured via [pino](https://getpino.io). One log line per HTTP request and per significant event.

### Log format

- **Production** (`NODE_ENV=production`): newline-delimited JSON, one event per line. Stream this into pm2 / journald / Loki / Datadog without further parsing.
  ```json
  {"level":"info","time":"2026-04-23T14:02:11.103Z","app":"finance-hub","env":"production","host":"web-1","request_id":"01HW...","method":"GET","url":"/api/customers","status":200,"duration_ms":18,"msg":"request completed"}
  ```
- **Development** (`NODE_ENV=development`): pretty-printed via `pino-pretty` with timestamps, colors, and multi-line objects.

### Standard fields

Every log line includes the bindings `app`, `env`, `host`, plus `level`, `time`, and `msg`. Request-scoped logs (`req.log`) additionally include `request_id`. Add `user_id` to log context once a user is authenticated.

### Levels

`trace` < `debug` < `info` < `warn` < `error` < `fatal`. Default level is `info` (`debug` in dev). Override with `LOG_LEVEL=warn` in `.env`.

- 2xx responses → `info` (one line per request)
- 4xx responses → `warn`
- 5xx responses → `error` with stack trace
- Validation failures (`ZodError`) → `warn` with `validation_issues`

### Redaction

The following are redacted automatically and replaced with `[REDACTED]` in log output:

- Headers: `authorization`, `cookie`, `set-cookie`, `x-api-key`
- Request bodies for `/api/auth/*` routes are never logged (only headers + metadata)

### Inspecting logs in production

Server runs under pm2 on the VPS. Tail logs with:

```sh
pm2 logs finance-hub          # follow stdout/stderr
pm2 logs finance-hub --lines 200
```

Pipe through `jq` for filtering:

```sh
pm2 logs finance-hub --raw | jq 'select(.level == "error")'
```

### `/health` endpoint

`GET /health` runs synchronous liveness checks against MySQL (`SELECT 1`) and Redis (`PING`), each with a 2-second timeout. Used by the deploy smoke test and uptime monitors.

```json
{
  "status": "ok",
  "checks": { "db": "ok", "redis": "ok" },
  "env": "production",
  "uptime": 1234.56,
  "request_id": "01HW..."
}
```

- `200` if both checks pass.
- `503` in production if any check fails (`status: "degraded"`).
- In development, `/health` returns `200` even when DB/Redis are unreachable so local dev isn't blocked — failed checks still appear as `"fail"` in the body.

### Sentry hook

If `SENTRY_DSN` is set, the server lazily imports `@sentry/node` (not a hard dependency — install it explicitly if you want Sentry: `npm i @sentry/node`) and captures any 5xx errors. With `SENTRY_DSN` unset, the Sentry plugin is a no-op and the package is never loaded.
