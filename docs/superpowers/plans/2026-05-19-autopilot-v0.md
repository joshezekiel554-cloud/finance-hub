# Autopilot v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the background-proposer slice of the AI agentic surface — cron + manual scans find action candidates via deterministic SQL across 5 rule categories, operator clicks Draft to invoke Claude only for committed candidates, approval fires the underlying action through existing route handlers with full audit trail and an AI provenance badge anywhere the resulting rows surface.

**Architecture:** Two new tables (`ai_proposals`, `ai_scans`) + nullable `ai_proposal_id` FKs on `email_log`/`chase_log`/`activities`/`statement_sends` + `customers.agent_mode_excluded` boolean. New module `src/modules/ai-agent/` holds the tool registry (5 v0 tools wrapping existing route handlers), 5 SQL candidate-finders, 5 prompt templates, and the scanner orchestrator. BullMQ for cron + approval execution. New `/autopilot` page + reusable `<AiProposalBadge>` component + Settings panel + Chase/RMAs widget badges.

**Tech Stack:** Drizzle ORM (MySQL 8) + drizzle-kit, Fastify v5 + Zod, BullMQ + Redis, Anthropic SDK (Sonnet 4.6) with tool-use, vitest, React 18 + TanStack Query + Radix Popover/Dialog + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-19-autopilot-design.md`

---

## Spec adaptations (discovered during recon)

1. **Notifications enum already has `ai_proposal`** kind in `NOTIFICATION_KINDS` — no enum migration needed.
2. **AI surface enum needs `autopilot_draft` added** to `AI_SURFACES` in `src/db/schema/audit.ts` (currently has `agent_chat`, `inline_*`, `task_proposal` but not autopilot).
3. **`sync_runs` is the source for ops-cron-fail detection** — columns: `kind` (enum), `startedAt`, `completedAt`, `status` (`running|ok|failed|partial`), `errorMessage`. Filter `status='failed'` for the consecutive-failure rule.

---

## File structure

**Create:**
- `migrations/0036_autopilot.sql` (drizzle-kit generated)
- `src/db/schema/ai-proposals.ts`
- `src/db/schema/ai-scans.ts`
- `src/modules/ai-agent/tools.ts` — tool registry + 5 v0 tool shims
- `src/modules/ai-agent/scanner.ts` — orchestrator
- `src/modules/ai-agent/proposal-store.ts` — DB CRUD for proposals
- `src/modules/ai-agent/candidates/chase-next.ts`
- `src/modules/ai-agent/candidates/cadence-statement.ts`
- `src/modules/ai-agent/candidates/cadence-cold.ts`
- `src/modules/ai-agent/candidates/ops-rma-stalled.ts`
- `src/modules/ai-agent/candidates/ops-cron-fail.ts`
- `src/modules/ai-agent/prompts/chase-next.ts`
- `src/modules/ai-agent/prompts/cadence-statement.ts`
- `src/modules/ai-agent/prompts/cadence-cold.ts`
- `src/modules/ai-agent/prompts/ops-rma-stalled.ts`
- `src/modules/ai-agent/prompts/ops-cron-fail.ts`
- `src/jobs/definitions/autopilot-scan.ts` — BullMQ scan handler
- `src/jobs/definitions/autopilot-execute.ts` — BullMQ approval-execute worker
- `src/server/routes/autopilot.ts` — manual scan, draft, approve, dismiss, snooze, get
- `src/web/pages/autopilot.tsx`
- `src/web/components/autopilot/proposal-card.tsx`
- `src/web/components/autopilot/ai-proposal-badge.tsx` — reusable badge + popover
- `src/modules/ai-agent/candidates/*.test.ts` — one per finder
- `src/server/routes/autopilot.test.ts`

**Modify:**
- `src/db/schema/index.ts` — re-export new schemas
- `src/db/schema/audit.ts` — add `autopilot_draft` to `AI_SURFACES`
- `src/db/schema/customers.ts` — add `agentModeExcluded` column
- `src/db/schema/crm.ts` — add `aiProposalId` FK column to `email_log` and `activities`
- `src/db/schema/audit.ts` — add `aiProposalId` FK column to `chase_log` (or wherever chase_log lives)
- `src/db/schema/crm.ts` — add `aiProposalId` FK column to `statement_sends`
- `src/jobs/schedule.ts` — register `autopilot-scan` cron `0 */4 * * *` Europe/London
- `src/jobs/queues.ts` — declare `autopilotScan` + `autopilotExecute` queues
- `src/jobs/worker.ts` — register both handlers
- `src/server/routes/index.ts` — register `autopilotRoute`
- `src/web/pages/settings.tsx` — add Autopilot section
- `src/web/pages/customer-detail.tsx` — add "Agent mode" toggle near hold badge
- `src/web/components/dashboard/chase-widget.tsx` — add "N AI suggestions" header + inline expansion
- `src/web/components/dashboard/rmas-widget.tsx` — same shape for stalled-RMA proposals
- `src/lib/env.ts` — confirm `ANTHROPIC_API_KEY` exists (it does)

---

## Wave map (parallelisable groups flagged)

| Wave | Tasks | Mode |
|---|---|---|
| 1 | Schema migration + Drizzle wire | Sequential subagent |
| 2 | Tool registry + 5 tool shims | Sequential subagent |
| 3 | 5 candidate-finders | **Team of 5** (file-disjoint) |
| 4 | Scanner + cron + manual-trigger route | Sequential subagent |
| 5 | 5 prompt templates | **Team of 5** (file-disjoint) |
| 6 | Draft endpoint + Anthropic integration + cost tracking | Sequential subagent |
| 7 | Approval worker + remaining routes (approve / dismiss / snooze / get) | Sequential subagent |
| 8 | `/autopilot` page | Sequential subagent |
| 9 | AI badge + Customer agent-toggle + Settings panel | **Team of 3** (file-disjoint) |
| 10 | Chase widget + RMAs widget badge expansions | **Team of 2** (file-disjoint) |
| 11 | Full smoke + push | Inline |

Two-stage Opus review at end of feature before merging to main.

---

## Task 1: Schema migration + Drizzle wire

**Files:**
- Create: `src/db/schema/ai-proposals.ts`, `src/db/schema/ai-scans.ts`
- Modify: `src/db/schema/index.ts`, `src/db/schema/audit.ts`, `src/db/schema/customers.ts`, `src/db/schema/crm.ts`
- Create: `migrations/0036_autopilot.sql`

- [ ] **Step 1: Add `autopilot_draft` to `AI_SURFACES`**

In `src/db/schema/audit.ts`, locate the `AI_SURFACES` array and add:

```ts
export const AI_SURFACES = [
  "agent_chat",
  "inline_draft_email",
  "inline_summarize",
  "inline_suggest",
  "inline_enhance",
  "task_proposal",
  "autopilot_draft", // NEW
] as const;
```

- [ ] **Step 2: Add `agentModeExcluded` to customers**

In `src/db/schema/customers.ts`, inside the `customers` table definition, add (right after the existing tags/customerType section):

```ts
agentModeExcluded: boolean("agent_mode_excluded").notNull().default(false),
```

Also add to the indexes block:

```ts
agentExcludedIdx: index("idx_customers_agent_excluded").on(t.agentModeExcluded),
```

- [ ] **Step 3: Create `src/db/schema/ai-proposals.ts`**

```ts
import {
  decimal,
  index,
  json,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const AI_PROPOSAL_CATEGORIES = [
  "chase_next",
  "cadence_statement",
  "cadence_cold",
  "ops_rma_stalled",
  "ops_cron_fail",
] as const;
export type AiProposalCategory = (typeof AI_PROPOSAL_CATEGORIES)[number];

export const AI_PROPOSAL_STATUSES = [
  "pending",
  "drafting",
  "drafted",
  "approved",
  "executed",
  "execution_failed",
  "dismissed",
  "snoozed",
  "rejected",
  "expired",
  "superseded",
] as const;
export type AiProposalStatus = (typeof AI_PROPOSAL_STATUSES)[number];

export const aiProposals = mysqlTable(
  "ai_proposals",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    category: varchar("category", { length: 32 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    candidateSummary: json("candidate_summary")
      .$type<Record<string, unknown>>()
      .notNull(),
    draftedAction: json("drafted_action").$type<{
      tool: string;
      args: Record<string, unknown>;
    }>(),
    draftedPreview: text("drafted_preview"),
    draftedAt: timestamp("drafted_at"),
    reasoning: text("reasoning"),
    confidence: decimal("confidence", { precision: 3, scale: 2 }),
    scanId: varchar("scan_id", { length: 24 }).notNull(),
    decidedAt: timestamp("decided_at"),
    decidedByUserId: varchar("decided_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    snoozedUntil: timestamp("snoozed_until"),
    executedAt: timestamp("executed_at"),
    executionError: text("execution_error"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    statusCategoryIdx: index("idx_ai_proposals_status_category").on(
      t.status,
      t.category,
      t.createdAt,
    ),
    entityIdx: index("idx_ai_proposals_entity").on(
      t.entityType,
      t.entityId,
      t.status,
    ),
    scanIdx: index("idx_ai_proposals_scan").on(t.scanId),
  }),
);

export type AiProposal = typeof aiProposals.$inferSelect;
export type NewAiProposal = typeof aiProposals.$inferInsert;
```

- [ ] **Step 4: Create `src/db/schema/ai-scans.ts`**

```ts
import {
  index,
  int,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const aiScans = mysqlTable(
  "ai_scans",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    trigger: varchar("trigger", { length: 16 }).notNull(),
    triggeredByUserId: varchar("triggered_by_user_id", {
      length: 255,
    }).references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    totalCandidates: int("total_candidates").notNull().default(0),
    proposalsGenerated: int("proposals_generated").notNull().default(0),
    costCents: int("cost_cents").notNull().default(0),
    error: text("error"),
  },
  (t) => ({
    startedIdx: index("idx_ai_scans_started").on(t.startedAt),
  }),
);

export type AiScan = typeof aiScans.$inferSelect;
export type NewAiScan = typeof aiScans.$inferInsert;
```

- [ ] **Step 5: Add `aiProposalId` FK columns to existing tables**

In `src/db/schema/crm.ts` — find the `emailLog` table definition and add (alongside the existing columns):

```ts
aiProposalId: varchar("ai_proposal_id", { length: 24 }),
```

Same for `activities` table in `src/db/schema/crm.ts`:

```ts
aiProposalId: varchar("ai_proposal_id", { length: 24 }),
```

Same for `statementSends` table (find it; likely in `crm.ts`):

```ts
aiProposalId: varchar("ai_proposal_id", { length: 24 }),
```

Locate the chase log table (grep `chase_log` in schema files) and add the same column.

**Note:** intentionally NOT adding FK constraints in the schema for these — we'll let drizzle-kit emit them. If drizzle's column-level `.references(...)` syntax requires the proposals table to be in the same module, leave references out and add the FK constraint manually in step 6 by editing the generated migration.

- [ ] **Step 6: Wire exports**

Edit `src/db/schema/index.ts` and add (near other recent exports):

```ts
export * from "./ai-proposals";
export * from "./ai-scans";
```

- [ ] **Step 7: Generate migration**

Run: `npm run db:generate`
Expected: produces `migrations/0036_<word>.sql`.

- [ ] **Step 8: Inspect + rename migration**

Read the new SQL file. Confirm:
- `CREATE TABLE ai_proposals (...)` with all columns + 3 indexes
- `CREATE TABLE ai_scans (...)` with columns + 1 index
- `ALTER TABLE user ADD COLUMN agent_mode_excluded` etc.
- `ALTER TABLE customers ADD COLUMN agent_mode_excluded` + index
- 4 × `ALTER TABLE ... ADD COLUMN ai_proposal_id` (email_log, activities, statement_sends, chase_log)

If the generated migration is missing FK constraints on the `ai_proposal_id` columns, hand-add them at the end:

```sql
ALTER TABLE `email_log` ADD CONSTRAINT `fk_email_log_proposal`
  FOREIGN KEY (`ai_proposal_id`) REFERENCES `ai_proposals`(`id`)
  ON DELETE SET NULL;
-- repeat for chase_log, activities, statement_sends
```

Rename file to `migrations/0036_autopilot.sql` and update the `tag` in `migrations/meta/_journal.json`.

- [ ] **Step 9: Apply migration locally**

Run: `npm run db:migrate`
Expected: clean apply.

- [ ] **Step 10: Type-check + commit**

Run: `npm run build` → PASS.

```bash
git add migrations/0036_autopilot.sql migrations/meta/_journal.json migrations/meta/0036_snapshot.json src/db/schema/
git commit -m "Autopilot: schema (ai_proposals, ai_scans, FK columns, agent_mode_excluded)"
```

---

## Task 2: Tool registry + 5 tool shims

**Files:**
- Create: `src/modules/ai-agent/tools.ts`
- Create: `src/modules/ai-agent/proposal-store.ts`

- [ ] **Step 1: Create `proposal-store.ts`**

```ts
// src/modules/ai-agent/proposal-store.ts
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";

export async function markProposalExecuted(
  proposalId: string,
): Promise<void> {
  await db
    .update(aiProposals)
    .set({ status: "executed", executedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(aiProposals.id, proposalId));
}

export async function markProposalExecutionFailed(
  proposalId: string,
  error: string,
): Promise<void> {
  await db
    .update(aiProposals)
    .set({
      status: "execution_failed",
      executionError: error,
    })
    .where(eq(aiProposals.id, proposalId));
}
```

- [ ] **Step 2: Create `tools.ts`**

```ts
// src/modules/ai-agent/tools.ts
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog } from "../../db/schema/crm.js";
import { notifications } from "../../db/schema/notifications.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { appendSignatures } from "../email-compose/signatures.js";
import { sendStatement } from "../statements/send.js";
// Chase send is currently inline in the chase route; for v0 we replicate
// the smallest possible shim that produces the same outcome. Refactor to
// extract a callable function in a follow-up.

export type ToolContext = {
  userId: string;
  proposalId: string;
};

export type ToolResult = { ok: true } | { ok: false; error: string };

type Tool<A> = {
  name: string;
  description: string;
  argsSchema: z.ZodType<A>;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>;
};

// ── send_chase_email ───────────────────────────────────────────────────
const SendChaseEmailArgs = z.object({
  customerId: z.string().min(1).max(24),
  tier: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
});
type SendChaseEmailArgs = z.infer<typeof SendChaseEmailArgs>;

const sendChaseEmailTool: Tool<SendChaseEmailArgs> = {
  name: "send_chase_email",
  description: "Send a chase email at the specified tier to a customer.",
  argsSchema: SendChaseEmailArgs,
  execute: async (args, ctx) => {
    try {
      const customer = await db
        .select()
        .from(customers)
        .where(eq(customers.id, args.customerId))
        .limit(1);
      if (!customer[0] || !customer[0].primaryEmail) {
        return { ok: false, error: "customer or primary email missing" };
      }
      const aliasEmail = "accounts@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      const result = await sendEmail({
        to: customer[0].primaryEmail,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
      });
      // Link the resulting email_log row back to the proposal.
      await db
        .update(emailLog)
        .set({ aiProposalId: ctx.proposalId })
        .where(eq(emailLog.id, result.messageId)); // adjust if id shape differs
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── send_statement ─────────────────────────────────────────────────────
const SendStatementArgs = z.object({
  customerId: z.string().min(1).max(24),
  coverNote: z.string().max(2000).optional(),
});

const sendStatementTool: Tool<z.infer<typeof SendStatementArgs>> = {
  name: "send_statement",
  description: "Send a statement of open invoices to a customer.",
  argsSchema: SendStatementArgs,
  execute: async (args, ctx) => {
    try {
      await sendStatement({
        customerId: args.customerId,
        userId: ctx.userId,
        overrides: args.coverNote ? { body: args.coverNote } : {},
      });
      // statement_sends.ai_proposal_id linkage: best-effort UPDATE on the
      // most recent row for this customer. Tighten with a return value
      // from sendStatement in a follow-up.
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── send_check_in_email ────────────────────────────────────────────────
const SendCheckInEmailArgs = z.object({
  customerId: z.string().min(1).max(24),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
});

const sendCheckInEmailTool: Tool<z.infer<typeof SendCheckInEmailArgs>> = {
  name: "send_check_in_email",
  description: "Send a warm check-in email to a customer who has gone silent.",
  argsSchema: SendCheckInEmailArgs,
  execute: async (args, ctx) => {
    try {
      const c = await db
        .select()
        .from(customers)
        .where(eq(customers.id, args.customerId))
        .limit(1);
      if (!c[0] || !c[0].primaryEmail) {
        return { ok: false, error: "customer or primary email missing" };
      }
      const aliasEmail = "accounts@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      const result = await sendEmail({
        to: c[0].primaryEmail,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
      });
      await db
        .update(emailLog)
        .set({ aiProposalId: ctx.proposalId })
        .where(eq(emailLog.id, result.messageId));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── nudge_warehouse_email ──────────────────────────────────────────────
const NudgeWarehouseEmailArgs = z.object({
  rmaId: z.string().min(1).max(24),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
});

const nudgeWarehouseEmailTool: Tool<z.infer<typeof NudgeWarehouseEmailArgs>> = {
  name: "nudge_warehouse_email",
  description:
    "Send a nudge to the warehouse about a stalled RMA. To address is configured server-side.",
  argsSchema: NudgeWarehouseEmailArgs,
  execute: async (args, ctx) => {
    const warehouseEmail = "warehouse@feldart.com";
    try {
      const aliasEmail = "warehouse@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      await sendEmail({
        to: warehouseEmail,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── create_admin_notification ──────────────────────────────────────────
const CreateAdminNotificationArgs = z.object({
  title: z.string().min(1).max(255),
  message: z.string().min(1).max(2000),
  severity: z.enum(["info", "warning", "error"]).default("warning"),
});

const createAdminNotificationTool: Tool<
  z.infer<typeof CreateAdminNotificationArgs>
> = {
  name: "create_admin_notification",
  description: "Create an admin notification visible to the team.",
  argsSchema: CreateAdminNotificationArgs,
  execute: async (args, ctx) => {
    try {
      await db.insert(notifications).values({
        id: nanoid(24),
        userId: ctx.userId,
        kind: "ai_proposal",
        refType: "ai_proposal",
        refId: ctx.proposalId,
        // notifications table has title/body — verify column names by reading
        // src/db/schema/notifications.ts and adjust if different.
      } as never);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── Registry ───────────────────────────────────────────────────────────
const TOOLS: Record<string, Tool<unknown>> = {
  send_chase_email: sendChaseEmailTool as unknown as Tool<unknown>,
  send_statement: sendStatementTool as unknown as Tool<unknown>,
  send_check_in_email: sendCheckInEmailTool as unknown as Tool<unknown>,
  nudge_warehouse_email: nudgeWarehouseEmailTool as unknown as Tool<unknown>,
  create_admin_notification:
    createAdminNotificationTool as unknown as Tool<unknown>,
};

export function getToolByName(name: string): Tool<unknown> | null {
  return TOOLS[name] ?? null;
}

export function listTools(): string[] {
  return Object.keys(TOOLS);
}
```

**Implementation note:** Some of the tool integrations require reading the actual signatures of `sendEmail`, `sendStatement`, `appendSignatures`, and the notifications schema. Adjust as the real shapes dictate; the above is a faithful skeleton.

- [ ] **Step 3: Type-check + commit**

Run: `npm run build` → PASS. (TypeScript may complain about a few `as never` / `as unknown as` casts in the tool shims — the registry is intentionally permissive in args type. Tighten in a follow-up if it bothers.)

```bash
git add src/modules/ai-agent/tools.ts src/modules/ai-agent/proposal-store.ts
git commit -m "Autopilot: tool registry + 5 v0 tool shims"
```

---

## Task 3: 5 candidate-finders — **TEAM WAVE**

Five file-disjoint candidate-finder modules. Dispatch as a team of 5 parallel teammates per `feedback_team-orchestration` (no-commit + batch-orchestrator-commit pattern).

Each teammate creates ONE file under `src/modules/ai-agent/candidates/` + a sibling `.test.ts`. All share this shape:

```ts
// Candidate-finder contract
export type Candidate = {
  entityType: "customer" | "rma" | "cron_job";
  entityId: string;
  summary: Record<string, unknown>; // becomes ai_proposals.candidate_summary
};

export async function findCandidates(): Promise<Candidate[]>;
export async function isStillEligible(entityId: string): Promise<boolean>;
```

**Common rule for all 5 candidate finders:** filter out `customers.agent_mode_excluded = TRUE` (where the candidate is a customer-typed entity). For rma + cron_job categories, the exclusion doesn't apply directly — but if an RMA's customer is excluded, also exclude.

### Task 3a: chase-next finder

**Files:**
- Create: `src/modules/ai-agent/candidates/chase-next.ts`
- Create: `src/modules/ai-agent/candidates/chase-next.test.ts`

Find customers where: `overdueBalance > 0` AND severity tier (via `computeSeverity`) ∈ `{CRITICAL, HIGH, MEDIUM}` AND no chase_log row for this customer in last 7 days AND `agent_mode_excluded = FALSE`.

Mirror the chase widget endpoint's pattern from `src/server/routes/dashboard.ts` for the overdue-customer batched query + `computeSeverity` invocation. Summary fields: `{customerName, overdueBalance, daysOverdue, tier, lastChaseAt}`.

`isStillEligible(customerId)`: re-run the same WHERE clauses for this single id.

Tests: at minimum two cases (eligible customer present in results; agent-excluded customer absent from results).

Commit (orchestrator-batched).

### Task 3b: cadence-statement finder

**Files:**
- Create: `src/modules/ai-agent/candidates/cadence-statement.ts`
- Create: `src/modules/ai-agent/candidates/cadence-statement.test.ts`

Find customers where: open invoice count > 0 AND `lastStatementSentAt` NULL OR > 30 days ago AND `agent_mode_excluded = FALSE`. Summary: `{customerName, openInvoiceCount, totalOpenBalance, lastStatementSentAt}`.

Tests: two cases as above.

### Task 3c: cadence-cold finder

**Files:**
- Create: `src/modules/ai-agent/candidates/cadence-cold.ts`
- Create: `src/modules/ai-agent/candidates/cadence-cold.test.ts`

Find customers where: open balance > 0 AND last payment > 45 days ago AND last contact (max of inbound + outbound email_date) > 21 days ago AND `agent_mode_excluded = FALSE`. Summary: `{customerName, openBalance, daysSincePayment, daysSinceContact}`.

Tests: two cases.

### Task 3d: ops-rma-stalled finder

**Files:**
- Create: `src/modules/ai-agent/candidates/ops-rma-stalled.ts`
- Create: `src/modules/ai-agent/candidates/ops-rma-stalled.test.ts`

Find RMAs where status ∈ `{draft, approved, awaiting_warehouse_number, sent_to_warehouse, received}` AND time-in-current-state > 14 days. Time-in-current-state derived from the timestamp columns: `sentToWarehouseAt` for `sent_to_warehouse`, `receivedAtWarehouseAt` for `received`, `updatedAt` for the rest (best-available approximation). Filter out RMAs whose customer is `agent_mode_excluded`.

Summary: `{rmaNumber, customerName, status, daysInState}`.

Tests: two cases.

### Task 3e: ops-cron-fail finder

**Files:**
- Create: `src/modules/ai-agent/candidates/ops-cron-fail.ts`
- Create: `src/modules/ai-agent/candidates/ops-cron-fail.test.ts`

Read `sync_runs`. For each distinct `kind`, look at the last 3 rows ordered by `startedAt DESC`. If the most recent 2 both have `status = 'failed'` AND the 3rd is `'ok'` (or there's no 3rd, meaning first-ever runs failed) — emit a candidate.

`entityType = "cron_job"`, `entityId = kind`. Summary: `{jobKind, lastFailureAt, lastErrorExcerpt}`.

Tests: two cases (two consecutive failures → emitted; one failure + one ok → not emitted).

---

## Task 4: Scanner orchestrator + cron + manual trigger

**Files:**
- Create: `src/modules/ai-agent/scanner.ts`
- Create: `src/jobs/definitions/autopilot-scan.ts`
- Modify: `src/jobs/queues.ts` (declare `autopilotScan` + `autopilotExecute` queues)
- Modify: `src/jobs/worker.ts` (register handlers — defer execute handler to Task 7)
- Modify: `src/jobs/schedule.ts` (register cron `0 */4 * * *` Europe/London)

- [ ] **Step 1: Scanner orchestrator**

`src/modules/ai-agent/scanner.ts`:

```ts
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  AI_PROPOSAL_CATEGORIES,
  aiProposals,
  type AiProposalCategory,
} from "../../db/schema/ai-proposals.js";
import { aiScans } from "../../db/schema/ai-scans.js";
import { notifications } from "../../db/schema/notifications.js";
import { findCandidates as chaseNext } from "./candidates/chase-next.js";
import { findCandidates as cadenceStatement } from "./candidates/cadence-statement.js";
import { findCandidates as cadenceCold } from "./candidates/cadence-cold.js";
import { findCandidates as opsRmaStalled } from "./candidates/ops-rma-stalled.js";
import { findCandidates as opsCronFail } from "./candidates/ops-cron-fail.js";

const FINDERS: Record<AiProposalCategory, () => Promise<unknown[]>> = {
  chase_next: chaseNext,
  cadence_statement: cadenceStatement,
  cadence_cold: cadenceCold,
  ops_rma_stalled: opsRmaStalled,
  ops_cron_fail: opsCronFail,
};

const PROPOSAL_TTL_DAYS = 7;
const REJECT_THROTTLE_HOURS = 48;

export async function runScan(
  trigger: "cron" | "manual",
  userId?: string,
): Promise<{ scanId: string; proposalsGenerated: number }> {
  const scanId = nanoid(24);
  await db.insert(aiScans).values({
    id: scanId,
    trigger,
    triggeredByUserId: userId ?? null,
  });

  let totalCandidates = 0;
  let proposalsGenerated = 0;

  for (const category of AI_PROPOSAL_CATEGORIES) {
    const candidates = await FINDERS[category]();
    totalCandidates += candidates.length;
    if (candidates.length === 0) continue;

    // Dedup against existing pending / drafted / snoozed / recently-rejected.
    const entityIds = candidates.map(
      (c) => (c as { entityId: string }).entityId,
    );
    const blocked = await db
      .select({ entityId: aiProposals.entityId })
      .from(aiProposals)
      .where(
        and(
          inArray(aiProposals.entityId, entityIds),
          or(
            inArray(aiProposals.status, ["pending", "drafting", "drafted"]),
            and(
              eq(aiProposals.status, "snoozed"),
              sql`${aiProposals.snoozedUntil} > NOW()`,
            ),
            and(
              eq(aiProposals.status, "rejected"),
              sql`${aiProposals.createdAt} > NOW() - INTERVAL ${REJECT_THROTTLE_HOURS} HOUR`,
            ),
          ),
        ),
      );
    const blockedIds = new Set(blocked.map((b) => b.entityId));

    const fresh = candidates.filter(
      (c) => !blockedIds.has((c as { entityId: string }).entityId),
    );

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PROPOSAL_TTL_DAYS * 86400 * 1000,
    );

    for (const c of fresh) {
      const cast = c as {
        entityType: string;
        entityId: string;
        summary: Record<string, unknown>;
      };
      const proposalId = nanoid(24);
      await db.insert(aiProposals).values({
        id: proposalId,
        category,
        entityType: cast.entityType,
        entityId: cast.entityId,
        status: "pending",
        candidateSummary: cast.summary,
        scanId,
        expiresAt,
      });
      // Mirror to notifications (one per team member? for now, just userId
      // of the scan trigger or skip if cron). Cron-triggered scans skip
      // notification mirroring; the dedicated /autopilot page surfaces them.
      if (userId) {
        await db.insert(notifications).values({
          id: nanoid(24),
          userId,
          kind: "ai_proposal",
          refType: "ai_proposal",
          refId: proposalId,
        } as never);
      }
      proposalsGenerated++;
    }
  }

  await db
    .update(aiScans)
    .set({
      finishedAt: sql`CURRENT_TIMESTAMP`,
      totalCandidates,
      proposalsGenerated,
    })
    .where(eq(aiScans.id, scanId));

  return { scanId, proposalsGenerated };
}
```

- [ ] **Step 2: BullMQ handler**

`src/jobs/definitions/autopilot-scan.ts`:

```ts
import type { Job } from "bullmq";
import { createLogger } from "../../lib/logger.js";
import { runScan } from "../../modules/ai-agent/scanner.js";

const log = createLogger({ component: "jobs.autopilot-scan" });

export type AutopilotScanJobData = { trigger: "cron" | "manual" };

export async function autopilotScanHandler(
  job: Job<AutopilotScanJobData>,
): Promise<{ scanId: string; proposalsGenerated: number }> {
  log.info({ jobId: job.id, trigger: job.data.trigger }, "autopilot scan starting");
  const result = await runScan(job.data.trigger);
  log.info({ ...result }, "autopilot scan complete");
  return result;
}
```

- [ ] **Step 3: Wire queue + worker + schedule**

In `src/jobs/queues.ts`, add:
```ts
export const AUTOPILOT_SCAN_QUEUE = "autopilot-scan";
export const AUTOPILOT_EXECUTE_QUEUE = "autopilot-execute";
export const AUTOPILOT_SCAN_JOB = "autopilot-scan";
export const AUTOPILOT_EXECUTE_JOB = "autopilot-execute";
```
And to the `Queues` type / `createQueues` function, add `autopilotScan` and `autopilotExecute`.

In `src/jobs/worker.ts`, import + register `autopilotScanHandler`.

In `src/jobs/schedule.ts` (mirror the chase-digest registration block):

```ts
await queues.autopilotScan.add(
  AUTOPILOT_SCAN_JOB,
  { trigger: "cron" } as AutopilotScanJobData,
  {
    jobId: `repeat:${AUTOPILOT_SCAN_JOB}`,
    repeat: { pattern: "0 */4 * * *", tz: "Europe/London" },
  },
);
registered.push({ name: AUTOPILOT_SCAN_JOB, cron: "0 */4 * * *", tz: "Europe/London" });
```

Update the comment block at the top of `schedule.ts` to document the new job.

- [ ] **Step 4: Manual trigger route (scaffold)**

In `src/server/routes/autopilot.ts` (create):

```ts
import type { FastifyPluginAsync } from "fastify";
import { getQueues } from "../../jobs/queues.js";
import {
  AUTOPILOT_SCAN_JOB,
  type AutopilotScanJobData,
} from "../../jobs/queues.js";
import { requireAuth } from "../lib/auth.js";

const autopilotRoute: FastifyPluginAsync = async (app) => {
  app.post("/scan", async (req, reply) => {
    await requireAuth(req);
    const queues = getQueues();
    const job = await queues.autopilotScan.add(
      AUTOPILOT_SCAN_JOB,
      { trigger: "manual" } as AutopilotScanJobData,
    );
    return reply.send({ jobId: job.id });
  });
};

export default autopilotRoute;
```

Register in `src/server/routes/index.ts`:
```ts
import autopilotRoute from "./autopilot.js";
// ...
await app.register(autopilotRoute, { prefix: "/api/autopilot" });
```

- [ ] **Step 5: Type-check + commit**

Run: `npm run build` → PASS.

```bash
git add src/modules/ai-agent/scanner.ts src/jobs/ src/server/routes/autopilot.ts src/server/routes/index.ts
git commit -m "Autopilot: scanner + cron + manual trigger route"
```

---

## Task 5: 5 prompt templates — **TEAM WAVE**

Five file-disjoint prompt templates under `src/modules/ai-agent/prompts/`. Dispatch as a team of 5.

Each file exports:
```ts
export function buildPrompt(summary: Record<string, unknown>): string;
export const TOOL_NAME: string; // which tool the AI should call
```

Each prompt must:
- Include the customer/entity context from `summary`
- Be specific about tone and intent
- Instruct AI to return EITHER a tool_use call OR text `{"skip": true, "reason": "..."}` if context indicates the action shouldn't happen
- Stay <500 tokens of instructions (the context is what bloats; instructions should be tight)

### Task 5a: chase-next prompt

**File:** `src/modules/ai-agent/prompts/chase-next.ts`

Prompt drafts a chase email for the customer's current severity tier. Tone scales: MEDIUM = friendly reminder; HIGH = firmer; CRITICAL = formal escalation. Email body should reference open balance, days overdue, and end with a clear call to action. AI returns `send_chase_email` tool call.

### Task 5b: cadence-statement prompt

**File:** `src/modules/ai-agent/prompts/cadence-statement.ts`

Decides whether to actually propose sending a statement (sometimes a customer with $50 open isn't worth a statement). If yes, optionally drafts a 1-sentence cover note ("Hi {name}, attached is your current statement of open invoices."). AI returns `send_statement` tool call with optional `coverNote`.

### Task 5c: cadence-cold prompt

**File:** `src/modules/ai-agent/prompts/cadence-cold.ts`

Drafts a warm, low-pressure check-in email. Acknowledges silence without being passive-aggressive. Asks if there's anything they need or any reason for the gap. AI returns `send_check_in_email` tool call.

### Task 5d: ops-rma-stalled prompt

**File:** `src/modules/ai-agent/prompts/ops-rma-stalled.ts`

Decides between two tools based on RMA status:
- For `sent_to_warehouse` and `awaiting_warehouse_number`: drafts a warehouse nudge email (factual, brief, includes RMA number + customer + days stuck) → returns `nudge_warehouse_email`
- For `draft`, `approved`, `received`: drafts an admin notification → returns `create_admin_notification` with title like "RMA-91 needs attention"

### Task 5e: ops-cron-fail prompt

**File:** `src/modules/ai-agent/prompts/ops-cron-fail.ts`

Drafts a concise admin notification about the job failure. Title = "[Cron] {jobKind} failed twice"; message includes last error excerpt. Returns `create_admin_notification`.

---

## Task 6: Draft endpoint + Anthropic integration + cost tracking

**Files:**
- Modify: `src/server/routes/autopilot.ts` (add /proposals/draft endpoint)
- Create: `src/modules/ai-agent/anthropic-client.ts` (wraps the SDK call + cost calc)

- [ ] **Step 1: Anthropic client wrapper**

```ts
// src/modules/ai-agent/anthropic-client.ts
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { aiInteractions } from "../../db/schema/audit.js";
import { env } from "../../lib/env.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-4-6";
// Pricing per 1k tokens, in cents — verify against current Anthropic
// pricing page before launch.
const INPUT_PRICE_CENTS_PER_1K = 0.3;
const OUTPUT_PRICE_CENTS_PER_1K = 1.5;

export async function callAnthropic(args: {
  proposalId: string;
  userId: string;
  prompt: string;
  toolName: string;
  toolSchema: Record<string, unknown>;
}): Promise<{
  toolCall?: { name: string; args: Record<string, unknown> };
  skip?: { reason: string };
  costCents: number;
}> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    tools: [
      {
        name: args.toolName,
        description: `Execute ${args.toolName}`,
        input_schema: args.toolSchema as never,
      },
    ],
    messages: [{ role: "user", content: args.prompt }],
  });

  const inputCents =
    (response.usage.input_tokens / 1000) * INPUT_PRICE_CENTS_PER_1K;
  const outputCents =
    (response.usage.output_tokens / 1000) * OUTPUT_PRICE_CENTS_PER_1K;
  const costCents = Math.round(inputCents + outputCents);

  await db.insert(aiInteractions).values({
    id: nanoid(24),
    userId: args.userId,
    surface: "autopilot_draft",
    model: MODEL,
    toolsCalled: [],
  } as never);

  // Extract tool call or skip text
  for (const block of response.content) {
    if (block.type === "tool_use") {
      return {
        toolCall: { name: block.name, args: block.input as Record<string, unknown> },
        costCents,
      };
    }
    if (block.type === "text" && block.text.includes('"skip"')) {
      try {
        const parsed = JSON.parse(block.text);
        if (parsed.skip) return { skip: { reason: parsed.reason ?? "" }, costCents };
      } catch {
        // fall through
      }
    }
  }
  return { skip: { reason: "AI returned no tool call" }, costCents };
}
```

- [ ] **Step 2: Draft endpoint**

In `src/server/routes/autopilot.ts`:

```ts
import { z } from "zod";
import { inArray, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";
import { callAnthropic } from "../../modules/ai-agent/anthropic-client.js";
import { buildPrompt as chaseNextPrompt, TOOL_NAME as chaseNextTool } from "../../modules/ai-agent/prompts/chase-next.js";
// ...repeat imports for other 4 prompts

const PROMPTS: Record<string, { build: (s: Record<string, unknown>) => string; toolName: string }> = {
  chase_next: { build: chaseNextPrompt, toolName: chaseNextTool },
  cadence_statement: { build: /* ... */, toolName: /* ... */ },
  cadence_cold: { build: /* ... */, toolName: /* ... */ },
  ops_rma_stalled: { build: /* ... */, toolName: /* ... */ },
  ops_cron_fail: { build: /* ... */, toolName: /* ... */ },
};

app.post("/proposals/draft", async (req, reply) => {
  const user = await requireAuth(req);
  const schema = z.object({ proposalIds: z.array(z.string().min(1).max(24)).min(1).max(50) });
  const parse = schema.safeParse(req.body);
  if (!parse.success) return reply.code(400).send({ error: "invalid body" });

  const proposals = await db
    .select()
    .from(aiProposals)
    .where(inArray(aiProposals.id, parse.data.proposalIds));

  const CONCURRENCY = 4;
  const results: Array<{ proposalId: string; status: string }> = [];
  for (let i = 0; i < proposals.length; i += CONCURRENCY) {
    const batch = proposals.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (p) => {
        if (p.status !== "pending") {
          results.push({ proposalId: p.id, status: "skipped (not pending)" });
          return;
        }
        await db.update(aiProposals).set({ status: "drafting" }).where(eq(aiProposals.id, p.id));
        const prompt = PROMPTS[p.category];
        if (!prompt) {
          await db.update(aiProposals).set({ status: "pending" }).where(eq(aiProposals.id, p.id));
          results.push({ proposalId: p.id, status: "no prompt for category" });
          return;
        }
        try {
          const ai = await callAnthropic({
            proposalId: p.id,
            userId: user.id,
            prompt: prompt.build(p.candidateSummary),
            toolName: prompt.toolName,
            toolSchema: {}, // populate from tools.ts in real impl
          });
          if (ai.toolCall) {
            const preview = JSON.stringify(ai.toolCall.args).slice(0, 2000);
            await db.update(aiProposals).set({
              status: "drafted",
              draftedAction: { tool: ai.toolCall.name, args: ai.toolCall.args },
              draftedPreview: preview,
              draftedAt: sql`CURRENT_TIMESTAMP`,
            }).where(eq(aiProposals.id, p.id));
            results.push({ proposalId: p.id, status: "drafted" });
          } else {
            await db.update(aiProposals).set({
              status: "dismissed",
              decidedAt: sql`CURRENT_TIMESTAMP`,
              decidedByUserId: user.id,
              reasoning: ai.skip?.reason ?? "AI skip",
            }).where(eq(aiProposals.id, p.id));
            results.push({ proposalId: p.id, status: "skipped by AI" });
          }
        } catch (err) {
          await db.update(aiProposals).set({ status: "pending" }).where(eq(aiProposals.id, p.id));
          results.push({ proposalId: p.id, status: `error: ${err instanceof Error ? err.message : String(err)}` });
        }
      }),
    );
  }
  return reply.send({ results });
});
```

- [ ] **Step 3: Type-check + commit**

```bash
git add src/modules/ai-agent/anthropic-client.ts src/server/routes/autopilot.ts
git commit -m "Autopilot: draft endpoint + Anthropic integration + cost tracking"
```

---

## Task 7: Approval worker + remaining routes

**Files:**
- Create: `src/jobs/definitions/autopilot-execute.ts`
- Modify: `src/jobs/worker.ts` (register execute handler)
- Modify: `src/server/routes/autopilot.ts` (add approve, dismiss, snooze, get endpoints)

- [ ] **Step 1: Execute worker**

```ts
// src/jobs/definitions/autopilot-execute.ts
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";
import { getToolByName } from "../../modules/ai-agent/tools.js";
import {
  markProposalExecuted,
  markProposalExecutionFailed,
} from "../../modules/ai-agent/proposal-store.js";

export type AutopilotExecuteJobData = {
  proposalId: string;
  userId: string;
};

export async function autopilotExecuteHandler(
  job: Job<AutopilotExecuteJobData>,
): Promise<{ ok: boolean }> {
  const { proposalId, userId } = job.data;
  const rows = await db
    .select()
    .from(aiProposals)
    .where(eq(aiProposals.id, proposalId))
    .limit(1);
  const proposal = rows[0];
  if (!proposal || !proposal.draftedAction) {
    await markProposalExecutionFailed(proposalId, "proposal not found or no drafted_action");
    return { ok: false };
  }
  const action = proposal.draftedAction as { tool: string; args: Record<string, unknown> };
  const tool = getToolByName(action.tool);
  if (!tool) {
    await markProposalExecutionFailed(proposalId, `tool ${action.tool} not in registry`);
    return { ok: false };
  }
  const parse = tool.argsSchema.safeParse(action.args);
  if (!parse.success) {
    await markProposalExecutionFailed(proposalId, `args validation failed: ${JSON.stringify(parse.error.flatten())}`);
    return { ok: false };
  }
  const result = await tool.execute(parse.data as never, { userId, proposalId });
  if (result.ok) {
    await markProposalExecuted(proposalId);
    return { ok: true };
  } else {
    await markProposalExecutionFailed(proposalId, result.error);
    return { ok: false };
  }
}
```

- [ ] **Step 2: Register execute handler in `src/jobs/worker.ts`** (mirror the chase-digest registration; one-liner import + register).

- [ ] **Step 3: Approve / dismiss / snooze / get endpoints in `src/server/routes/autopilot.ts`**

```ts
// POST /proposals/:id/approve
app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
  "/proposals/:id/approve",
  async (req, reply) => {
    const user = await requireAuth(req);
    const proposalId = req.params.id;
    const force = req.query.force === "true";

    const rows = await db.select().from(aiProposals).where(eq(aiProposals.id, proposalId)).limit(1);
    const p = rows[0];
    if (!p) return reply.code(404).send({ error: "not found" });
    if (p.status !== "drafted" && p.status !== "pending") {
      return reply.code(409).send({ error: `cannot approve from status ${p.status}` });
    }

    // Stale-draft guard: re-run eligibility for this entity.
    if (!force && p.status === "drafted") {
      const { isStillEligible } = await import(`../../modules/ai-agent/candidates/${p.category.replace("_", "-")}.js`);
      const eligible = await isStillEligible(p.entityId);
      if (!eligible) {
        return reply.code(409).send({ stale: true, reason: "conditions changed since drafted" });
      }
    }

    await db.update(aiProposals).set({
      status: "approved",
      decidedAt: sql`CURRENT_TIMESTAMP`,
      decidedByUserId: user.id,
    }).where(eq(aiProposals.id, proposalId));

    const queues = getQueues();
    await queues.autopilotExecute.add(AUTOPILOT_EXECUTE_JOB, {
      proposalId,
      userId: user.id,
    } as AutopilotExecuteJobData);

    return reply.send({ ok: true });
  },
);

// POST /proposals/:id/dismiss
app.post<{ Params: { id: string } }>("/proposals/:id/dismiss", async (req, reply) => {
  const user = await requireAuth(req);
  await db.update(aiProposals).set({
    status: "dismissed",
    decidedAt: sql`CURRENT_TIMESTAMP`,
    decidedByUserId: user.id,
  }).where(eq(aiProposals.id, req.params.id));
  return reply.send({ ok: true });
});

// POST /proposals/:id/snooze  { hours: number }
app.post<{ Params: { id: string } }>("/proposals/:id/snooze", async (req, reply) => {
  const user = await requireAuth(req);
  const schema = z.object({ hours: z.number().int().min(1).max(24 * 90) });
  const parse = schema.safeParse(req.body);
  if (!parse.success) return reply.code(400).send({ error: "invalid body" });
  await db.update(aiProposals).set({
    status: "snoozed",
    decidedAt: sql`CURRENT_TIMESTAMP`,
    decidedByUserId: user.id,
    snoozedUntil: sql`NOW() + INTERVAL ${parse.data.hours} HOUR`,
  }).where(eq(aiProposals.id, req.params.id));
  return reply.send({ ok: true });
});

// GET /proposals  (with filters)
app.get("/proposals", async (req, reply) => {
  await requireAuth(req);
  // ?status=pending,drafted&category=chase_next
  // For brevity: default returns all status NOT IN (executed, expired) and
  // (status != snoozed OR snoozed_until <= NOW()), ordered by created_at desc, limit 500.
  // Full filter parsing left to implementation.
  const rows = await db
    .select()
    .from(aiProposals)
    .where(
      and(
        sql`${aiProposals.status} NOT IN ('executed', 'expired', 'superseded')`,
        or(
          sql`${aiProposals.status} != 'snoozed'`,
          sql`${aiProposals.snoozedUntil} <= NOW()`,
        ),
      ),
    )
    .orderBy(sql`${aiProposals.createdAt} DESC`)
    .limit(500);
  return reply.send({ rows });
});

// GET /proposals/:id
app.get<{ Params: { id: string } }>("/proposals/:id", async (req, reply) => {
  await requireAuth(req);
  const rows = await db
    .select()
    .from(aiProposals)
    .where(eq(aiProposals.id, req.params.id))
    .limit(1);
  if (!rows[0]) return reply.code(404).send({ error: "not found" });
  return reply.send({ proposal: rows[0] });
});
```

- [ ] **Step 4: Type-check + commit**

```bash
git add src/jobs/definitions/autopilot-execute.ts src/jobs/worker.ts src/server/routes/autopilot.ts
git commit -m "Autopilot: execute worker + approve/dismiss/snooze/get endpoints"
```

---

## Task 8: `/autopilot` page

**Files:**
- Create: `src/web/pages/autopilot.tsx`
- Create: `src/web/components/autopilot/proposal-card.tsx`
- Modify: web router config (register new route — find by grep `createRoute` in `src/web/`)

- [ ] **Step 1: Build the page**

Reference shape:

```tsx
// src/web/pages/autopilot.tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { ProposalCard } from "../components/autopilot/proposal-card";

type Proposal = {
  id: string;
  category: string;
  entityType: string;
  entityId: string;
  status: string;
  candidateSummary: Record<string, unknown>;
  draftedPreview: string | null;
  draftedAction: { tool: string; args: Record<string, unknown> } | null;
  reasoning: string | null;
  snoozedUntil: string | null;
  createdAt: string;
};

export default function AutopilotPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isPending } = useQuery<{ rows: Proposal[] }>({
    queryKey: ["autopilot", "proposals"],
    queryFn: async () => {
      const res = await fetch("/api/autopilot/proposals");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/autopilot/scan", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["autopilot"] }),
  });

  const draftMutation = useMutation({
    mutationFn: async (proposalIds: string[]) => {
      const res = await fetch("/api/autopilot/proposals/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalIds }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autopilot"] });
      setSelected(new Set());
    },
  });

  const rows = data?.rows ?? [];

  // Group customer-typed proposals by entityId; non-customer kept separate
  const byCustomer = new Map<string, Proposal[]>();
  const nonCustomer: Proposal[] = [];
  for (const p of rows) {
    if (p.entityType === "customer") {
      const list = byCustomer.get(p.entityId) ?? [];
      list.push(p);
      byCustomer.set(p.entityId, list);
    } else {
      nonCustomer.push(p);
    }
  }

  const pendingCount = rows.filter((r) => r.status === "pending").length;
  const draftedCount = rows.filter((r) => r.status === "drafted").length;

  // Bulk-draft cost preview (rough estimate: 5¢ per draft)
  const draftCost = (selected.size * 5) / 100;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Autopilot</h1>
          <p className="text-sm text-secondary">
            {pendingCount} pending · {draftedCount} drafted
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => scanMutation.mutate()}
          loading={scanMutation.isPending}
        >
          Run autopilot now
        </Button>
      </div>

      {selected.size > 0 && (
        <Card>
          <CardBody className="flex items-center justify-between gap-2">
            <span className="text-sm">{selected.size} selected</span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => draftMutation.mutate(Array.from(selected))}
                loading={draftMutation.isPending}
              >
                Draft for selected (~${draftCost.toFixed(2)})
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {isPending ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted">No pending proposals.</div>
      ) : (
        <>
          {Array.from(byCustomer.entries()).map(([custId, props]) => (
            <Card key={custId}>
              <CardHeader>
                <h2 className="text-sm font-medium">
                  {(props[0]!.candidateSummary as { customerName?: string }).customerName ?? custId}
                  <span className="text-xs text-muted ml-2">
                    {props.map((p) => p.category.replace(/_/g, " ")).join(" · ")}
                  </span>
                </h2>
              </CardHeader>
              <CardBody className="space-y-2">
                {props.map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    selected={selected.has(p.id)}
                    onSelect={(yes) => {
                      const next = new Set(selected);
                      yes ? next.add(p.id) : next.delete(p.id);
                      setSelected(next);
                    }}
                  />
                ))}
              </CardBody>
            </Card>
          ))}
          {nonCustomer.length > 0 && (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-medium">Operational</h2>
              </CardHeader>
              <CardBody className="space-y-2">
                {nonCustomer.map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    selected={selected.has(p.id)}
                    onSelect={(yes) => {
                      const next = new Set(selected);
                      yes ? next.add(p.id) : next.delete(p.id);
                      setSelected(next);
                    }}
                  />
                ))}
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build `ProposalCard` component**

`src/web/components/autopilot/proposal-card.tsx`. Renders a single proposal row with:
- Checkbox (when status='pending' and category needs drafting)
- Category label
- Summary line from `candidateSummary`
- If `drafted`: shows `draftedPreview` (truncated) + [Edit] [Approve & Send] [Reject]
- If `pending` for deterministic categories (statement, cron-fail): [Approve & Execute] [Dismiss] [Snooze]
- Reject opens a small dropdown: [Dismiss now] [Snooze 1d/3d/1wk/1mo]

Use existing Dialog primitives for snooze dropdown.

- [ ] **Step 3: Register route**

Find the TanStack Router route tree (probably `src/web/routes.ts` or similar; grep `createRoute`). Add `/autopilot` pointing at `AutopilotPage`.

- [ ] **Step 4: Type-check + commit**

```bash
git add src/web/pages/autopilot.tsx src/web/components/autopilot/proposal-card.tsx
git commit -m "Autopilot: /autopilot page with grouping + bulk draft"
```

---

## Task 9: AI badge + Customer agent-toggle + Settings panel — **TEAM WAVE**

Three file-disjoint UI additions.

### Task 9a: AI provenance badge + popover

**Files:**
- Create: `src/web/components/autopilot/ai-proposal-badge.tsx`

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

type Props = { proposalId: string };

export function AiProposalBadge({ proposalId }: Props) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<{ proposal: {
    id: string;
    category: string;
    draftedPreview: string | null;
    reasoning: string | null;
    decidedAt: string | null;
    decidedByUserId: string | null;
    candidateSummary: Record<string, unknown>;
  } }>({
    queryKey: ["autopilot", "proposal", proposalId],
    queryFn: async () => {
      const res = await fetch(`/api/autopilot/proposals/${encodeURIComponent(proposalId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center rounded bg-accent-info/15 px-1 py-0.5 text-[10px] font-semibold text-accent-info hover:bg-accent-info/25"
        title="Originated from an AI proposal"
      >
        AI
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI proposal</DialogTitle>
          </DialogHeader>
          {!data ? (
            <div className="text-xs text-muted">Loading…</div>
          ) : (
            <div className="space-y-3 text-sm">
              <div><span className="text-muted">Category:</span> {data.proposal.category}</div>
              <div><span className="text-muted">Decided:</span> {data.proposal.decidedAt ?? "—"}</div>
              {data.proposal.reasoning && (
                <div><span className="text-muted">Reasoning:</span> {data.proposal.reasoning}</div>
              )}
              {data.proposal.draftedPreview && (
                <div>
                  <div className="text-muted mb-1">Draft as approved:</div>
                  <pre className="text-xs whitespace-pre-wrap bg-subtle p-2 rounded">
                    {data.proposal.draftedPreview}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
```

Then wire `<AiProposalBadge proposalId={row.aiProposalId} />` into:
- `src/web/pages/customer-detail.tsx` — activity timeline rows + emails-tab rows that have `aiProposalId`
- Chase log page (find by grep), statement sends page

This may require touching multiple files; the teammate scopes those reads + edits.

### Task 9b: Customer detail "Agent mode" toggle

**Files:**
- Modify: `src/web/pages/customer-detail.tsx` (add toggle near HoldBanner)
- Modify: `src/server/routes/customers.ts` (extend PATCH to accept `agentModeExcluded`)

Add a small toggle button next to the existing HoldBanner area:

```tsx
<button
  type="button"
  onClick={() => agentModeMutation.mutate(!customer.agentModeExcluded)}
  className="text-xs hover:underline"
>
  Agent mode: {customer.agentModeExcluded ? "OFF" : "ON"} (click to flip)
</button>
```

Mutation calls `PATCH /api/customers/:id` with `{ agentModeExcluded: bool }`. Add the field to the existing PATCH route's Zod schema.

### Task 9c: Settings panel — Autopilot section

**Files:**
- Modify: `src/web/pages/settings.tsx` — add new section "Autopilot" with:
  - Enabled toggle
  - Daily soft budget input (cents, default 2000)
  - Per-category enable toggles (5)
  - Read-only: last scan time, last 24h proposal counts, rolling 30d cost

The category-toggle persistence needs a small new endpoint or app-settings row — for v0, store as JSON in the existing `app_settings` table (one row `key='autopilot_config'`).

---

## Task 10: Chase widget + RMAs widget badges — **TEAM WAVE**

Two file-disjoint widget edits.

### Task 10a: Chase widget AI suggestions

**File:** `src/web/components/dashboard/chase-widget.tsx`

Query `/api/autopilot/proposals?category=chase_next,cadence_cold&status=pending,drafted` separately or filter in JS from the existing autopilot query. If count > 0, add to widget header: `Chase queue (10) · N AI suggestions`. Click "N AI suggestions" expands a section above the manual chase list showing each as a compact proposal card with [Draft] [Dismiss] inline buttons.

### Task 10b: RMAs widget AI suggestions

**File:** `src/web/components/dashboard/rmas-widget.tsx`

Same pattern, filtered to category=ops_rma_stalled. Inline expansion with [Approve] [Dismiss] (RMA actions usually don't need AI drafting; show drafted_action.preview if present).

---

## Task 11: Full smoke + push

- [ ] **Step 1: `npx vitest run`** — all pass (sans the pre-existing 2 unrelated qb-sync.regression failures).

- [ ] **Step 2: `npm run build`** — PASS.

- [ ] **Step 3: Manual smoke checklist**

In `npm run dev`:

- [ ] Visit `/autopilot`. Header shows "0 pending". Click "Run autopilot now". Within ~5s, see candidates populate (assuming any rules match prod-like local data).
- [ ] Select 2 chase-next candidates → "Draft for selected (~$0.10)" → AI drafts → both move to `drafted` status with body preview.
- [ ] Open one drafted proposal → click "Approve & Send" → email lands; check `email_log.ai_proposal_id` is set on the new row.
- [ ] Find that same email row in customer activity timeline → "AI" badge appears → click badge → popover shows category/reasoning/draft preview/decided-by.
- [ ] On a customer detail page, click "Agent mode: ON" toggle → flips to OFF → trigger manual scan → verify that customer no longer appears in any category.
- [ ] Dismiss a candidate → reload `/autopilot` → it's gone. Trigger another scan → it reappears (if rule still matches).
- [ ] Snooze a candidate for 1 day → reload → gone. Verify `ai_proposals.snoozed_until` is set ~24h ahead.
- [ ] Trigger an Anthropic-API failure (block network) and click Draft → proposal stays `pending`, errors logged.
- [ ] On dashboard, Chase widget shows "N AI suggestions" header chip if any chase_next/cadence_cold proposals exist; click expands.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/autopilot-v0
```

- [ ] **Step 5: PR or merge per finance-hub workflow**

Open PR with the standard summary or merge direct to main per the pattern used for dashboard.

---

## Known follow-ups (deferred from v0)

- **Hold-lift cadence rule** (customer on hold + paid down to 0 overdue) — not selected in v0 brainstorm; add `lift_hold` tool when this rule lands.
- **Event-driven scans for inbox triage** when that category is revisited.
- **Per-category configurable thresholds** in Settings (currently hard-coded constants in the candidate finders).
- **Tightened tool args TypeScript** — remove the `as never` / `as unknown as` casts in `tools.ts` with a typed registry pattern.
- **Per-user proposal queues** if team grows past 5.
- **Edit-rate dashboard** for draft quality signal.
- **Inline AI suggestions on widgets beyond Chase + RMAs** when categories with no current widget mapping (statement-gap, cron-fail) deserve dedicated surfaces.
