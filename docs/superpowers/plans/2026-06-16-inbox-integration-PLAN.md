# Finance-side Implementation Plan — Inbox Integration v1

**Spec:** `docs/superpowers/specs/2026-06-16-inbox-integration-design.md`
**Contract:** the shared API contract (Inbox repo) — frozen, `perBook` final.
**Branch:** `feat/inbox-integration` (new branch off `main`; main stays shippable).
**Safety:** feature branch + feature flag (default OFF) + read-only v1. Three nets.

Phases are independently shippable. Each lands behind the flag; nothing is live
until the operator flips it.

---

## Phase 0 — Branch + flag + env (foundation)

- **New branch** `feat/inbox-integration` (worktree per the usual workflow).
- `src/lib/env.ts` — add `FINANCE_SERVICE_TOKEN` (zod, required-in-prod;
  optional in dev so local boot doesn't break).
- Feature flag `inbox_integration_enabled` in `app_settings` (default `false`)
  — gates the `/api/ext` registration and the customer-page embed. (Pattern
  mirrors `autopilot_scan_cron_enabled`.)
- **Rollback:** delete the branch. Nothing touches main.

## Phase 1 — Service-token auth + `/api/ext` read API

- **New** `src/server/lib/service-auth.ts` — `requireServiceToken(req)`
  preHandler: constant-time compare of `Authorization: Bearer` vs
  `env.FINANCE_SERVICE_TOKEN`; `401 { error:"unauthorized" }` on miss.
- **New** `src/server/routes/ext.ts` — the 5 endpoints (exact shapes per §5a of
  the spec / shared contract). Registered in `src/server/routes/index.ts` under
  `prefix: "/api/ext"`, guarded by `requireServiceToken` + a dedicated
  rate-limit bucket (~120/min), only when the flag is on.
  - `GET /customers` — list `{id, displayName, emails[], openOrigins}`. Reuse
    customer query; dedupe emails from primary + billing + statement/invoice
    arrays.
  - `GET /customers/:id` — detail + balances + `perBook`. Reuse customer-detail
    balance logic (`src/modules/crm` / customers route helpers).
  - `GET /customers/:id/invoices?openOnly=1` — reuse the invoices-by-customer
    query already behind `GET /api/customers/:id/invoices`.
  - `GET /invoices/:qbInvoiceId/pdf` — thin wrapper over `QboClient.getPdf`
    (same as `src/server/routes/qb-pdf.ts`).
  - `GET /customers/:id/statement.pdf?origin=` — wrap `renderStatementPdf`
    (`src/modules/statements`), reusing the data-gathering from
    `statement-pdf-preview.ts` / `modules/statements/send.ts`. `400` if both
    books open and origin omitted.
- **Money = decimal strings; dates = YYYY-MM-DD; camelCase; bare arrays** per
  contract.
- **Independently testable:** `curl -H "Authorization: Bearer …"
  http://127.0.0.1:3001/api/ext/customers`. No Inbox dependency.
- **Rollback:** flag off → routes 404 as if absent.

## Phase 2 — Outbound header stamp

- `src/integrations/gmail/send.ts` — add an optional `financeSendType` param;
  when present, emit header `X-Feldart-Finance-Send: <type>` in the MIME.
- Set it at every Finance send site, passing the type:
  - chase sends — `src/server/routes/chase.ts` / `src/modules/chase` → `chase`
  - statement sends — `src/server/routes/statements.ts` /
    `src/modules/statements/send.ts` → `statement`
  - check-in + dispute/bookkeeper sends → `check-in` / `dispute-bookkeeper`
- **Harmless to ship early:** it's just an extra header; Inbox ignores it until
  ready. Can merge ahead of the flag.
- **Rollback:** remove the param pass-through; header simply stops.

## Phase 3 — Customer-page board embed + decommission

- `src/web/pages/customer-detail.tsx` (+ its emails sub-view) — behind the flag:
  - **Replace** the inbound emails view with an `<iframe>` to
    `https://inbox.feldart.com/board?customer=<financeCustomerId>&embed=1`.
  - **Retire** (flag-gated, so reversible): the inbound correspondence reading
    view, the free-form reply compose, and the AI-draft-reply-to-inbound action.
  - **Keep** untouched: send-statement (with edit), chase page + chase-email
    edit, RMA replies, dispute/bookkeeper sends, and Finance's AI authoring its
    own outbound.
- **Rollback:** flag off → old emails view renders, embed hidden.

## Phase 4 — Chaser recent-contact suppression (engineering must)

- **Investigate first:** does `src/modules/chase` already suppress auto-chase on
  recent human contact? (It has `email_log` + reply tracking.)
- If NOT: add a guard — skip auto-chase for a customer with a human-sent reply
  in the last N days. (Phase 2 of the overall project can replace this with an
  explicit Inbox `last-human-contact` signal if the Gmail-derived heuristic is
  unreliable.)
- **Rollback:** the guard only *suppresses* sends, so worst case is the prior
  behavior — safe.

## Phase 5 — Infra (operator-gated)

- `deployment/nginx-finance.feldart.com.conf` — add
  `location /api/ext { return 404; }` so the public vhost never exposes it;
  Inbox reaches it on loopback `127.0.0.1:3001`. Apply on VPS (over SSH, with
  operator OK).
- Confirm VPS firewall exposes only 80/443/22/2222 (port 3001 not public).
- Operator generates `FINANCE_SERVICE_TOKEN` and sets it in finance env.

---

## Build order & checkpoints

1. Phase 0 → 1 → 2 land first (the API + header; curl-testable, no Inbox dep).
2. **C1:** post real sample responses from all 5 endpoints on the channel;
   Inbox confirms its parser matches byte-for-byte; then Inbox points at live
   endpoints over loopback with the token.
3. Phase 3 (embed) → **C2:** board loads framed in Finance, operator login
   carries in (Safari check).
4. Phase 2 end-to-end → **C3:** a Finance-stamped chase appears in Inbox tagged
   'Sent from Finance', routed to Waiting; statement → Done.
5. Operator live smoke test → flip the flag on.

## Deploy note

Finance's deploy pipeline has been flaky (Hostinger edge dropping the GH
runner); deploys may go manually over SSH. Each Finance deploy will be flagged
on the channel. Flag-default-OFF means a half-landed deploy exposes nothing.

## Out of scope (Phase 2 of the project — named, not built)

paid→close, statement-delivered→don't-double-send, last-contact signal, global
Inbox-task view, finance-driven board search/sort.
