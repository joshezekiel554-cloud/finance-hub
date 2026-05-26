# AI on-demand — design spec

**Date:** 2026-05-26
**Status:** drafted, locked decisions A–E from 2026-05-26 conversation
**Branch:** feat/ai-on-demand (TBD at execution)

## Problem

Autopilot today is cron-driven and batched. The operator wants pull-based AI that responds when asked and is scoped to the work currently in front of them. Three gaps:

1. The 4-hourly scan creates proposals the operator didn't ask for.
2. No per-customer AI summary / action plan on the customer detail page.
3. No per-email "draft reply" assistance — drafting only happens via the autopilot category flow.

## Goal

- Default the autopilot scan cron to off (keep the schedule registered for future use; gate the handler).
- New customer-page AI card: prose summary + bulleted action plan with one-click drafting buttons. Cached 24h, manual Regenerate.
- New per-email "Draft reply with AI" button on inbound rows (customer detail Email tab + dashboard unactioned-emails widget). Supports a clean run *or* operator notes that steer the draft.

## Out of scope

- `/agent` global chat surface (still deferred).
- New autopilot proposal categories (5 stay as-is).
- Event-driven scans (on-inbound, on-RMA-state-change).
- Auto-execute without operator approval.

## Architecture

**One engine, three surfaces.** The autopilot engine (candidate finders + tool registry + draft pipeline) is the shared substrate:

```
       Autopilot engine
       ├─ 5 candidate finders (SQL)
       ├─ Tool registry (send_chase, send_statement, ...)
       └─ Draft pipeline (voice + facts + customer-ctx + corrections)
                 │
   ┌─────────────┼─────────────┐──────────────┐
   ▼             ▼             ▼              ▼
 /autopilot   customer-page   /agent chat   email-row
 global queue   AI card        (future)     "Draft reply"
 (existing)    (new)                         (new)
```

The customer-page card and email-row draft are new *views* into the same engine — not parallel systems.

## Approach

### 1. Cron default off (gated handler)

Matches the existing pattern used by `ai_corrections_cron_enabled` (see `src/jobs/definitions/ai-corrections-distill.ts`). The cron stays registered in `schedule.ts`; the handler reads the new flag and skips when disabled.

- New key: `app_settings.autopilot_scan_cron_enabled` ("true" | "" — default "").
- `autopilotScanHandler` short-circuits with `{ ran: false, reason: "disabled" }` when the flag is not "true".
- Manual triggers (the "Run autopilot now" button) bypass the gate entirely — they pass `trigger: "manual"`.
- Settings UI gets a toggle on `/ai-training` (next to the existing corrections-cron toggle) so the operator can flip it without code.

### 2. Customer AI card

**Data:**
- New table `customer_ai_cards`:
  - `customer_id` varchar(24) PK (FK customers.id, ON DELETE CASCADE)
  - `summary` text NOT NULL
  - `actions` json NOT NULL (array of `{kind, label, args}`)
  - `generated_at` timestamp NOT NULL
  - `model_used` varchar(64)
  - `tokens_in` int
  - `tokens_out` int
- TTL: 24h from `generated_at`. Stale rows are still returned to the client (with `is_stale: true`) so the page renders instantly; Regenerate forces a fresh call.

**Pipeline (`src/modules/ai-agent/customer-card.ts`):**
1. Call all 5 candidate finders scoped to this `customerId`. Each finder returns 0 or 1 candidate for the customer (they already filter by customer-state in SQL; we add a `customerId` filter param).
2. Collect customer state: KPIs (open balance, overdue, hold, last contact), last 5 emails (subject + snippet + direction + date), open invoices count + total, recent RMAs, `customers.ai_customer_context` text.
3. Single Anthropic call (Sonnet 4.6) — `messages.create` with:
   - System: voice guide + global facts + active global corrections (same as `composeSystem` for chase_next, minus category-scoped).
   - User: structured customer state + candidate findings + instructions to return JSON `{summary, actions[]}`.
   - Response: extracted as JSON via tool-use schema (Anthropic SDK structured output).
4. Upsert into `customer_ai_cards`.

**Action plan schema:**
```ts
type Action = {
  kind: "send_chase_email" | "send_statement" | "send_check_in_email"
      | "view_rma" | "view_cron_failure";
  label: string;                 // operator-facing button text
  args: Record<string, unknown>; // category-specific args
};
```
Action button kinds map to existing tools/routes:
- `send_chase_email` → opens compose modal pre-filled (decision A.i).
- `send_statement` → opens statement-send dialog pre-filled.
- `send_check_in_email` → opens compose modal pre-filled.
- `view_rma` → deep-links to RMA detail page.
- `view_cron_failure` → deep-links to ops/sync log.

**Endpoints (`src/server/routes/customer-ai-card.ts`):**
- `GET /api/customers/:id/ai-card` → cached row or generate-on-miss; returns `{summary, actions, generated_at, is_stale}`.
- `POST /api/customers/:id/ai-card/regenerate` → forced generation; returns updated card.

**Frontend (`src/web/components/customer-ai-card.tsx`):**
- New card on `/customers/:id` between the status strip and the tabs row.
- Renders summary as a styled prose block + actions as a vertical list of buttons.
- Each action button: clicking it calls a small handler that opens the compose modal pre-filled (or deep-links).
- Header right side: timestamp ("Generated 3h ago") + Regenerate button.

### 3. Per-email draft reply

**Data:**
- Add column `email_log.draft_ai_notes` text nullable. Persisted at send time alongside the AI draft body so the learn-from-edits distiller can later distinguish "AI drafted clean" from "AI drafted with operator steer".

**Pipeline (`src/modules/ai-agent/draft-reply.ts`):**
- Input: `emailLogId`, optional operator `notes` string.
- Load: the email row + entire thread history (all rows with same `threadId` for the same customer, ordered ASC) + customer state (KPIs, AI context) + voice guide + global facts + active global corrections.
- Anthropic call (Sonnet 4.6):
  - System: same as autopilot drafters (voice + facts + customer context).
  - User: thread transcript (sender + date + body), then operator notes if any, then "Generate a reply for this thread. Reply to the most recent inbound message."
  - Returns: `{subject, body}` (subject defaults to `Re: <thread subject>` if model omits).
- No DB write at draft time — the result is for client-side preview; the draft is only persisted to `email_log` when the operator clicks Send through the compose modal.

**Endpoint (`src/server/routes/email-log.ts` — extend the existing route file):**
- `POST /api/email-log/:id/draft-reply` body `{notes?: string}` → returns `{subject, body, notesUsed}`.

**Frontend:**
- "Draft reply" button on every inbound row in:
  - `src/web/components/email-list.tsx` (customer detail Email tab)
  - `src/web/components/dashboard/emails-widget.tsx` (dashboard unactioned-emails widget)
- Click → opens compose modal pre-populated as a Reply (existing `inReplyTo` path) with a new "AI" panel at the top:
  - Textarea: "Notes for AI (optional) — leave blank for a clean draft."
  - Button: "Generate".
  - On Generate: posts to `/api/email-log/:id/draft-reply` with the notes; on success replaces the body field (confirmation if user has edited).
- On Send: the existing `/api/email/send` path carries the notes as a new optional `draftAiNotes` field; route writes it to a follow-up `email_log` update once the poller has ingested the outbound, OR — simpler — the per-email draft-reply endpoint pre-writes/updates an `email_log.draft_ai_notes` immediately on Generate, keyed by the inbound id we replied to.

  **Decision:** simpler path — `draft_ai_notes` is stored on the *inbound* row we replied to (since that's what we know at Generate time), recording "what the operator told the AI to do when responding to this." Distiller picks it up when pairing draft/sent.

## Testing

**Unit:**
- Candidate finder scoping: each finder, given a `customerId` arg, returns 0 or 1 row matching that customer.
- Customer-card cache logic: hit vs miss vs stale.
- Draft-reply prompt assembly: thread ordering, notes inclusion, blank notes case.

**Integration / route:**
- `GET /api/customers/:id/ai-card` — cache miss path with mocked Anthropic returns expected JSON; cache hit path skips Anthropic.
- `POST /api/customers/:id/ai-card/regenerate` — always calls Anthropic, updates row.
- `POST /api/email-log/:id/draft-reply` — with and without notes; mocks Anthropic; verifies the `draft_ai_notes` upsert when notes present.

**Manual UI smoke (deploy-time):**
- Cron toggle off → schedule still registered, handler returns disabled.
- Cron toggle on → next scheduled run executes (verify in logs).
- Customer card renders, summary prose looks coherent, action buttons open compose pre-filled.
- Regenerate fires fresh Anthropic call (verify in cost log).
- Email draft (clean) — generates plausible body in voice.
- Email draft (with notes "send back X, sorry Y") — uses the steer.

## Risks

1. **Cost drift.** Per-customer-page-visit triggers a generate on cache miss. Risk: many concurrent operators or test loops generate a flood. Mitigation: cache TTL of 24h, only Regenerate forces fresh. Watch the cost tracker.
2. **Candidate finder drift.** Adding `customerId` filter to existing finders must not break the global scan path. Refactor each as `findCandidates(customerId?: string)` with the param defaulting to the existing "all customers" behaviour; cover with tests both for global and scoped paths.
3. **Surface drift.** /autopilot queue and customer card both consume the same candidate output but render differently. Mitigation: they call the same module functions; UI is the only thing that diverges.
4. **Compose-modal pre-fill regressions.** The new "AI" panel must not break existing reply/forward flows. Mitigation: pre-existing reply-mode tests stay green; AI panel is additive.
5. **Stale cards confuse operators.** A 23-hour-old card may not reflect a fresh payment. Mitigation: timestamp visible + Regenerate prominent; consider invalidation triggers in a follow-up (out of scope).

## Open follow-ups (not in scope but flagged)

- Cache invalidation on material customer events (new payment, new RMA state, hold flip) — pure cache-busting, no engine change.
- Prompt caching on the AI card pipeline once the system prefix consistently exceeds the SDK's cache minimum (Wave A/B/C deferral applies).
- Auto-execute on safe action kinds (currently every action is operator-approved).
