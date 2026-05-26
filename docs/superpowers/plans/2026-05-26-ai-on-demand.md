# AI on-demand — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot autopilot from cron-driven proactive proposer to pull-based assistant: cron defaults off, customer pages get an AI summary + action plan card, individual emails get a "Draft reply with AI" button.

**Architecture:** One engine (existing autopilot candidate finders + draft pipeline), three surfaces (existing /autopilot queue + new customer card + new per-email draft). Shared substrate via `src/modules/ai-agent/voice.ts` (already does voice + facts + corrections + customer ctx). New module per surface for orchestration.

**Tech Stack:** Fastify v5, TypeScript strict, Drizzle ORM (MySQL 8), TanStack Query, React 18, Anthropic SDK 0.30.0 (Sonnet 4.6), BullMQ, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-26-ai-on-demand-design.md`

**Progress tracker:** `docs/superpowers/plans/2026-05-26-ai-on-demand-progress.md` (created at execution start).

---

## File layout

**Create:**
- `migrations/0039_<slug>.sql` (drizzle-kit generated)
- `src/db/schema/customer-ai-cards.ts`
- `src/modules/ai-agent/customer-card.ts` + `.test.ts`
- `src/modules/ai-agent/draft-reply.ts` + `.test.ts`
- `src/server/routes/customer-ai-card.ts`
- `src/web/components/customer-ai-card.tsx`

**Modify:**
- `src/db/schema/app-settings.ts` — add `autopilot_scan_cron_enabled` key.
- `src/jobs/definitions/autopilot-scan.ts` — gate handler with the new flag.
- `src/db/schema/crm.ts` — add `email_log.draft_ai_notes` column.
- `src/db/schema/index.ts` — re-export new `customer-ai-cards` schema.
- `src/modules/ai-agent/candidates/chase-next.ts` (and 4 siblings) — accept optional `customerId`.
- `src/server/server.ts` — register new route.
- `src/server/routes/email-log.ts` — add `POST /:id/draft-reply`.
- `src/web/pages/customer-detail.tsx` — render `<CustomerAiCard />`.
- `src/web/pages/ai-training.tsx` — add cron toggle row.
- `src/web/components/email-list.tsx` — add "Draft reply" button on inbound rows.
- `src/web/components/dashboard/emails-widget.tsx` — same button.
- `src/web/components/compose-modal.tsx` — add "AI" panel (notes textarea + Generate button).

---

## Task 1 — Cron default off (gated handler)

**Files:**
- Modify: `src/db/schema/app-settings.ts`
- Modify: `src/jobs/definitions/autopilot-scan.ts`
- Create: `src/jobs/definitions/autopilot-scan.test.ts`

- [ ] **Step 1: Add the key to APP_SETTING_KEYS**

In `src/db/schema/app-settings.ts`, append to the array:

```ts
  // "true"/"" flag — enables the autopilot scan cron (default off). Manual
  // "Run autopilot now" triggers bypass this gate (they pass trigger="manual").
  "autopilot_scan_cron_enabled",
```

Update the comment block at top of the array if useful.

Also update `src/modules/statements/settings.ts` `AppSettingsMap` + `DEFAULTS` to mirror the new key (gotcha noted in [[autopilot-voice-tone]] memory). Also update the two fixtures in `src/modules/statements/pdf.test.ts`.

- [ ] **Step 2: Write the failing test for the gated handler**

Create `src/jobs/definitions/autopilot-scan.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, runScanSpy } = vi.hoisted(() => {
  const selectChain = {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([] as Array<{ value: string }>),
      }),
    }),
  };
  return {
    runScanSpy: vi.fn(),
    mockDb: { select: vi.fn(() => selectChain) },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../modules/ai-agent/scanner.js", () => ({ runScan: runScanSpy }));

import { autopilotScanHandler } from "./autopilot-scan.js";

beforeEach(() => {
  runScanSpy.mockReset();
});

describe("autopilotScanHandler", () => {
  it("skips when trigger='cron' and the flag is unset/empty", async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ value: "" }]) }),
      }),
    }));
    const job = { id: "j1", data: { trigger: "cron" as const } } as any;
    const res = await autopilotScanHandler(job);
    expect(res).toEqual({ ran: false, reason: "disabled" } as any);
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it("runs when trigger='manual' regardless of the flag", async () => {
    runScanSpy.mockResolvedValue({
      scanId: "scan-1",
      totalCandidates: 0,
      proposalsGenerated: 0,
    });
    const job = {
      id: "j2",
      data: { trigger: "manual" as const, triggeredByUserId: "u1" },
    } as any;
    const res = await autopilotScanHandler(job);
    expect(runScanSpy).toHaveBeenCalledWith("manual", "u1");
    expect(res.scanId).toBe("scan-1");
  });

  it("runs when trigger='cron' and the flag is 'true'", async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ value: "true" }]) }),
      }),
    }));
    runScanSpy.mockResolvedValue({
      scanId: "scan-2",
      totalCandidates: 1,
      proposalsGenerated: 1,
    });
    const job = { id: "j3", data: { trigger: "cron" as const } } as any;
    const res = await autopilotScanHandler(job);
    expect(runScanSpy).toHaveBeenCalled();
    expect((res as any).scanId).toBe("scan-2");
  });
});
```

- [ ] **Step 3: Run the failing test**

```
npx vitest run src/jobs/definitions/autopilot-scan.test.ts
```

Expected: tests fail (handler doesn't yet read the flag, doesn't return `{ ran: false, reason: "disabled" }`).

- [ ] **Step 4: Gate the handler**

Replace `src/jobs/definitions/autopilot-scan.ts` with:

```ts
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { createLogger } from "../../lib/logger.js";
import { runScan } from "../../modules/ai-agent/scanner.js";

const log = createLogger({ component: "jobs.autopilot-scan" });

export type AutopilotScanJobData = {
  trigger: "cron" | "manual";
  triggeredByUserId?: string;
};

export type AutopilotScanJobResult =
  | {
      scanId: string;
      totalCandidates: number;
      proposalsGenerated: number;
    }
  | { ran: false; reason: string };

export async function autopilotScanHandler(
  job: Job<AutopilotScanJobData>,
): Promise<AutopilotScanJobResult> {
  // Manual triggers bypass the gate — "Run autopilot now" should always run.
  if (job.data.trigger === "cron") {
    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "autopilot_scan_cron_enabled"))
      .limit(1);
    if (rows[0]?.value !== "true") {
      log.info({ jobId: job.id, stage: "skipped" }, "autopilot scan cron disabled");
      return { ran: false, reason: "disabled" };
    }
  }
  log.info(
    { jobId: job.id, trigger: job.data.trigger },
    "autopilot scan starting",
  );
  return await runScan(job.data.trigger, job.data.triggeredByUserId);
}
```

- [ ] **Step 5: Update consumers of `AutopilotScanJobResult`**

Grep for the type. Any consumer that destructures `scanId` etc. needs a narrowing guard for the `{ ran: false }` shape. Likely one site in the worker file.

```
grep -rn "AutopilotScanJobResult\|autopilotScanHandler" src/
```

For each, narrow with `if ("ran" in result && result.ran === false) ...` or check `"scanId" in result`.

- [ ] **Step 6: Run the test until green**

```
npx vitest run src/jobs/definitions/autopilot-scan.test.ts
npx tsc -p tsconfig.json --noEmit
```

Expected: 3/3 pass; typecheck clean.

- [ ] **Step 7: Commit**

```
git add src/db/schema/app-settings.ts src/jobs/definitions/autopilot-scan.ts src/jobs/definitions/autopilot-scan.test.ts src/modules/statements/settings.ts src/modules/statements/pdf.test.ts
git commit -m "feat(autopilot): gate scan cron with autopilot_scan_cron_enabled (default off)"
```

---

## Task 2 — Candidate finder scoping (5 finders accept optional customerId)

**Files:**
- Modify: `src/modules/ai-agent/candidates/chase-next.ts`
- Modify: `src/modules/ai-agent/candidates/cadence-cold.ts`
- Modify: `src/modules/ai-agent/candidates/cadence-statement.ts`
- Modify: `src/modules/ai-agent/candidates/ops-rma-stalled.ts`
- Modify: `src/modules/ai-agent/candidates/ops-cron-fail.ts`
- Modify: existing test files for each finder (add scoped cases).

- [ ] **Step 1: Read each finder and identify the WHERE clause**

```
cat src/modules/ai-agent/candidates/chase-next.ts
```

The signature is currently `export async function findCandidates(): Promise<Candidate[]>`. Add an optional `customerId?: string` param; when set, AND `eq(customers.id, customerId)` (or whatever the customer column on the joined table is — varies per finder).

- [ ] **Step 2: Add the failing test for chase-next scoping**

In `src/modules/ai-agent/candidates/chase-next.test.ts`, add a new case (mock setup as elsewhere in the file):

```ts
it("when customerId is passed, the SELECT WHERE includes a customer-id eq filter", async () => {
  // (capture the where SQL fragment from the mock, assert customerId substring present)
  await findCandidates("cust_test_123");
  // assert via the mock's captured query
});
```

Mirror the same shape in the four other finder test files.

- [ ] **Step 3: Run the failing tests**

```
npx vitest run src/modules/ai-agent/candidates/
```

Expected: 5 failures (one per finder).

- [ ] **Step 4: Implement scoping in each finder**

Pattern (chase-next.ts):

```ts
export async function findCandidates(
  customerId?: string,
): Promise<Candidate[]> {
  // 1. All overdue, non-excluded customers.
  const baseWhere = and(
    /* existing predicates */,
    customerId ? eq(customers.id, customerId) : undefined,
  );
  const overdueRows = await db
    .select()
    .from(customers)
    .where(baseWhere);
  // ... rest unchanged
}
```

Apply equivalent change to the other 4 finders. The customer-id column lives on the primary table joined in each finder — verify per file.

- [ ] **Step 5: Update scanner.ts to pass nothing (preserves global behaviour)**

`src/modules/ai-agent/scanner.ts` already calls `findCandidates()` with no args — that path still works due to the default. Confirm no other behaviour change is needed.

- [ ] **Step 6: Run tests until green + typecheck**

```
npx vitest run src/modules/ai-agent/candidates/
npx tsc -p tsconfig.json --noEmit
```

Expected: all green.

- [ ] **Step 7: Commit**

```
git add src/modules/ai-agent/candidates/
git commit -m "refactor(ai-agent): candidate finders accept optional customerId scope"
```

---

## Task 3 — Migration: customer_ai_cards table + email_log.draft_ai_notes column

**Files:**
- Create: `src/db/schema/customer-ai-cards.ts`
- Modify: `src/db/schema/crm.ts` (add `draftAiNotes` column to emailLog)
- Modify: `src/db/schema/index.ts` (re-export new schema)
- Create: `migrations/0039_<slug>.sql` (drizzle-kit generated)

- [ ] **Step 1: Write the new schema file**

`src/db/schema/customer-ai-cards.ts`:

```ts
import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  json,
  int,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";

// AI-generated summary + action plan for a single customer. One row per
// customer. Stale (>24h) rows are still returned to the client; the
// frontend shows the timestamp and a Regenerate button. Cache hit avoids
// the Anthropic call entirely.
export const customerAiCards = mysqlTable("customer_ai_cards", {
  customerId: varchar("customer_id", { length: 24 })
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  actions: json("actions").$type<CardAction[]>().notNull(),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  modelUsed: varchar("model_used", { length: 64 }),
  tokensIn: int("tokens_in"),
  tokensOut: int("tokens_out"),
});

export type CustomerAiCard = typeof customerAiCards.$inferSelect;
export type NewCustomerAiCard = typeof customerAiCards.$inferInsert;

export type CardActionKind =
  | "send_chase_email"
  | "send_statement"
  | "send_check_in_email"
  | "view_rma"
  | "view_cron_failure";

export type CardAction = {
  kind: CardActionKind;
  label: string;
  args: Record<string, unknown>;
};
```

- [ ] **Step 2: Add the draft_ai_notes column to emailLog**

In `src/db/schema/crm.ts`, inside the `emailLog` table definition (after `actionedByUserId`):

```ts
    // Operator-supplied notes that steered the AI draft reply. Persisted so
    // the learn-from-edits distiller can later pair "what the operator told
    // the AI to do" with "what the AI produced" and "what was actually sent".
    // Stored on the inbound row we replied to (the row the operator clicked
    // "Draft reply" on), since that's the unambiguous handle at draft time.
    draftAiNotes: text("draft_ai_notes"),
```

- [ ] **Step 3: Re-export the schema**

In `src/db/schema/index.ts`, add `export * from "./customer-ai-cards";` next to the existing exports.

- [ ] **Step 4: Generate the migration**

```
npm run db:generate
```

Inspect the generated `migrations/0039_<slug>.sql` to confirm:
- `CREATE TABLE customer_ai_cards (...)` with PK on customer_id, FK to customers(id) ON DELETE CASCADE.
- `ALTER TABLE email_log ADD COLUMN draft_ai_notes TEXT`.

If the auto-generated SQL is wrong, hand-edit before committing.

- [ ] **Step 5: Apply migration locally**

```
npm run db:migrate
```

(Or push directly if dev: `npm run db:push`.)

- [ ] **Step 6: Update the ~5 customer mock fixtures**

Per [[autopilot-voice-tone]] memory: adding a column to `customers` breaks fixtures. We're not modifying customers — but we ARE adding `draftAiNotes` to `emailLog`. Any test that builds a full `EmailLog` row needs the new optional field (it's nullable, so should default to null — but Drizzle insert types may complain). Grep:

```
grep -rln "EmailLog\b" src/ | grep test
```

For each match, ensure the fixture row either omits the column (relying on defaults) or sets `draftAiNotes: null`.

- [ ] **Step 7: Typecheck + run full tests**

```
npx tsc -p tsconfig.json --noEmit
npx vitest run
```

Expected: green.

- [ ] **Step 8: Commit**

```
git add src/db/schema/customer-ai-cards.ts src/db/schema/crm.ts src/db/schema/index.ts migrations/0039_*.sql migrations/meta/0039_snapshot.json migrations/meta/_journal.json
git commit -m "feat(db): customer_ai_cards table + email_log.draft_ai_notes column (migration 0039)"
```

---

## Task 4 — Customer-card generator module

**Files:**
- Create: `src/modules/ai-agent/customer-card.ts`
- Create: `src/modules/ai-agent/customer-card.test.ts`

- [ ] **Step 1: Write the test (failing)**

`src/modules/ai-agent/customer-card.test.ts` — start with two cases:

1. `buildCardPrompt` (pure helper): given finder results + customer state + voice ctx, returns a `{system, user}` shape with expected substrings (summary instructions, JSON schema mention, customer name, voice guide first line, all 5 candidates included or "none").

2. `parseCardResponse` (pure helper): given a stringified JSON response, returns typed `{summary, actions[]}`; throws/returns fallback on malformed input.

```ts
import { describe, it, expect } from "vitest";
import {
  buildCardPrompt,
  parseCardResponse,
} from "./customer-card.js";

describe("buildCardPrompt", () => {
  it("includes the customer name, voice guide, and all candidate findings", () => {
    const out = buildCardPrompt({
      customer: { id: "c1", name: "Acme Ltd" },
      kpis: { openBalance: 1200, overdueAmount: 800, hasHold: false },
      candidates: [
        { category: "chase_next", summary: { tier: "HIGH", invoice: "INV-1" } },
      ],
      recentEmails: [],
      context: {
        voiceGuide: "VOICE",
        globalFacts: [],
        categoryFacts: [],
        globalCorrections: [],
        categoryCorrections: [],
        customerContext: null,
        exampleTemplate: null,
      },
    });
    expect(out.system).toContain("VOICE");
    expect(out.user).toContain("Acme Ltd");
    expect(out.user).toContain("chase_next");
    expect(out.user.toLowerCase()).toContain("json");
  });
});

describe("parseCardResponse", () => {
  it("parses a valid JSON response into typed card data", () => {
    const raw = JSON.stringify({
      summary: "S",
      actions: [{ kind: "send_chase_email", label: "Chase L3", args: { tier: "CRITICAL" } }],
    });
    const out = parseCardResponse(raw);
    expect(out.summary).toBe("S");
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]?.kind).toBe("send_chase_email");
  });

  it("returns a safe fallback on malformed JSON", () => {
    const out = parseCardResponse("not json");
    expect(out.summary).toMatch(/unavailable|failed/i);
    expect(out.actions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing test**

```
npx vitest run src/modules/ai-agent/customer-card.test.ts
```

Expected: file-not-found / import error.

- [ ] **Step 3: Implement the module**

`src/modules/ai-agent/customer-card.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { customerAiCards, type CardAction } from "../../db/schema/customer-ai-cards.js";
import { emailLog } from "../../db/schema/crm.js";
import { buildDraftContext, type DraftContext } from "./voice.js";
import { findCandidates as findChaseNext } from "./candidates/chase-next.js";
import { findCandidates as findCadenceCold } from "./candidates/cadence-cold.js";
import { findCandidates as findCadenceStatement } from "./candidates/cadence-statement.js";
import { findCandidates as findOpsRmaStalled } from "./candidates/ops-rma-stalled.js";
import { findCandidates as findOpsCronFail } from "./candidates/ops-cron-fail.js";
import { anthropic } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "ai-agent.customer-card" });

// Stale threshold for cached card rows — older than this, the Regenerate
// button is the "fresh" path; reads still return the stale row with a flag.
const CACHE_TTL_HOURS = 24;

export type CustomerCardInput = {
  customer: { id: string; name: string };
  kpis: { openBalance: number; overdueAmount: number; hasHold: boolean };
  candidates: Array<{ category: string; summary: Record<string, unknown> }>;
  recentEmails: Array<{ direction: "inbound" | "outbound"; subject: string; date: string }>;
  context: DraftContext;
};

export type CustomerCardData = {
  summary: string;
  actions: CardAction[];
};

export function buildCardPrompt(input: CustomerCardInput): {
  system: string;
  user: string;
} {
  const system =
    `You produce concise customer summaries and action plans for an accounts ` +
    `assistant. Always output JSON matching the schema below. Be specific — ` +
    `reference invoice numbers, amounts, dates, customer state.\n\n` +
    `## Voice\n${input.context.voiceGuide}\n\n` +
    (input.context.globalFacts.length
      ? `## Things to know about Feldart\n${input.context.globalFacts.map((f) => `- ${f}`).join("\n")}\n\n`
      : "") +
    (input.context.globalCorrections.length
      ? `## Style corrections\n${input.context.globalCorrections.map((c) => `- ${c}`).join("\n")}\n\n`
      : "") +
    `## Output schema\n` +
    `{ "summary": string (2 paragraphs, plain prose),\n` +
    `  "actions": [{ "kind": "send_chase_email"|"send_statement"|"send_check_in_email"|"view_rma"|"view_cron_failure", "label": string, "args": object }] }`;

  const candidatesBlock = input.candidates.length
    ? input.candidates
        .map(
          (c) => `- ${c.category}: ${JSON.stringify(c.summary)}`,
        )
        .join("\n")
    : "(no autopilot candidates for this customer right now)";

  const emailBlock = input.recentEmails.length
    ? input.recentEmails
        .map(
          (e) => `- ${e.date} ${e.direction.toUpperCase()}: ${e.subject}`,
        )
        .join("\n")
    : "(no recent emails)";

  const ctxBlock = input.context.customerContext
    ? `\n\n## Customer-specific context (operator-curated)\n${input.context.customerContext}`
    : "";

  const user =
    `## Customer: ${input.customer.name}\n` +
    `Open balance: £${input.kpis.openBalance.toFixed(2)} ` +
    `(overdue: £${input.kpis.overdueAmount.toFixed(2)}, ` +
    `hold: ${input.kpis.hasHold ? "yes" : "no"})\n\n` +
    `## Current autopilot candidates for this customer\n${candidatesBlock}\n\n` +
    `## Recent emails (last 5)\n${emailBlock}` +
    ctxBlock +
    `\n\nReturn a JSON object matching the schema. Summary in plain prose; ` +
    `actions cover only what's actually warranted right now.`;

  return { system, user };
}

export function parseCardResponse(raw: string): CustomerCardData {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "summary" in parsed &&
      "actions" in parsed
    ) {
      const p = parsed as { summary: unknown; actions: unknown };
      if (typeof p.summary === "string" && Array.isArray(p.actions)) {
        const actions: CardAction[] = [];
        for (const a of p.actions) {
          if (
            typeof a === "object" &&
            a !== null &&
            "kind" in a &&
            "label" in a &&
            "args" in a
          ) {
            const aa = a as { kind: unknown; label: unknown; args: unknown };
            if (
              typeof aa.kind === "string" &&
              typeof aa.label === "string" &&
              typeof aa.args === "object" &&
              aa.args !== null
            ) {
              actions.push({
                kind: aa.kind as CardAction["kind"],
                label: aa.label,
                args: aa.args as Record<string, unknown>,
              });
            }
          }
        }
        return { summary: p.summary, actions };
      }
    }
  } catch {
    // fall through
  }
  return {
    summary: "AI summary unavailable — try Regenerate.",
    actions: [],
  };
}

export type GenerateOptions = { force?: boolean };

export async function generateCustomerCard(
  customerId: string,
  opts: GenerateOptions = {},
): Promise<{ data: CustomerCardData; isStale: false; generatedAt: Date }> {
  // Customer + KPIs
  const cRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const customer = cRows[0];
  if (!customer) throw new Error(`customer not found: ${customerId}`);

  // Candidates (per-customer scope)
  const [chase, coldEm, statementEm, rmaStall, cronFail] = await Promise.all([
    findChaseNext(customerId),
    findCadenceCold(customerId),
    findCadenceStatement(customerId),
    findOpsRmaStalled(customerId),
    findOpsCronFail(customerId),
  ]);
  const allCandidates = [...chase, ...coldEm, ...statementEm, ...rmaStall, ...cronFail];

  // Recent emails (last 5 by date)
  const emails = await db
    .select({
      direction: emailLog.direction,
      subject: emailLog.subject,
      emailDate: emailLog.emailDate,
    })
    .from(emailLog)
    .where(eq(emailLog.customerId, customerId))
    .orderBy(emailLog.emailDate)
    .limit(5);

  // Voice + facts + customer context (reuse buildDraftContext, category = "chase_next" for global slot)
  const ctx = await buildDraftContext("chase_next", {}, customerId);

  const prompt = buildCardPrompt({
    customer: { id: customer.id, name: customer.displayName ?? customer.id },
    kpis: {
      openBalance: Number(customer.openBalance ?? 0),
      overdueAmount: Number(customer.overdueAmount ?? 0),
      hasHold: Boolean(customer.holdStatus && customer.holdStatus !== "active"),
    },
    candidates: allCandidates.map((c) => ({
      category: c.category as string,
      summary: c.summary as Record<string, unknown>,
    })),
    recentEmails: emails.map((e) => ({
      direction: e.direction,
      subject: e.subject ?? "(no subject)",
      date: e.emailDate.toISOString().slice(0, 10),
    })),
    context: ctx,
  });

  const start = Date.now();
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  const tookMs = Date.now() - start;

  const textBlock = res.content.find((b) => b.type === "text");
  const raw = textBlock?.type === "text" ? textBlock.text : "";
  const data = parseCardResponse(raw);

  await trackUsage({
    surface: "customer_card",
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    model: "claude-sonnet-4-6",
    customerId,
  });

  const now = new Date();
  await db
    .insert(customerAiCards)
    .values({
      customerId,
      summary: data.summary,
      actions: data.actions,
      generatedAt: now,
      modelUsed: "claude-sonnet-4-6",
      tokensIn: res.usage.input_tokens,
      tokensOut: res.usage.output_tokens,
    })
    .onDuplicateKeyUpdate({
      set: {
        summary: data.summary,
        actions: data.actions,
        generatedAt: now,
        modelUsed: "claude-sonnet-4-6",
        tokensIn: res.usage.input_tokens,
        tokensOut: res.usage.output_tokens,
      },
    });

  log.info({ customerId, tookMs, force: opts.force ?? false }, "customer card generated");
  return { data, isStale: false, generatedAt: now };
}

export async function getCustomerCard(customerId: string): Promise<
  | { data: CustomerCardData; isStale: boolean; generatedAt: Date }
  | null
> {
  const rows = await db
    .select()
    .from(customerAiCards)
    .where(eq(customerAiCards.customerId, customerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const ageHours =
    (Date.now() - row.generatedAt.getTime()) / (1000 * 60 * 60);
  return {
    data: { summary: row.summary, actions: row.actions },
    isStale: ageHours > CACHE_TTL_HOURS,
    generatedAt: row.generatedAt,
  };
}
```

- [ ] **Step 4: Run test until green + typecheck**

```
npx vitest run src/modules/ai-agent/customer-card.test.ts
npx tsc -p tsconfig.json --noEmit
```

Expected: both pure helper tests green; typecheck clean.

- [ ] **Step 5: Commit**

```
git add src/modules/ai-agent/customer-card.ts src/modules/ai-agent/customer-card.test.ts
git commit -m "feat(ai-agent): customer AI card generator (per-customer scan + LLM synth)"
```

---

## Task 5 — Customer AI card routes (GET + POST regenerate)

**Files:**
- Create: `src/server/routes/customer-ai-card.ts`
- Modify: `src/server/server.ts` (register route)

- [ ] **Step 1: Write the route file**

```ts
// GET  /api/customers/:id/ai-card           → cached row, or generates on miss.
// POST /api/customers/:id/ai-card/regenerate → forces a fresh generation.

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../lib/auth.js";
import {
  generateCustomerCard,
  getCustomerCard,
} from "../../modules/ai-agent/customer-card.js";

const customerAiCardRoute: FastifyPluginAsync = async (app) => {
  app.get("/customers/:id/ai-card", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const cached = await getCustomerCard(id);
    if (cached) {
      return reply.send({
        summary: cached.data.summary,
        actions: cached.data.actions,
        generatedAt: cached.generatedAt.toISOString(),
        isStale: cached.isStale,
      });
    }
    const fresh = await generateCustomerCard(id);
    return reply.send({
      summary: fresh.data.summary,
      actions: fresh.data.actions,
      generatedAt: fresh.generatedAt.toISOString(),
      isStale: false,
    });
  });

  app.post("/customers/:id/ai-card/regenerate", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const fresh = await generateCustomerCard(id, { force: true });
    return reply.send({
      summary: fresh.data.summary,
      actions: fresh.data.actions,
      generatedAt: fresh.generatedAt.toISOString(),
      isStale: false,
    });
  });
};

export default customerAiCardRoute;
```

- [ ] **Step 2: Register in server.ts**

In `src/server/server.ts`, locate the `await app.register(...)` calls; add:

```ts
import customerAiCardRoute from "./routes/customer-ai-card.js";
// ...
await app.register(customerAiCardRoute, { prefix: "/api" });
```

(Confirm with the existing prefix pattern.)

- [ ] **Step 3: Typecheck + tests**

```
npx tsc -p tsconfig.json --noEmit
npx vitest run
```

- [ ] **Step 4: Commit**

```
git add src/server/routes/customer-ai-card.ts src/server/server.ts
git commit -m "feat(api): /api/customers/:id/ai-card + regenerate endpoints"
```

---

## Task 6 — Customer AI card frontend component

**Files:**
- Create: `src/web/components/customer-ai-card.tsx`
- Modify: `src/web/pages/customer-detail.tsx` (render the card)

- [ ] **Step 1: Build the component**

```tsx
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { useToast } from "./ui/toast";

type CardActionKind =
  | "send_chase_email"
  | "send_statement"
  | "send_check_in_email"
  | "view_rma"
  | "view_cron_failure";

type Action = {
  kind: CardActionKind;
  label: string;
  args: Record<string, unknown>;
};

type CardResponse = {
  summary: string;
  actions: Action[];
  generatedAt: string;
  isStale: boolean;
};

type Props = {
  customerId: string;
  onActionClick: (action: Action) => void;
};

export default function CustomerAiCard({ customerId, onActionClick }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["customer-ai-card", customerId] as const;

  const card = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}/ai-card`);
      if (!res.ok) throw new Error("failed to load AI card");
      return (await res.json()) as CardResponse;
    },
    staleTime: 5 * 60 * 1000, // 5 min client cache
  });

  const regen = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/customers/${customerId}/ai-card/regenerate`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error("regenerate failed");
      return (await res.json()) as CardResponse;
    },
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data);
      toast({ title: "AI card regenerated" });
    },
    onError: () => toast({ title: "Regenerate failed", variant: "destructive" }),
  });

  if (card.isPending) {
    return (
      <div className="rounded-lg border border-default bg-subtle p-4">
        Loading AI summary…
      </div>
    );
  }
  if (card.isError) {
    return (
      <div className="rounded-lg border border-default bg-subtle p-4 text-sm text-secondary">
        Couldn't load AI summary.
      </div>
    );
  }
  const data = card.data;
  const ts = new Date(data.generatedAt);
  const hoursAgo = Math.round((Date.now() - ts.getTime()) / (1000 * 60 * 60));

  return (
    <div className="rounded-lg border border-default bg-subtle p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Sparkles className="size-4 text-accent-primary" />
          AI summary &amp; action plan
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>
            Generated {hoursAgo < 1 ? "just now" : `${hoursAgo}h ago`}
            {data.isStale ? " (stale)" : ""}
          </span>
          <button
            type="button"
            onClick={() => regen.mutate()}
            disabled={regen.isPending}
            className="flex items-center gap-1 rounded-md border border-default px-2 py-1 hover:bg-elevated disabled:opacity-50"
          >
            <RefreshCw
              className={`size-3 ${regen.isPending ? "animate-spin" : ""}`}
            />
            Regenerate
          </button>
        </div>
      </div>

      <div className="whitespace-pre-wrap text-sm leading-relaxed text-secondary">
        {data.summary}
      </div>

      {data.actions.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Suggested actions
          </div>
          <div className="flex flex-wrap gap-2">
            {data.actions.map((a, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onActionClick(a)}
                className="rounded-md border border-default bg-base px-3 py-1.5 text-sm text-primary hover:bg-elevated"
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render the card on the customer detail page**

In `src/web/pages/customer-detail.tsx`, near the top of the customer detail body (between the status strip and the tabs row), add:

```tsx
<CustomerAiCard
  customerId={customerId}
  onActionClick={(action) => {
    switch (action.kind) {
      case "send_chase_email":
      case "send_check_in_email":
        setComposeContext({
          customerId,
          customerName: customer?.displayName ?? undefined,
          customerEmail: customer?.primaryEmail ?? undefined,
          presetSubject:
            typeof action.args.subject === "string"
              ? (action.args.subject as string)
              : undefined,
          presetBody:
            typeof action.args.body === "string"
              ? (action.args.body as string)
              : undefined,
        });
        setComposeOpen(true);
        return;
      case "send_statement":
        // open the existing statement-send dialog
        // (find the route; deep-link or open dialog)
        return;
      case "view_rma":
        if (typeof action.args.rmaId === "string") {
          navigate({ to: `/returns/${action.args.rmaId}` });
        }
        return;
      case "view_cron_failure":
        navigate({ to: "/settings#ops" });
        return;
    }
  }}
/>
```

(Adapt to the actual compose-modal state shape in customer-detail.tsx; the existing `setComposeOpen` + `composeContext` pair is the right hook.)

- [ ] **Step 3: Typecheck + manual sanity (dev server)**

```
npx tsc -p tsconfig.json --noEmit
npm run dev
```

- [ ] **Step 4: Commit**

```
git add src/web/components/customer-ai-card.tsx src/web/pages/customer-detail.tsx
git commit -m "feat(web): CustomerAiCard on customer detail page"
```

---

## Task 7 — Draft-reply generator module

**Files:**
- Create: `src/modules/ai-agent/draft-reply.ts`
- Create: `src/modules/ai-agent/draft-reply.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { buildDraftReplyPrompt } from "./draft-reply.js";

describe("buildDraftReplyPrompt", () => {
  it("includes the thread transcript and operator notes when provided", () => {
    const out = buildDraftReplyPrompt({
      thread: [
        { direction: "inbound", from: "client@x.com", date: "2026-05-20", subject: "Q", body: "Where is invoice?" },
        { direction: "outbound", from: "us@y.com", date: "2026-05-21", subject: "Re: Q", body: "Attached." },
        { direction: "inbound", from: "client@x.com", date: "2026-05-22", subject: "Re: Q", body: "Got it, but the total is wrong." },
      ],
      customer: { id: "c1", name: "Acme", openBalance: 1200, hasHold: false },
      notes: "apologise for the mix-up and offer to send a corrected invoice",
      context: {
        voiceGuide: "VOICE",
        globalFacts: [],
        categoryFacts: [],
        globalCorrections: [],
        categoryCorrections: [],
        customerContext: null,
        exampleTemplate: null,
      },
    });
    expect(out.system).toContain("VOICE");
    expect(out.user).toContain("Got it, but the total is wrong.");
    expect(out.user).toContain("apologise");
    expect(out.user.toLowerCase()).toContain("reply");
  });

  it("works without notes (clean run)", () => {
    const out = buildDraftReplyPrompt({
      thread: [
        { direction: "inbound", from: "c@x.com", date: "2026-05-20", subject: "Q", body: "Need a copy of invoice INV-9." },
      ],
      customer: { id: "c1", name: "Acme", openBalance: 0, hasHold: false },
      notes: null,
      context: {
        voiceGuide: "VOICE",
        globalFacts: [],
        categoryFacts: [],
        globalCorrections: [],
        categoryCorrections: [],
        customerContext: null,
        exampleTemplate: null,
      },
    });
    expect(out.user).toContain("INV-9");
    expect(out.user.toLowerCase()).not.toContain("notes for ai");
  });
});
```

- [ ] **Step 2: Run failing test**

```
npx vitest run src/modules/ai-agent/draft-reply.test.ts
```

- [ ] **Step 3: Implement the module**

```ts
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog } from "../../db/schema/crm.js";
import { buildDraftContext, type DraftContext } from "./voice.js";
import { anthropic } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "ai-agent.draft-reply" });

type ThreadMessage = {
  direction: "inbound" | "outbound";
  from: string;
  date: string;
  subject: string;
  body: string;
};

type Input = {
  thread: ThreadMessage[];
  customer: { id: string; name: string; openBalance: number; hasHold: boolean };
  notes: string | null;
  context: DraftContext;
};

export function buildDraftReplyPrompt(input: Input): {
  system: string;
  user: string;
} {
  const system =
    `You write email replies on behalf of Feldart's accounts team. Stay in voice, ` +
    `match the seriousness of the situation, be specific. Return plain-text body ` +
    `only (no greeting like "Dear Sir" — the signature is auto-appended).\n\n` +
    `## Voice\n${input.context.voiceGuide}\n\n` +
    (input.context.globalFacts.length
      ? `## Things to know about Feldart\n${input.context.globalFacts.map((f) => `- ${f}`).join("\n")}\n\n`
      : "") +
    (input.context.globalCorrections.length
      ? `## Style corrections\n${input.context.globalCorrections.map((c) => `- ${c}`).join("\n")}\n\n`
      : "");

  const threadBlock = input.thread
    .map(
      (m) =>
        `### ${m.direction.toUpperCase()} — ${m.date} — ${m.from}\nSubject: ${m.subject}\n${m.body}`,
    )
    .join("\n\n---\n\n");

  const ctxLine =
    `Customer: ${input.customer.name} ` +
    `(open balance £${input.customer.openBalance.toFixed(2)}, ` +
    `hold: ${input.customer.hasHold ? "yes" : "no"})`;

  const ctxBlock = input.context.customerContext
    ? `\n\n## Customer-specific context\n${input.context.customerContext}`
    : "";

  const notesBlock = input.notes
    ? `\n\n## Operator instructions for this reply\n${input.notes}`
    : "";

  const user =
    `${ctxLine}\n\n## Thread\n${threadBlock}${ctxBlock}${notesBlock}\n\n` +
    `Write a reply to the most recent inbound message. Output JSON: ` +
    `{ "subject": string, "body": string }. The body is plain prose; ` +
    `paragraphs separated by blank lines.`;

  return { system, user };
}

export type DraftReplyResult = { subject: string; body: string };

export async function generateDraftReply(
  emailLogId: string,
  notes: string | null,
): Promise<DraftReplyResult> {
  // Load the source email
  const rows = await db
    .select()
    .from(emailLog)
    .where(eq(emailLog.id, emailLogId))
    .limit(1);
  const source = rows[0];
  if (!source) throw new Error(`email_log not found: ${emailLogId}`);
  if (source.direction !== "inbound")
    throw new Error("draft-reply only supports inbound rows");
  if (!source.customerId) throw new Error("email has no linked customer");
  if (!source.threadId) throw new Error("email has no threadId");

  // Load the whole thread (asc by emailDate)
  const threadRows = await db
    .select()
    .from(emailLog)
    .where(eq(emailLog.threadId, source.threadId))
    .orderBy(asc(emailLog.emailDate));

  // Persist notes on the source row so the learn-from-edits distiller sees them.
  if (notes != null && notes.trim().length > 0) {
    await db
      .update(emailLog)
      .set({ draftAiNotes: notes })
      .where(eq(emailLog.id, emailLogId));
  }

  // Customer
  const cRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, source.customerId))
    .limit(1);
  const customer = cRows[0];
  if (!customer) throw new Error("customer missing");

  const ctx = await buildDraftContext("chase_next", {}, source.customerId);

  const prompt = buildDraftReplyPrompt({
    thread: threadRows.map((r) => ({
      direction: r.direction,
      from: r.fromAddress ?? "",
      date: r.emailDate.toISOString().slice(0, 10),
      subject: r.subject ?? "",
      body: (r.body ?? r.snippet ?? "").slice(0, 4000),
    })),
    customer: {
      id: customer.id,
      name: customer.displayName ?? customer.id,
      openBalance: Number(customer.openBalance ?? 0),
      hasHold: Boolean(customer.holdStatus && customer.holdStatus !== "active"),
    },
    notes: notes && notes.trim().length > 0 ? notes : null,
    context: ctx,
  });

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  await trackUsage({
    surface: "draft_reply",
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    model: "claude-sonnet-4-6",
    customerId: source.customerId,
  });

  const textBlock = res.content.find((b) => b.type === "text");
  const raw = textBlock?.type === "text" ? textBlock.text : "";
  try {
    const parsed = JSON.parse(raw) as { subject?: unknown; body?: unknown };
    const subject =
      typeof parsed.subject === "string" && parsed.subject.length > 0
        ? parsed.subject
        : `Re: ${source.subject ?? ""}`;
    const body = typeof parsed.body === "string" ? parsed.body : raw;
    log.info({ emailLogId, hasNotes: Boolean(notes) }, "draft reply generated");
    return { subject, body };
  } catch {
    return { subject: `Re: ${source.subject ?? ""}`, body: raw };
  }
}
```

- [ ] **Step 4: Run test until green + typecheck**

```
npx vitest run src/modules/ai-agent/draft-reply.test.ts
npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 5: Commit**

```
git add src/modules/ai-agent/draft-reply.ts src/modules/ai-agent/draft-reply.test.ts
git commit -m "feat(ai-agent): per-email draft-reply generator (clean or with operator notes)"
```

---

## Task 8 — Draft-reply route

**Files:**
- Modify: `src/server/routes/email-log.ts` (add POST /:id/draft-reply)

- [ ] **Step 1: Add the route**

In `src/server/routes/email-log.ts`, after the existing `/:id/to-task` handler:

```ts
const draftReplyBodySchema = z.object({
  notes: z.string().max(2000).optional(),
});

// POST /api/email-log/:id/draft-reply { notes? }
// Returns { subject, body } for the compose modal to pre-fill. Notes are
// persisted on the source row for learn-from-edits.
app.post("/:id/draft-reply", async (req, reply) => {
  await requireAuth(req);
  const id = (req.params as { id: string }).id;
  const parse = draftReplyBodySchema.safeParse(req.body);
  if (!parse.success) {
    return reply
      .code(400)
      .send({ error: "invalid body", details: parse.error.flatten() });
  }
  try {
    const result = await generateDraftReply(id, parse.data.notes ?? null);
    return reply.send(result);
  } catch (err) {
    log.error({ err, emailLogId: id }, "draft-reply failed");
    return reply
      .code(500)
      .send({ error: err instanceof Error ? err.message : "draft failed" });
  }
});
```

Add the import at the top:

```ts
import { generateDraftReply } from "../../modules/ai-agent/draft-reply.js";
```

- [ ] **Step 2: Typecheck + tests**

```
npx tsc -p tsconfig.json --noEmit
npx vitest run
```

- [ ] **Step 3: Commit**

```
git add src/server/routes/email-log.ts
git commit -m "feat(api): POST /api/email-log/:id/draft-reply"
```

---

## Task 9 — Compose-modal AI panel

**Files:**
- Modify: `src/web/components/compose-modal.tsx`

- [ ] **Step 1: Extend ComposeContext to carry an optional source emailLogId**

In `compose-modal.tsx`, extend `ComposeContext`:

```ts
export type ComposeContext = {
  // ...existing fields...
  // When set, the compose modal renders an "AI" panel (notes + Generate)
  // and calls /api/email-log/:id/draft-reply on Generate. Distinct from
  // inReplyTo: inReplyTo is the threading metadata for the outbound; this
  // is the inbound-row handle for the AI draft.
  draftReplyForEmailLogId?: string;
};
```

- [ ] **Step 2: Render the AI panel inside the modal**

Inside the modal body, above the body textarea:

```tsx
{context.draftReplyForEmailLogId && (
  <div className="rounded-md border border-accent-primary/30 bg-accent-primary/5 p-3 space-y-2">
    <div className="flex items-center gap-2 text-sm font-medium">
      <Sparkles className="size-4 text-accent-primary" />
      AI draft
    </div>
    <textarea
      value={aiNotes}
      onChange={(e) => setAiNotes(e.target.value)}
      placeholder="Notes for AI (optional) — leave blank for a clean draft"
      className="w-full rounded-md border border-default bg-base p-2 text-sm"
      rows={2}
    />
    <button
      type="button"
      onClick={handleGenerate}
      disabled={generating}
      className="rounded-md bg-accent-primary px-3 py-1.5 text-sm text-white hover:bg-accent-primary/90 disabled:opacity-50"
    >
      {generating ? "Generating…" : "Generate"}
    </button>
  </div>
)}
```

With state + handler:

```tsx
const [aiNotes, setAiNotes] = useState("");
const [generating, setGenerating] = useState(false);

async function handleGenerate() {
  if (!context.draftReplyForEmailLogId) return;
  if (body.trim().length > 0) {
    if (!confirm("Replace the current draft with a fresh AI draft?")) return;
  }
  setGenerating(true);
  try {
    const res = await fetch(
      `/api/email-log/${context.draftReplyForEmailLogId}/draft-reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: aiNotes || undefined }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { subject: string; body: string };
    setSubject(data.subject);
    setBody(data.body);
  } catch (err) {
    toast({
      title: "AI draft failed",
      description: err instanceof Error ? err.message : "Unknown error",
      variant: "destructive",
    });
  } finally {
    setGenerating(false);
  }
}
```

- [ ] **Step 3: Typecheck + dev sanity**

```
npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 4: Commit**

```
git add src/web/components/compose-modal.tsx
git commit -m "feat(web): AI draft panel in compose modal (notes + Generate)"
```

---

## Task 10 — "Draft reply" button in customer-detail Email tab

**Files:**
- Modify: `src/web/components/email-list.tsx`

- [ ] **Step 1: Add the button on inbound rows**

In `email-list.tsx`, in the row renderer where existing action buttons live, add (only for `email.direction === "inbound"`):

```tsx
<button
  type="button"
  onClick={() => {
    setComposeContext({
      customerId,
      customerName: customerName ?? undefined,
      customerEmail: email.fromAddress ?? undefined,
      inReplyTo: {
        messageId: email.messageIdHeader ?? "",
        threadId: email.threadId ?? "",
        subject: email.subject ?? "",
        from: email.fromAddress ?? "",
        bodyExcerpt: (email.snippet ?? "").slice(0, 200),
      },
      draftReplyForEmailLogId: email.id,
    });
  }}
  className="rounded-md border border-default px-2 py-1 text-xs hover:bg-elevated"
  title="Open compose with AI draft panel"
>
  <Sparkles className="size-3 inline" /> Draft reply
</button>
```

Make sure `Sparkles` is imported from lucide-react at the top.

- [ ] **Step 2: Typecheck + commit**

```
npx tsc -p tsconfig.json --noEmit
git add src/web/components/email-list.tsx
git commit -m "feat(web): Draft reply button on inbound rows in customer email list"
```

---

## Task 11 — "Draft reply" button in dashboard emails widget

**Files:**
- Modify: `src/web/components/dashboard/emails-widget.tsx`

- [ ] **Step 1: Add the same button**

Mirror the email-list.tsx pattern. The widget already has a customerId per row; reuse it. Render a small "Draft reply" button next to the existing "Open" link.

```tsx
<button
  type="button"
  onClick={() => onDraftReply(row)}
  className="rounded-md border border-default px-2 py-1 text-xs hover:bg-elevated"
>
  <Sparkles className="size-3 inline" /> Draft reply
</button>
```

The dashboard widget doesn't open the compose modal itself — wire it via a prop or a query-param route. Easiest path: navigate to `/customers/:id?openCompose=1&draftReplyFor=:emailId` and let the customer-detail page open the modal on mount when those params are set. Alternative: lift a global compose state (more work).

**Decision for this task:** use the navigate-with-query-param path. Modify `customer-detail.tsx` to read `useSearch` and pre-open the compose modal when `draftReplyFor` is present.

- [ ] **Step 2: Wire customer-detail.tsx to open compose on mount when query params present**

In `customer-detail.tsx`, on mount effect:

```tsx
useEffect(() => {
  const search = window.location.search;
  const params = new URLSearchParams(search);
  const draftFor = params.get("draftReplyFor");
  if (draftFor && customer) {
    setComposeContext({
      customerId: customer.id,
      customerName: customer.displayName ?? undefined,
      customerEmail: customer.primaryEmail ?? undefined,
      draftReplyForEmailLogId: draftFor,
    });
    setComposeOpen(true);
  }
}, [customer]);
```

- [ ] **Step 3: Typecheck + commit**

```
npx tsc -p tsconfig.json --noEmit
git add src/web/components/dashboard/emails-widget.tsx src/web/pages/customer-detail.tsx
git commit -m "feat(web): Draft reply button on dashboard emails widget; opens compose via customer page"
```

---

## Task 12 — Settings UI: cron toggle on /ai-training

**Files:**
- Modify: `src/web/pages/ai-training.tsx`

- [ ] **Step 1: Add a row that toggles autopilot_scan_cron_enabled**

Find the existing `ai_corrections_cron_enabled` toggle (a settings row pattern already in this page). Mirror it:

```tsx
<SettingsToggleRow
  settingKey="autopilot_scan_cron_enabled"
  label="Autopilot scan cron"
  description="When ON, the autopilot scan runs every 4h. When OFF (default), only manual 'Run autopilot now' triggers fire scans."
/>
```

(Adapt to the actual component pattern in that file.)

- [ ] **Step 2: Typecheck + commit**

```
npx tsc -p tsconfig.json --noEmit
git add src/web/pages/ai-training.tsx
git commit -m "feat(web): autopilot scan cron toggle on /ai-training"
```

---

## Task 13 — Full verify + deploy

- [ ] **Step 1: Run the full suite + typecheck + build**

```
npx tsc -p tsconfig.json --noEmit
npx vitest run
npm run build
```

Expected: green across the board. Note: 2 pre-existing failures in `qb-sync.regression.test.ts` were already resolved upstream — total should remain at 567+ passing.

- [ ] **Step 2: Push the branch + open PR**

```
git push -u origin feat/ai-on-demand
gh pr create --title "AI on-demand (cron off, customer card, per-email draft)" --body "..."
```

- [ ] **Step 3: After merge — manual UI smoke (operator)**

(Listed for the user; not executable by the implementer.)

- Cron toggle off (default): /ai-training shows toggle; next 4h-aligned tick does not produce proposals (verify via logs).
- Cron toggle on: next tick runs; proposals appear in /autopilot.
- Customer detail page: AI summary + action plan card renders; action buttons open compose pre-filled.
- Regenerate: click → spinner → new content; timestamp updates.
- /customers/:id email tab inbound row: "Draft reply" button opens compose with AI panel; Generate (blank) produces a clean draft; Generate (with notes) reflects the steer.
- Dashboard emails widget: "Draft reply" jumps to customer page with compose open + AI panel ready.

---

## Self-review checklist (run at end)

- Every spec requirement (decisions A–E) has a task implementing it.
- No placeholders / TBDs in plan steps.
- Type names match across tasks (`CardAction`, `CustomerCardData`, `DraftReplyResult`, `ComposeContext.draftReplyForEmailLogId`).
- Tests are real test code, not "TODO: write tests".
- Commit boundaries are sensible — one logical change per commit.
