# Shared tasks — FINANCE-LANE design (draft for cross-review)

Part of the unified inbox↔finance task system. **Architecture (locked with operator + inbox 2026-06-22):** the **inbox task engine is the single canonical store**; finance is a **first-class client**; surfaces = (1) inbox's global-tasks board **embedded in finance**, (2) the inbox board itself, (3) `tasks.feldart.com` thin branded front-door — all rendering the same engine. V1 includes finance's operational queues as board cards from day 1 (operator chose this).

This doc covers the FINANCE-LANE sections (4–7 + finance side of 11–15). Inbox owns the task data model, board/SSE, tasks.feldart.com (sections 1–3). Cross-references to inbox's model are marked **[needs inbox model]**.

---

## 5. Cross-app identity map (finance user ↔ inbox TeamMember)

The hinge of the whole feature: assignment, "created by", @mentions, "my tasks" all need a stable map between a **finance user** (Auth.js `user` row: `id`, `email`) and an **inbox `TeamMember`** (`id`, `email`, `googleEmail`, `role`).

- **Join key = email, lowercased.** Match finance `user.email` against inbox `TeamMember.email` **OR** `TeamMember.googleEmail`. (Onboarding gotcha confirmed 2026-06-22: Hillel's `googleEmail` was blank, login == `email`; so we must check both fields.)
- Finance does **NOT** store a duplicate mapping. It resolves live: calls inbox's **`GET /api/svc/members`** (returns `[{teamMemberId, name, email, googleEmail, role, active}]`), builds an `email → teamMemberId` map, caches ~5 min (same pattern as the Gmail alias cache in `integrations/gmail/aliases.ts`).
- **Resolving the acting user**: when a finance user creates/actions a task, finance resolves *their own* `user.email` → `teamMemberId` via the map and sends that as the actor. If the finance user has **no** matching TeamMember → block with a clear message ("you need an inbox account to use shared tasks — ask an admin to add you in inbox → Members"). This is the same dual-app account requirement we already have for sign-in.
- **Edge cases**:
  - User in finance allow-list but not in inbox → can't create/be-assigned tasks; surfaced, not silently broken.
  - User in inbox but not finance → irrelevant to finance (they use inbox).
  - Assignable-member list (for finance's "assign to…" picker) = inbox's member list, filtered to `active`.

## 4. Task API contract finance consumes  **[shape; finalize against inbox model]**

- **Direction flip**: today `/api/ext` is finance-exposes / inbox-reads. For tasks, **finance calls INTO inbox**. So finance holds a new **`INBOX_SERVICE_TOKEN`** (bearer) + **`INBOX_BASE_URL`** (loopback `http://127.0.0.1:3002` — same VPS, mirror of inbox's `FINANCE_BASE_URL=127.0.0.1:3001`). New token both sides' env; plumbing pattern already exists from the existing integration.
- **Endpoints finance needs** (names TBD with inbox):
  - `GET  /api/svc/members` — assignable members + identity map.
  - `GET  /api/svc/tasks?assigneeId=&status=&customerId=&source=` — list (for the "my tasks" widget + finance-native views; the BOARD itself comes via embed, see §7).
  - `POST /api/svc/tasks` — create `{title, body, assigneeId, customerId?, dueAt?, reminderAt?, source:'finance', actorTeamMemberId}`.
  - `PATCH /api/svc/tasks/:id` — update status/assignee/fields.
  - `POST /api/svc/tasks/:id/comments` — `{body, mentions:[teamMemberId], actorTeamMemberId}`.
  - `POST /api/svc/tasks/:id/attachments` — upload (see §11).
  - reminders — `{remindAt, teamMemberId}` (see §9).
- **Live updates**: the board finance shows is the **embedded inbox global-tasks board (iframe)** → it gets inbox's SSE for free, no finance polling for the board. Finance-native bits ("my tasks" widget, create-task confirmation) call the API and can poll lightly; they don't need SSE.
- **`customerId` linkage** — CONFIRMED: inbox is adding a first-class nullable **`financeCustomerId`** field on Task (mirrors `Thread.financeCustomerId` + the `X-Feldart-Finance-Customer-Id` convention; +1 migration inbox-side). A task created from a finance customer page carries it; the per-customer board filters on it.

## 6. Queue adapters — finance operational items as live board cards

Per the locked hybrid: **auto-queues are LIVE CARDS, not materialized tasks** (no second store, no drift). Mechanism — note the direction is the EXISTING one (inbox board reads finance):

- Finance exposes **`GET /api/ext/task-cards`** (extends the existing read API inbox already consumes). Returns the live actionable queue items:
  ```
  { id, type: 'hold'|'overdue_review'|'ai_proposal'|'chase'|'rma',
    title, customerId, customerName, column,           // which board column it sits in
    meta: {...},                                        // heldSince, amount, etc.
    actions: [ { label, kind:'api'|'link',
                 method?, endpoint?,                    // kind:api → finance endpoint
                 url? } ] }                             // kind:link → deep-link into finance
  ```
- The inbox board renders these as a **third card type** (alongside threads + tasks), styled as finance-source, with their action buttons. **[needs inbox]** board support for an external card source + column mapping.
- **Auto-clear**: cards are read live from finance, so when finance state changes (hold released, proposal approved, balance settled) the item drops from the feed → the card disappears on the next board refresh. Zero stored state.
- **V1 action depth** (per effort assessment): 
  - `hold` → one-click `Good-to-send` / `Cancel` (+ `Chase` deep-link); endpoints exist (`POST /api/orders/:id/good-to-send|cancel`).
  - `overdue_review` → one-click `Place-on-hold` / `Dismiss`; endpoints exist (shipped 2026-06-18/19).
  - `ai_proposal` → one-click `Approve` / `Reject` (endpoints exist; card must carry enough proposal context).
  - `chase` → **deep-link** into finance's chase screen (send-flow too rich for a board button in v1).
  - `rma` → **deep-link** into finance (multi-step workflow; real card actions later).
- **Action auth (cross-app)** — CONFIRMED with inbox: a one-click action on a finance card is clicked in the inbox board but hits a finance endpoint. The board passes **both `actorTeamMemberId` AND `actorEmail`**; finance keys on **email** (primary — the §5 join key, reverse direction) to resolve its own `user` for `audit_log` with no extra lookup, memberId as stable ref. Finance validates the service token, resolves the actor, performs the action, writes audit.
- **Column placement**: map each type to a board column (proposal: To-do; hold: To-do/urgent; etc.) **[shared decision 8/2]** or a dedicated "Finance queue" swimlane — TBD with inbox + operator.

## 7. Finance board placement (finance-native surfaces)

- **Top-level "Tasks" nav** in finance → the **global-tasks board (inbox embed, global/per-assignee mode)**. One board UI (inbox's), embedded; zero second board to build/drift.
- **Per-customer**: the existing per-customer `EmbedBoard` on customer pages stays (that customer's threads + tasks). The new global board is separate (all tasks). A finance "+ New task" on a customer page can pre-fill `customerId` so the task links to that customer.
- **"+ New task"** (finance-native button, on the board header + customer pages) → small finance form → `POST /api/svc/tasks` with assignee (from the member picker, §5) + optional `customerId`.
- **"My tasks" dashboard widget** (finance-native) → `GET /api/svc/tasks?assigneeId=<me>` → quick list, links into the board / tasks.feldart.com.

## Finance side of inbox's edge cases (11–15)

- **11 Attachments** — CONFIRMED with inbox: attachments live in **inbox object storage** under `outbound/<memberId>/...`, attached to a **TaskComment** (not the task root). Finance UPLOADS via the svc API (multipart → inbox stores + attaches to a comment) and DISPLAYS via a short-lived **signed download URL** inbox mints (`signedDownloadUrl` + RFC-6266 content-disposition). **Limits: ≤10MB/file, images + PDF** (matches inbox's `/api/uploads` policy). Finance never proxies blobs.
- **12 @mention delivery**: a mention authored from finance must notify the mentioned member wherever they are (inbox / finance / tasks.feldart.com). Mentionable set = the shared member list (§5). Delivery = inbox's notification system (it owns notifications). Finance's job = pass `mentions:[teamMemberId]` on comment create; **optionally** also surface a finance-native notification to finance users (nice-to-have; inbox notifications + email cover v1).
- **13 Task↔thread link in a finance view**: an inbox task linked to an email thread, shown in finance/tasks.feldart.com — the thread link **deep-links into inbox** (finance users may lack thread context). Card shows "💬 linked email — open in inbox ↗". Don't try to render the thread in finance.
- **14 Failure modes (finance side)**: finance calling inbox unreachable → the embedded board shows inbox's own error; finance-native "+ New task" / "my tasks" → graceful "tasks temporarily unavailable", never breaks the finance page. Conversely, inbox board reading finance's `/api/ext/task-cards` unreachable → board still shows tasks, queue cards just missing (degrade, don't crash).
- **15 Concurrency**: canonical store (inbox) serializes writes; last-write-wins on a task; finance relies on the embed's SSE for reconciliation. Finance-native views re-fetch on focus. No finance-side locking needed.

## Open questions for the operator / cross-review
- Column mapping for queue cards (dedicated swimlane vs slot into the 5 columns)?
- Does a finance user without an inbox account get a read-only board, or no tasks at all? (lean: read-only view, can't create/assign.)
- tasks.feldart.com auth — which user store / SSO? **[inbox lane]**
- Rollout: feature-flagged (`shared_tasks_enabled`), behind the existing `inbox_integration_enabled`? Existing inbox tasks just appear (no migration).
