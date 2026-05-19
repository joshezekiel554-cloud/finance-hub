# Autopilot (Background Proposer) — Design Spec

**Date:** 2026-05-19
**Status:** Awaiting user review
**Branch context:** new branch off `main` (`feat/autopilot-v0`)

---

## Problem

The operator has a backlog of recurring "I know I should X for customer Y"
moments — send the next chase, send a statement they haven't received in a
month, check in on a customer who's gone silent, nudge the warehouse on a
stuck RMA. None of these are *hard*; they're cognitive load that scales
with customer count. The system has all the data to surface them and even
draft the actions, but doesn't.

Autopilot v0 is the first slice of the planned AI agentic surface (per
`~/.claude/plans/steady-crunching-kahn.md:217`): a background scanner that
identifies action candidates with deterministic SQL, surfaces them for
operator review, and on operator request asks Claude to draft the actual
action (email body, statement cover note). The operator approves; the
existing route handlers execute. AI never writes anything autonomously
in v0.

## Goal

End state:

1. Five rule categories produce candidate proposals every 4 hours (cron) or
   on demand (manual "Run autopilot now" button).
2. Stage 1 (cheap, deterministic SQL): candidate list shows immediately
   after a scan — customer name, reason, key metrics. No AI cost.
3. Stage 2 (AI cost, operator-initiated): operator selects which candidates
   to act on, clicks "Draft for selected". AI drafts only those.
4. Operator reviews drafts, edits if needed, approves → existing route
   handlers fire (full audit trail). Or rejects with one of two modes:
   **Dismiss** (skip this round, will resurface naturally) or **Snooze for X**
   (silenced for 1d / 3d / 1wk / 1mo regardless of state changes).
5. Customers can be opt-out per-row via `customers.agent_mode_excluded` so
   VIPs / weird-relationship accounts never appear in proposals.
6. Every AI-originated send (chase, statement, check-in, etc.) is visually
   tagged with an **AI** badge anywhere it surfaces — activity timeline,
   email logs, chase logs. The badge is clickable and opens a popover with
   the original proposal (reasoning, draft as approved, who approved, when).

## Out of scope

- **Inbox triage proposals** — the dashboard's existing Link/Dismiss UX
  covers that; revisit if volume justifies AI assistance.
- **Per-action-type configurable autonomy** — v0 is pure-propose for every
  action. v0.5/v1 will introduce tiered (some safe actions auto-execute).
- **Event-driven scanning** — cron-only in v0. v0.5 adds event-driven
  scans on new inbound email for inbox-triage-like categories.
- **Full agent chat surface** (`/agent` page with `@customer` scoping) —
  that's a separate larger initiative. Autopilot v0 builds the foundational
  tool registry that the chat will later reuse.
- **Hard daily budget cap** — soft cap with warning is enough for v0; team
  is small and tightly-monitored.
- **Per-user proposal queues** — all proposals are global; any team member
  can approve/reject any proposal.

## Approach

### Two-stage propose-then-draft

The single most important design choice: **the cron scan does ZERO AI calls.**
It runs only deterministic SQL queries to find candidates. AI is invoked
on-demand when the operator clicks "Draft for selected" on the autopilot
page. This keeps the scheduled cost predictable and avoids drafting emails
that get rejected.

Per-category gradient:

| Category | Needs AI drafting? |
|---|---|
| Chase next-step | Yes (email body, customer-specific tone) |
| Cold account check-in | Yes (warm-tone email body) |
| Statement gap | No — deterministic; just send |
| Stalled RMA — warehouse nudge | Optional (template usually fine) |
| Stalled RMA — operator review | No (notification only) |
| Cron failures | No (templated notification) |

For categories that don't need drafting, the candidate-card has a single
**Approve & Execute** button — no Stage 2 step. Operator's mental model:
"is this worth doing?" → yes → done.

### Tool registry as foundation

`src/modules/ai-agent/tools.ts` becomes the canonical registry where every
AI-callable action lives. Each tool is a thin shim: Zod args schema + an
`execute(args, ctx)` function that wraps an existing route handler. Six
tools needed for the 5 categories; the eventual `/agent` chat will add
~20-30 more incrementally. No parallel system.

## Architecture

### 1. Schema migration

New table `ai_proposals`:

```sql
CREATE TABLE ai_proposals (
  id VARCHAR(24) PRIMARY KEY,
  category VARCHAR(32) NOT NULL,
    -- 'chase_next' | 'cadence_statement' | 'cadence_cold' |
    -- 'ops_rma_stalled' | 'ops_cron_fail'
  entity_type VARCHAR(64) NOT NULL,     -- 'customer' | 'rma' | 'cron_job'
  entity_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
    -- 'pending'           : candidate identified, no draft yet
    -- 'drafting'          : AI generating draft (transient)
    -- 'drafted'           : draft ready, awaiting send approval
    -- 'approved'          : approved by operator (transient)
    -- 'executed'          : underlying action fired successfully
    -- 'execution_failed'  : underlying action errored
    -- 'dismissed'         : operator skipped this round
    -- 'snoozed'           : operator silenced for snoozed_until
    -- 'rejected'          : operator explicitly rejected
    -- 'expired'           : auto-expired after expires_at
    -- 'superseded'        : another proposal replaced it before action
  candidate_summary JSON NOT NULL,
    -- { customerName, balance, daysOverdue, lastChase, etc. }
    -- populated at scan time so the page can render without joins
  drafted_action JSON NULL,
    -- { tool: 'send_chase_email', args: {...} } — null until drafted
  drafted_preview TEXT NULL,
    -- human-readable (e.g. the email body) — null until drafted
  drafted_at TIMESTAMP NULL,
  reasoning TEXT NULL,
    -- AI's rationale at draft time
  confidence DECIMAL(3,2) NULL,
  scan_id VARCHAR(24) NOT NULL,
  decided_at TIMESTAMP NULL,
  decided_by_user_id VARCHAR(255) NULL,
  snoozed_until TIMESTAMP NULL,
  executed_at TIMESTAMP NULL,
  execution_error TEXT NULL,
  expires_at TIMESTAMP NOT NULL,  -- created_at + 7d
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_proposals_user FOREIGN KEY (decided_by_user_id)
    REFERENCES user(id) ON DELETE SET NULL,
  INDEX idx_ai_proposals_status_category (status, category, created_at),
  INDEX idx_ai_proposals_entity (entity_type, entity_id, status),
  INDEX idx_ai_proposals_scan (scan_id)
);
```

New table `ai_scans`:

```sql
CREATE TABLE ai_scans (
  id VARCHAR(24) PRIMARY KEY,
  trigger VARCHAR(16) NOT NULL,                -- 'cron' | 'manual'
  triggered_by_user_id VARCHAR(255) NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  total_candidates INT NOT NULL DEFAULT 0,
  proposals_generated INT NOT NULL DEFAULT 0,
  cost_cents INT NOT NULL DEFAULT 0,
    -- AI spend for this scan (mostly zero for v0; non-zero only when
    -- operator clicks Draft during the scan window — kept here for
    -- per-scan auditability)
  error TEXT NULL,
  CONSTRAINT fk_ai_scans_user FOREIGN KEY (triggered_by_user_id)
    REFERENCES user(id) ON DELETE SET NULL,
  INDEX idx_ai_scans_started (started_at)
);
```

Modifications to existing tables (all nullable, no data backfill needed):

```sql
ALTER TABLE customers
  ADD COLUMN agent_mode_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  ADD INDEX idx_customers_agent_excluded (agent_mode_excluded);

ALTER TABLE email_log
  ADD COLUMN ai_proposal_id VARCHAR(24) NULL,
  ADD CONSTRAINT fk_email_log_proposal
    FOREIGN KEY (ai_proposal_id) REFERENCES ai_proposals(id)
    ON DELETE SET NULL;

ALTER TABLE chase_log
  ADD COLUMN ai_proposal_id VARCHAR(24) NULL,
  ADD CONSTRAINT fk_chase_log_proposal
    FOREIGN KEY (ai_proposal_id) REFERENCES ai_proposals(id)
    ON DELETE SET NULL;

ALTER TABLE activities
  ADD COLUMN ai_proposal_id VARCHAR(24) NULL,
  ADD CONSTRAINT fk_activities_proposal
    FOREIGN KEY (ai_proposal_id) REFERENCES ai_proposals(id)
    ON DELETE SET NULL;

ALTER TABLE statement_sends
  ADD COLUMN ai_proposal_id VARCHAR(24) NULL,
  ADD CONSTRAINT fk_statement_sends_proposal
    FOREIGN KEY (ai_proposal_id) REFERENCES ai_proposals(id)
    ON DELETE SET NULL;
```

### 2. Drizzle schema

New files:
- `src/db/schema/ai-proposals.ts`
- `src/db/schema/ai-scans.ts`

Modify the existing schema files above (`customers.ts`, `crm.ts` for email_log
and activities, etc.) to add the new columns. Wire into
`src/db/schema/index.ts`.

### 3. Tool registry foundation

New module `src/modules/ai-agent/tools.ts`:

```ts
export type Tool<Args> = {
  name: string;
  description: string;
  argsSchema: z.ZodType<Args>;
  execute: (args: Args, ctx: ToolContext) => Promise<ToolResult>;
};

export type ToolContext = {
  userId: string;
  proposalId: string;       // for FK linkage on downstream rows
  db: DB;
};
```

v0 tools (5 — only what the v0 categories actually invoke):

| Tool | Wraps | Notes |
|---|---|---|
| `send_chase_email` | Chase send route logic | Args: customerId, tier, subject, body. Linked to ai_proposal_id in chase_log + email_log. |
| `send_statement` | `src/modules/statements/send.ts` | Args: customerId, optional coverNote. Linked in statement_sends. |
| `send_check_in_email` | Generic /api/send | Args: customerId, subject, body. Linked in email_log. |
| `nudge_warehouse_email` | Generic /api/send | Args: rmaId, subject, body. Sends to warehouse alias. |
| `create_admin_notification` | Direct notifications insert | Args: title, message, severity. For ops gap-closers. |

`lift_hold` is deliberately NOT in v0 — no v0 category triggers it (the
"hold + paid down to zero → propose lift" rule was considered during
brainstorming but not selected). Will land when the rule does, or sooner
if the `/agent` chat layer needs it.

The registry exports a `getToolByName(name): Tool<unknown> | null` used by
the approve handler.

### 4. Candidate-finding queries (no AI)

Five candidate-finders under `src/modules/ai-agent/candidates/`. Each is a
pure DB query returning `Array<{ entityType, entityId, summary }>`. Common
filter: `customers.agent_mode_excluded = FALSE`.

**`chase-next.ts`** — overdueBalance > 0, severity tier (computed via
existing `computeSeverity`) ∈ {CRITICAL, HIGH, MEDIUM}, no chase activity
in last 7 days.

**`cadence-statement.ts`** — open invoice count > 0, lastStatementSentAt
NULL or > 30 days.

**`cadence-cold.ts`** — open balance > 0, last payment > 45 days,
last contact (max of inbound + outbound email_date) > 21 days.

**`ops-rma-stalled.ts`** — rmas.status ∈ non-terminal, time-in-current-
state computed from the per-status timestamps (sentToWarehouseAt,
receivedAtWarehouseAt) > 14 days.

**`ops-cron-fail.ts`** — `sync_runs` table: last 2 runs of any cron job
have non-null error AND prior run had no error (consecutive failure
threshold). Excludes already-resolved jobs.

### 5. Scan loop

`src/modules/ai-agent/scanner.ts` orchestrates a scan:

```
async function runScan(trigger, userId?) {
  scanId = nanoid(24);
  insert ai_scans { id, trigger, triggered_by_user_id }

  for each category:
    candidates = await candidateFinders[category]();

    // Dedup against existing pending/drafted/snoozed proposals
    activeIds = SELECT entity_id FROM ai_proposals
                WHERE entity_type=? AND entity_id IN (?, ?, ?...)
                  AND (status IN ('pending', 'drafting', 'drafted')
                       OR (status='snoozed' AND snoozed_until > NOW())
                       OR (status='rejected' AND created_at > NOW() - INTERVAL 48 HOUR));
    candidates = candidates.filter(c => !activeIds.includes(c.entityId));

    for each candidate:
      insert ai_proposals {
        id, category, entity_type, entity_id,
        status='pending', candidate_summary, scan_id,
        expires_at = NOW() + INTERVAL 7 DAY
      }

      // Mirror to notifications for bell-icon surface
      insert notifications { kind='ai_proposal', payload={proposalId} }

  update ai_scans { finished_at, total_candidates, proposals_generated }
}
```

### 6. Draft-on-demand flow

When operator clicks **"Draft for selected"** on N candidates:

```
POST /api/autopilot/proposals/draft
body: { proposalIds: string[] }

For each proposalId in parallel (with concurrency cap of 4):
  UPDATE ai_proposals SET status='drafting' WHERE id=?;

  proposal = SELECT * FROM ai_proposals WHERE id=?;
  prompt = buildPromptFor(proposal.category, proposal.candidate_summary)
  response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    tools: [toolSchemaFor(proposal.category)],
    messages: [{ role: 'user', content: prompt }],
  });

  if AI returns tool_use:
    UPDATE ai_proposals SET
      status='drafted',
      drafted_action = response.tool_call,
      drafted_preview = preview(response.tool_call),
      reasoning = response.text,
      confidence = response.confidence,
      drafted_at = NOW()
    WHERE id=?;
  else if AI returns 'skip':
    UPDATE ai_proposals SET
      status='dismissed', decided_at=NOW(),
      reasoning = response.skipReason
    WHERE id=?;
```

**Bulk-draft cost preview**: before the request, frontend shows
"Draft N emails (~$X estimated · ~Ys)" — estimated from
`avg_cost_per_draft × N` (track in localStorage from past drafts).

For categories without drafting (statement, cron-fail, RMA-notif): the
"Draft" button is just labeled **"Approve & Execute"**. Same endpoint,
but skips the AI call — sets `status='approved'` directly.

### 7. Approve / execute flow

```
POST /api/autopilot/proposals/:id/approve
(operator confirms the drafted action)

UPDATE ai_proposals SET
  status='approved', decided_at=NOW(), decided_by_user_id=?
WHERE id=?;

// Stale-draft guard: re-run the candidate query for this entity.
// If no longer matches the rule, abort with 409:
//   "Conditions changed since drafted: balance now £0. Send anyway?"
// Frontend prompts; on confirm, retries with ?force=true.
stillEligible = await candidateFinders[category].isStillEligible(entityId);
if (!stillEligible && !force) {
  return reply.code(409).send({ stale: true, currentSummary: ... });
}

// Queue the underlying action via BullMQ.
const tool = getToolByName(drafted_action.tool);
await queues.autopilotExecution.add('execute', {
  proposalId,
  toolName: drafted_action.tool,
  toolArgs: drafted_action.args,
  userId,
});

// Worker calls tool.execute(args, { userId, proposalId, db })
// Tool's execute() function sets ai_proposal_id on the downstream rows
// (email_log, chase_log, activities, statement_sends).

// On success: UPDATE ai_proposals SET status='executed', executed_at=NOW()
// On failure: UPDATE ai_proposals SET status='execution_failed',
//   execution_error=..., create notification for operator.
```

### 8. Reject modes

Two buttons on a `drafted` (or `pending` for no-AI categories) proposal:

**Dismiss** — `UPDATE ai_proposals SET status='dismissed', decided_at=NOW()`.
Next scan will re-find this entity naturally if the candidate query still
matches. Use when capacity-limited today.

**Snooze for X** — dropdown (1d / 3d / 1wk / 1mo). `UPDATE ai_proposals SET
status='snoozed', snoozed_until=NOW()+INTERVAL X, decided_at=NOW()`.
Entity won't re-appear in any category proposal until snoozed_until passes,
regardless of state changes. Use when "I've decided not to chase for a
while" (disputed invoice, customer asked for time, etc.).

48h re-propose throttle for `status='rejected'` (legacy explicit reject,
not used in v0 UI — kept for forward compatibility).

### 9. Customer grouping

When rendering `/autopilot` page: customers with proposals in 2+ categories
collapse to a single row showing the customer + a comma-separated list of
reasons:

```
☐ Acme Ltd       — chase L3 · statement gap · cold account
☐ Brown & Co     — chase L2 · statement gap
☐ Vega Group     — chase L1
```

Expanding the row reveals per-category proposal cards with their own
Dismiss/Snooze/Draft buttons. Approving one category does not affect the
others.

Non-customer entities (RMAs, cron jobs) render as their own rows below
the customer-grouped section.

### 10. UI surfaces

**Bell notification** (existing notifications system):
- New row inserted per proposal at scan time, `kind='ai_proposal'`,
  `payload={proposalId, category, entitySummary}`.
- Bell badge shows pending count.
- Clicking a notification opens the proposal in a side-panel popover
  (same component as the AI-badge click-through, see below).

**`/autopilot` page** (new):
- Header: scan-status row ("Last scan: 14m ago · 3 pending · [Run autopilot now]").
- Filters: category, status (pending / drafted / snoozed / executed).
- Body: candidates grouped by customer (see §9).
- Bulk-select checkboxes + "Draft selected" / "Dismiss selected" /
  "Snooze selected" actions.
- New file `src/web/pages/autopilot.tsx` + a few sub-components under
  `src/web/components/autopilot/`.

**Inline widget badges on dashboard** (Chase + RMAs widgets only):
- Chase widget header: `Chase queue (10) · 3 AI suggestions` with the
  count linking to expand inline. Expansion shows chase-next-step +
  cold-account proposals as candidate rows above the manual chase list.
- RMAs widget header: same shape, surfacing stalled-RMA proposals.
- Statement-gap and cron-failures have no widget mapping — they appear
  only via bell + /autopilot.

**AI provenance badge** (the visual marker on AI-originated rows):
- Reusable `<AiProposalBadge proposalId={...} />` component.
- Renders a compact `AI` pill (one of the existing badge tones).
- Appears on:
  - Activity timeline rows (customer-detail)
  - Email log rows (customer-detail emails tab)
  - Chase log table rows
  - Statement sends log rows
- Clicking the badge opens a popover side-panel showing:
  - Original AI proposal (category, reasoning, drafted preview)
  - Who approved + when
  - Link to "view scan" (shows the broader scan context if interesting)
- New endpoint `GET /api/autopilot/proposals/:id` powers the popover.

### 11. Cost tracking

Reuse existing `ai_interactions` cost tracking. Each AI call writes a row:
`{ model, input_tokens, output_tokens, cost_cents, purpose='autopilot_draft', proposal_id }`.

Aggregate query for daily spend:
```sql
SELECT SUM(cost_cents) FROM ai_interactions
WHERE purpose='autopilot_draft' AND occurred_at >= CURDATE();
```

**Soft daily cap** (configurable in Settings, default $20 = 2000 cents):
- Check at the start of each draft request. If `today_spend + max_estimated > cap`:
  - Allow the request to proceed (soft, not hard).
  - Insert a notification: "Autopilot AI spend $X exceeded daily soft cap
    $Y. Investigate or raise cap in Settings."
  - Only one notification per day.

### 12. Settings integration

New section in `src/web/pages/settings.tsx` — "Autopilot":
- Toggle: enabled (default: ON)
- Numeric input: daily soft budget cap (cents, default 2000)
- Per-category toggles (5 checkboxes): enable each rule independently
- Read-only: last scan time, last 24h proposal counts by category,
  rolling-30d cost

Plus on customer detail page: a "Agent mode" toggle near the hold-status
badge area: ON (default) → autopilot may propose actions; OFF → excluded
from all autopilot scans. Persists via `customers.agent_mode_excluded`.

## Per-category logic summary

| # | Category | Candidate rule (SQL) | Stage 2 (AI draft) | Tool on approve |
|---|---|---|---|---|
| 1 | chase_next | overdue > 0 + tier ∈ {C,H,M} + no chase 7d + not excluded | Yes — email body tier-aware | `send_chase_email` |
| 2 | cadence_statement | open invoices + last statement > 30d + not excluded | Optional cover note | `send_statement` |
| 3 | cadence_cold | open balance + last payment > 45d + last contact > 21d + not excluded | Yes — warm check-in body | `send_check_in_email` |
| 4 | ops_rma_stalled | non-terminal RMA + days-in-state > 14 | Sometimes (warehouse nudge body) | `nudge_warehouse_email` or `create_admin_notification` |
| 5 | ops_cron_fail | sync_runs has 2+ consecutive failures | No — templated | `create_admin_notification` |

## Testing

### Unit (vitest)

`src/modules/ai-agent/candidates/*.test.ts` — one per candidate-finder:
- happy path (rule matches)
- excluded customer (agent_mode_excluded=true → no row)
- recent activity prevents re-pickup (e.g. chase < 7d ago)
- combined-condition edge cases

`src/modules/ai-agent/tools.test.ts` — args schema validation for each tool.

`src/server/routes/autopilot.test.ts` — Zod boundaries for draft/approve/
reject/snooze endpoints; the stale-draft guard endpoint (`?force=true`
behavior).

### Manual smoke (substitute for E2E)

After deploy:

1. Visit `/autopilot`. Confirm page renders with "Run autopilot now"
   button + filters.
2. Click "Run autopilot now". Verify scan completes within ~5s. Candidate
   list populates if data matches any rule.
3. For a chase-next candidate: click "Draft" → AI generates body within
   ~10s → review draft → edit → click "Approve & Send" → verify email
   landed + `email_log.ai_proposal_id` is set + chase_log row written.
4. For a statement-gap candidate: click "Approve & Execute" (no draft
   step) → verify statement sent + `statement_sends.ai_proposal_id`
   set.
5. Click "Snooze for 1d" on a candidate → reload page → verify it's
   gone from pending → check ai_proposals.snoozed_until is set.
6. Click "Dismiss" on a candidate → reload → verify it's gone, then
   trigger another scan and verify it re-appears (because dismissed,
   not snoozed, and the SQL still matches).
7. On a customer detail page, toggle "Agent mode" OFF → trigger scan →
   verify no proposals for that customer.
8. Open an AI-originated chase email in customer activity timeline →
   verify AI badge appears next to the row → click badge → verify
   popover opens with the original proposal + approver + timestamp.
9. Trigger a manual scan twice in a row within 5min → verify dedup
   (same candidate not re-proposed).
10. Run a deliberate Anthropic-API failure (block network in dev) →
    verify proposal marked `execution_failed` with error preserved +
    notification created.

## Migration / rollout

1. Apply migration (`ai_proposals`, `ai_scans`, 4 column ALTERs).
2. Default-ON for all 5 categories. Settings panel can disable any
   individually if a rule becomes noisy.
3. First scheduled scan runs at the next 4-hour boundary post-deploy
   (00/04/08/12/16/20 London). Manual trigger also available
   immediately.

## Risks and tradeoffs

- **Operator overwhelm if rules are too eager.** Defaults are conservative
  (7d chase gap, 30d statement gap, 45d payment + 21d contact for cold).
  If post-launch a category produces too many candidates, dial up the
  threshold or temporarily disable in Settings.
- **AI draft quality varies by customer context richness.** A customer
  with sparse activity history will get more generic drafts. Acceptable
  — operator can edit. Worth tracking edit-rate as a quality signal.
- **Bulk-draft cost surprise.** Mitigated by the cost-preview button
  showing "(~$X)" before firing. Operator sees the bill before clicking.
- **Stale data window.** A customer's state can change between scan
  (4h cron tick) and approve (operator clicks). Stale-draft guard
  (re-runs eligibility at approve time) catches the common case.
- **Approval bottleneck.** Every action goes through human approval —
  fast, but during a busy day, proposals could pile up. Snooze + Dismiss
  give the operator triage tools.
- **Bell-notification spam.** Each proposal creates a notification.
  Could overwhelm the bell on a high-candidate scan. Mitigation: collapse
  `kind='ai_proposal'` notifications in the bell panel by scan_id, show
  a single "12 new autopilot proposals from scan at 14:00" row.
- **Tool registry security.** Every tool wraps an existing route handler
  that already enforces auth + audit. No tool grants AI more capability
  than an authenticated operator has. Bug surface is the args validation;
  Zod schemas + explicit "not for AI" denylist (later) keep this bounded.

## Effort estimate

~5-7 days end-to-end:

- Day 1: Schema migrations + Drizzle wire + tool registry foundation.
- Day 2: 5 candidate-finders (pure SQL queries + unit tests).
- Day 3: Scan loop + cron + manual trigger + BullMQ approval worker.
- Day 4: AI draft endpoint + per-category prompt templates + Anthropic
  integration + cost tracking.
- Day 5: `/autopilot` page (candidate browser, grouping, bulk actions).
- Day 6: AI provenance badge + popover + Settings panel + customer
  agent_mode toggle.
- Day 7: Dashboard widget badges (Chase + RMAs) + manual smoke + push.

v0.5 follow-up (post-launch ~2 weeks):
- Event-driven scans for inbox triage (when re-enabled).
- Click-badge-to-jump-to-related-proposals from approved rows (richer
  popover).
- Per-category configurable thresholds in Settings.
- Edit-rate dashboard for draft quality signal.
