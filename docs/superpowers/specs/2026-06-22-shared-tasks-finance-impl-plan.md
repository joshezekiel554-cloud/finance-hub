# Shared tasks — FINANCE-side implementation plan (draft)

Finance half of the unified-tasks build. Pairs with the canonical design spec (inbox repo `docs/superpowers/specs/2026-06-22-unified-tasks-design.md`) and finance-lane design (`2026-06-22-shared-tasks-finance-lane.md`). Inbox drafts the inbox-side plan; we merge. **No code until the operator green-lights the merged plan.** Build order M0→M5, each with a demoable checkpoint.

Sizing: S ≈ <½ day, M ≈ 1 day, L ≈ 2–3 days (finance-side only).

---

## M0 — Plumbing / contract foundation  (size: M)
Goal: finance can authenticate to inbox + resolve the identity map.
- **`src/lib/env.ts`** (mod): add `INBOX_SERVICE_TOKEN`, `INBOX_BASE_URL` (default `http://127.0.0.1:3002`), `TASKS_EMBED_SIGNING_SECRET`. Zod-validated at boot.
- **`src/integrations/inbox/client.ts`** (new): service client — bearer `INBOX_SERVICE_TOKEN`, base URL, typed fetch wrapper + error normalization (mirrors how inbox calls our `/api/ext`).
- **`src/integrations/inbox/members.ts`** (new): `listMembers()` → `GET /api/svc/members`; build `email→{teamMemberId,name,role,active}` map; 5-min cache (mirror `integrations/gmail/aliases.ts`). `resolveMemberByEmail(email)` + `resolveMemberById(id)`.
- **`src/modules/tasks-shared/identity.ts`** (new): `financeUserToMember(user)` (email/googleEmail match, both fields), `memberEmailToFinanceUser(email)` (reverse, for audit on queue-card actions). Throws a typed "no inbox account" error finance surfaces nicely.
- **Tests**: identity match on email AND googleEmail; cache; missing-member path.
- ✔ **Checkpoint**: a finance dev route/test lists inbox members + maps a known email both directions.

## M1 — Backbone: read + embedded board  (size: M)
Goal: a finance user sees ONLY their tasks on the embedded board.
- **`src/server/lib/tasks-embed-token.ts`** (new): mint short-lived (~5 min) HMAC-signed `{email, exp}` with `TASKS_EMBED_SIGNING_SECRET`. (Inbox validates + scopes board + SSE to that member.)
- **`src/server/routes/tasks.ts`** (new): `GET /api/tasks/embed-url` → returns the inbox global-board embed URL with a fresh viewer token; `GET /api/tasks/mine` → proxy `GET /api/svc/tasks?assignee=<me>` for the widget.
- **`src/web/pages/tasks/index.tsx`** (new): Tasks page = iframe of the inbox global board via the embed URL; re-mint token on focus/refresh. Loading + inbox-unreachable states.
- **`src/web/App.tsx` / sidebar** (mod): "Tasks" nav entry.
- **`src/web/components/dashboard/my-tasks-widget.tsx`** (new) + **`home.tsx`** (mod): "My tasks" quick list → `/api/tasks/mine`, links into the board.
- ✔ **Checkpoint**: finance Tasks page renders the board scoped to the logged-in finance user; My-tasks widget populated.

## M2 — Write: create tasks from finance  (size: M)
Goal: boss creates a task in finance → lands live on the assignee's board.
- **`src/server/routes/tasks.ts`** (mod): `POST /api/tasks` → resolve actor (current finance user → member) + assignee (member) via identity, `customerId?`, `dueAt?`, `reminderAt?`; call inbox `POST /api/svc/tasks`. (Inbox SSE-broadcasts → board updates live.)
- **`src/web/components/tasks/new-task-dialog.tsx`** (new): title / description / assignee picker (members list) / due / reminder / optional customer. 
- **`src/web/pages/customer-detail.tsx`** (mod): "+ New task" on the customer page, pre-fills `financeCustomerId`.
- Note: comments / @mentions / attachments are authored ON the embedded board (inbox-native UI) — finance does NOT rebuild those; finance-write v1 = task creation only.
- ✔ **Checkpoint**: create a task in finance → appears on the assignee's inbox board within ~1s.

## M3 — Finance queue cards  (size: L — the big finance piece)
Goal: finance operational queues are live, actionable cards on the board.
- **`src/modules/tasks-shared/task-cards.ts`** (new): `getTaskCards()` assembles live actionable items:
  - `hold` ← orders `holdState='on_hold'` (reuse hold-alerts queries); actions Good-to-send / Cancel (api) + Chase (link).
  - `overdue_review` ← `listFlaggedOverdueOrders` (minus dismissed); actions Place-on-hold / Dismiss (api).
  - `ai_proposal` ← pending proposals; actions Approve / Reject (api) + context in `meta`.
  - `chase` ← dunning queue; action = deep-LINK to finance chase screen.
  - `rma` ← RMAs awaiting action; action = deep-LINK.
  - Each → `{id,type,title,customerId,customerName,column,meta,actions[]}`.
- **`src/server/routes/ext.ts`** (mod): `GET /api/ext/task-cards` (service-token guarded, the existing inbox-reads-finance direction).
- **`src/server/routes/ext-actions.ts`** (new): service-token-guarded action endpoints the board POSTs to, each carrying `{actorEmail, actorTeamMemberId}` → resolve finance user (email primary) → perform the existing action (good-to-send/cancel/place-on-hold/dismiss/approve/reject) → write `audit_log` attributed to that user. (Wraps the existing per-action logic, swapping the auth from user-session to service-token+actor.)
- **Tests**: card assembly per type; action auth + audit attribution; auto-clear (resolved item drops from feed).
- ✔ **Checkpoint**: holds + orders-to-review actionable from the board (correct finance audit); chases/RMAs deep-link; a released hold's card disappears.

## M4 — tasks.feldart.com  (finance size: none)
Inbox stands up the branded front-door (subdomain, shared `.feldart.com` session, VPS nginx/pm2/DNS). No finance work — it's a 3rd surface onto the same engine. (Finance awareness only.)

## M5 — Polish / rollout  (size: M)
- **Feature flag** `shared_tasks_enabled` in `app_settings` (gate the Tasks nav, widget, `/api/ext/task-cards`). Likely behind/with `inbox_integration_enabled`.
- **Failure-mode** degradation polish (graceful states everywhere inbox is called).
- Coordinate the existing-inbox-board visibility tightening + `.feldart.com` cookie cutover (inbox-led; finance just times its flag flip with it).
- ✔ **Checkpoint**: flag off = zero change; flag on = full feature; inbox-down = finance degrades gracefully.

## Finance-side risks / notes
- M3 is the bulk of finance work (the queue feed + service-auth action variants + audit attribution). M0–M2 are light because the board itself is inbox's (embedded).
- The service-auth action variants (M3) must NOT bypass existing business rules (e.g. cancel still does Shopify+QBO, restock:false). Reuse the existing action functions, only swap the auth/actor layer.
- Deploy: finance changes ship via the normal pipeline (+ manual fallback if the Hostinger edge flakes). New env vars must be set on the VPS before the flag flips.
