# AI-Training Suite — Wave C (Learn-From-Edits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop — distill the operator's draft-vs-sent edits into reusable, operator-approved "style corrections" that feed back into every autopilot draft. On-demand button + optional weekly cron; corrections are proposed (never auto-applied), reviewed, and injected through the existing `composeSystem`.

**Architecture:** A new `ai_learned_corrections` table (proposed → active → retired/rejected). A distiller reads recent **executed chase/cold proposals** (`ai_proposals.draftedAction.args.body`) joined to their **sent** email (`email_log.bodyHtml` via `aiProposalId`), and where they differ asks Claude for *recurring stylistic* corrections (ignoring one-off factual edits, requiring multi-email support) → `proposed` rows. `buildDraftContext` loads `active` corrections (tag-filtered) into the slots Wave A already defined; `composeSystem` (Wave B) already renders them — **the prompt builders are NOT touched in this wave.** Triggers: a `/api/ai-training/corrections/distill` endpoint (button) and a weekly BullMQ cron gated by `app_settings.ai_corrections_cron_enabled` (key already registered in Wave A).

**Tech Stack:** Fastify v5, Drizzle ORM (MySQL 8), BullMQ + Redis, `@anthropic-ai/sdk` (Sonnet 4.6), Vite + React 18 + TanStack Query, vitest.

**Scope note:** Wave C of the suite (spec: `docs/superpowers/specs/2026-05-20-ai-training-suite-design.md`). Builds on Wave A (resolver/`toSystemParam`) + Wave B (`composeSystem` corrections rendering, facts CRUD route, `/ai-training` page). **Caching still deferred** (Wave A) — once corrections + facts grow the system prefix past ~1024 tokens, do the deferred SDK-upgrade-vs-beta-client caching pass.

**Out of scope:** `send_statement` edits (its `coverNote` goes to `statement_sends`, not `email_log`) and the RMA-warehouse nudge — the distiller learns from **`chase_next` + `cadence_cold`** emails only (where bodies land in `email_log` and voice matters most).

---

## File Structure

**Create:**
- `src/db/schema/ai-learned-corrections.ts` — table + types.
- `src/modules/ai-agent/corrections.ts` — `stripHtml`, `pairsWithEdits`, `buildDistillPrompt` (pure) + `runCorrectionsDistill` (side-effecting).
- `src/modules/ai-agent/corrections.test.ts` — unit tests for the pure helpers.
- `src/jobs/definitions/ai-corrections-distill.ts` — cron job handler.
- `migrations/0038_*.sql` — generated.

**Modify:**
- `src/db/schema/index.ts` — re-export the new table.
- `src/modules/ai-agent/voice.ts` — load active corrections in `buildDraftContext`.
- `src/modules/ai-agent/voice.test.ts` — corrections cases (new query order).
- `src/server/routes/ai-training.ts` — corrections endpoints (distill / list / decide).
- `src/jobs/queues.ts` — new queue + constants.
- `src/jobs/schedule.ts` — weekly repeatable registration.
- `src/jobs/worker.ts` — register the worker.
- `src/web/pages/ai-training.tsx` — Corrections review card + cron toggle.

---

## Task 1: `ai_learned_corrections` table + migration

**Files:**
- Create: `src/db/schema/ai-learned-corrections.ts`
- Modify: `src/db/schema/index.ts`

- [ ] **Step 1: Create the schema**

Create `src/db/schema/ai-learned-corrections.ts`:

```ts
import {
  index,
  json,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const CORRECTION_STATUSES = [
  "proposed",
  "active",
  "rejected",
  "retired",
] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

// Distilled, operator-approved style corrections injected into autopilot
// drafts. `tags` = "global" and/or AiProposalCategory slugs (same scheme as
// ai_company_facts). `sourceProposalIds` records which draft-vs-sent pairs
// the correction was distilled from (provenance).
export const aiLearnedCorrections = mysqlTable(
  "ai_learned_corrections",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    correction: text("correction").notNull(),
    tags: json("tags").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 16 }).notNull().default("proposed"),
    sourceProposalIds: json("source_proposal_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    decidedByUserId: varchar("decided_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    decidedAt: timestamp("decided_at"),
  },
  (t) => ({
    statusIdx: index("idx_ai_learned_corrections_status").on(t.status),
  }),
);

export type AiLearnedCorrection = typeof aiLearnedCorrections.$inferSelect;
export type NewAiLearnedCorrection = typeof aiLearnedCorrections.$inferInsert;
```

- [ ] **Step 2: Re-export from the barrel**

In `src/db/schema/index.ts`, add after the `ai-company-facts` line:

```ts
export * from "./ai-learned-corrections";
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: `migrations/0038_*.sql` with `CREATE TABLE ai_learned_corrections (...)`. Open it; confirm one table, no drops.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema/ai-learned-corrections.ts src/db/schema/index.ts migrations/
git commit -m "feat(ai-training): ai_learned_corrections table (Wave C schema)"
```

> Apply at dev/deploy: `npm run db:migrate`.

---

## Task 2: Load active corrections in `buildDraftContext`

**Files:**
- Modify: `src/modules/ai-agent/voice.ts`, `src/modules/ai-agent/voice.test.ts`

- [ ] **Step 1: Update the resolver tests for the new query**

The corrections query runs **after facts, before customer context** (so order is: voice guide → facts → corrections → customer → example). Update `src/modules/ai-agent/voice.test.ts`: bump the per-test mock sequences to include a corrections result after facts, and add a partition assertion. Replace the two existing fact/customer tests' mock chains to insert a corrections `chain([...])` immediately after the facts `chain([...])`, e.g. the "partitions facts" test becomes:

```ts
  it("partitions facts and corrections by tag", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(
        chain([
          { fact: "We close in August", tags: ["global"], active: true },
          { fact: "Chase: mention orders-on-hold", tags: ["chase_next"], active: true },
        ]),
      ) // facts
      .mockReturnValueOnce(
        chain([
          { correction: "Never say 'kindly'", tags: ["global"], status: "active" },
          { correction: "Chase: no legal threats at L1", tags: ["chase_next"], status: "active" },
        ]),
      ) // corrections
      .mockReturnValueOnce(chain([{ body: "L1 BODY" }])); // example
    const ctx = await buildDraftContext("chase_next", { tier: "MEDIUM" }, null);
    expect(ctx.globalFacts).toEqual(["We close in August"]);
    expect(ctx.categoryFacts).toEqual(["Chase: mention orders-on-hold"]);
    expect(ctx.globalCorrections).toEqual(["Never say 'kindly'"]);
    expect(ctx.categoryCorrections).toEqual(["Chase: no legal threats at L1"]);
  });
```

Also update the other multi-query tests ("falls back…", "loads customer context", "customerContext null", "leaves corrections empty") to insert a corrections `chain([])` after the facts chain, and bump the `mock.calls.length` assertion in the last test from `2` to `3`.

- [ ] **Step 2: Run → fail**

Run: `npm test -- src/modules/ai-agent/voice.test.ts`
Expected: FAIL (resolver doesn't query corrections; returns `[]`).

- [ ] **Step 3: Implement the corrections query**

In `src/modules/ai-agent/voice.ts`: import the table and add the query after the facts block, before the customer block. Add to imports:

```ts
import { aiLearnedCorrections } from "../../db/schema/ai-learned-corrections.js";
```

Insert after the facts partition loop (before the `// 3. per-customer context` block), and renumber comments:

```ts
  // 3. active learned corrections, partitioned by tag
  const correctionRows = await db
    .select()
    .from(aiLearnedCorrections)
    .where(eq(aiLearnedCorrections.status, "active"));
  const globalCorrections: string[] = [];
  const categoryCorrections: string[] = [];
  for (const c of correctionRows) {
    const tags = c.tags ?? [];
    if (tags.includes(FACT_TAG_GLOBAL)) globalCorrections.push(c.correction);
    else if (tags.includes(category)) categoryCorrections.push(c.correction);
  }
```

Then change the `return` to use the real arrays:

```ts
    globalCorrections,
    categoryCorrections,
```

(remove the `// Wave C (#2) populates` empty-array stubs).

- [ ] **Step 4: Run → pass**

Run: `npm test -- src/modules/ai-agent/voice.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/modules/ai-agent/voice.ts src/modules/ai-agent/voice.test.ts
git commit -m "feat(ai-training): inject active learned corrections into drafts (Wave C)"
```

(No builder changes — `composeSystem` already renders corrections.)

---

## Task 3: The distiller — pure helpers + runner

**Files:**
- Create: `src/modules/ai-agent/corrections.ts`, `src/modules/ai-agent/corrections.test.ts`

- [ ] **Step 1: Write the pure-helper tests**

Create `src/modules/ai-agent/corrections.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  stripHtml,
  pairsWithEdits,
  buildDistillPrompt,
} from "./corrections.js";

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello   <b>world</b></p>")).toBe("Hello world");
  });
});

describe("pairsWithEdits", () => {
  it("keeps only pairs where the sent text meaningfully differs from the draft", () => {
    const rows = [
      { category: "chase_next", draftBody: "<p>Pay now</p>", sentBody: "<p>Pay now</p>" }, // unchanged
      { category: "chase_next", draftBody: "<p>Pay now please</p>", sentBody: "<p>Could you settle this?</p>" }, // edited
      { category: "cadence_cold", draftBody: "<p>Hi</p>", sentBody: null }, // not sent yet
    ];
    const out = pairsWithEdits(rows);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("chase_next");
  });
});

describe("buildDistillPrompt", () => {
  it("includes draft/sent pairs and demands recurring-only JSON output", () => {
    const prompt = buildDistillPrompt([
      { category: "chase_next", draft: "DRAFT_A", sent: "SENT_A" },
    ]);
    expect(prompt).toContain("DRAFT_A");
    expect(prompt).toContain("SENT_A");
    expect(prompt.toLowerCase()).toContain("recurring");
    expect(prompt.toLowerCase()).toContain("ignore");
    expect(prompt).toContain("corrections");
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `npm test -- src/modules/ai-agent/corrections.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/modules/ai-agent/corrections.ts`:

```ts
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";
import { emailLog } from "../../db/schema/crm.js";
import { aiLearnedCorrections } from "../../db/schema/ai-learned-corrections.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";
import { nanoid } from "nanoid";

const log = createLogger({ module: "ai-agent.corrections" });
const SONNET = "claude-sonnet-4-6";
const MIN_EDITED_PAIRS = 3; // cold-start guard

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type RawPair = {
  category: string;
  draftBody: string | null;
  sentBody: string | null;
  proposalId?: string;
};
export type EditedPair = {
  category: string;
  draft: string;
  sent: string;
  proposalId?: string;
};

// Keep only pairs that were actually sent AND meaningfully edited (stripped
// text differs). Trivial/whitespace-only diffs are dropped.
export function pairsWithEdits(rows: RawPair[]): EditedPair[] {
  const out: EditedPair[] = [];
  for (const r of rows) {
    if (!r.draftBody || !r.sentBody) continue;
    const draft = stripHtml(r.draftBody);
    const sent = stripHtml(r.sentBody);
    if (!draft || !sent) continue;
    if (draft === sent) continue;
    out.push({ category: r.category, draft, sent, proposalId: r.proposalId });
  }
  return out;
}

export function buildDistillPrompt(
  pairs: Array<{ category: string; draft: string; sent: string }>,
): string {
  const body = pairs
    .map(
      (p, i) =>
        `### Pair ${i + 1} (${p.category})\nAI DRAFT:\n${p.draft}\n\nOPERATOR SENT:\n${p.sent}`,
    )
    .join("\n\n");
  return `You are analysing how a Feldart accounts operator edits AI-drafted emails before sending, to learn their style.

For each pair below, compare the AI draft to what the operator actually sent. Identify ONLY recurring, stylistic/structural corrections the operator consistently makes — tone, phrasing, sign-offs, structure, things they add or remove.

STRICT rules:
- IGNORE one-off factual edits (a changed name, number, date, invoice id, or customer-specific detail). Those are not style lessons.
- Only output a correction if the pattern appears across MULTIPLE pairs (recurring). If nothing recurs, output an empty list.
- Each correction is a short imperative instruction a writer could follow.

Output STRICT JSON only, no prose:
{"corrections": [{"text": "<imperative correction>", "tags": ["global"]}]}
Use tag "global" for general style, or a category slug ("chase_next", "cadence_cold") if the correction is specific to that draft type.

## Draft-vs-sent pairs
${body}`;
}

type DistillResult = { proposed: number; reason?: string };

export async function runCorrectionsDistill(
  userId: string | null,
): Promise<DistillResult> {
  // Fetch recent executed chase/cold proposals + their sent email body.
  const rows = await db
    .select({
      proposalId: aiProposals.id,
      category: aiProposals.category,
      draftedAction: aiProposals.draftedAction,
      sentBody: emailLog.bodyHtml,
      sentPlain: emailLog.body,
    })
    .from(aiProposals)
    .leftJoin(emailLog, eq(emailLog.aiProposalId, aiProposals.id))
    .where(
      and(
        eq(aiProposals.status, "executed"),
        isNotNull(aiProposals.draftedAction),
        inArray(aiProposals.category, ["chase_next", "cadence_cold"]),
      ),
    )
    .orderBy(desc(aiProposals.executedAt))
    .limit(50);

  const raw: RawPair[] = rows.map((r) => {
    const action = r.draftedAction as
      | { tool: string; args: Record<string, unknown> }
      | null;
    const draftBody =
      action && typeof action.args.body === "string"
        ? (action.args.body as string)
        : null;
    return {
      category: r.category,
      draftBody,
      sentBody: (r.sentBody ?? r.sentPlain) as string | null,
      proposalId: r.proposalId,
    };
  });

  const edited = pairsWithEdits(raw);
  if (edited.length < MIN_EDITED_PAIRS) {
    return { proposed: 0, reason: "not enough edited drafts yet" };
  }

  const prompt = buildDistillPrompt(
    edited.map((e) => ({ category: e.category, draft: e.draft, sent: e.sent })),
  );
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: SONNET,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  await trackUsage(response, { surface: "background_proposing", userId });

  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();

  let parsed: { corrections?: Array<{ text?: string; tags?: string[] }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn({ text: text.slice(0, 200) }, "distill: non-JSON response");
    return { proposed: 0, reason: "model did not return JSON" };
  }
  const corrections = (parsed.corrections ?? []).filter(
    (c) => typeof c.text === "string" && c.text.trim().length > 0,
  );
  if (corrections.length === 0) return { proposed: 0, reason: "no recurring patterns" };

  const sourceIds = edited
    .map((e) => e.proposalId)
    .filter((x): x is string => Boolean(x));
  for (const c of corrections) {
    await db.insert(aiLearnedCorrections).values({
      id: nanoid(24),
      correction: c.text!.trim(),
      tags: Array.isArray(c.tags) && c.tags.length > 0 ? c.tags : ["global"],
      status: "proposed",
      sourceProposalIds: sourceIds,
    });
  }
  log.info({ proposed: corrections.length }, "corrections distilled");
  return { proposed: corrections.length };
}
```

- [ ] **Step 4: Run → pass**

Run: `npm test -- src/modules/ai-agent/corrections.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/modules/ai-agent/corrections.ts src/modules/ai-agent/corrections.test.ts
git commit -m "feat(ai-training): learn-from-edits distiller (pure helpers + runner)"
```

---

## Task 4: Corrections endpoints

**Files:**
- Modify: `src/server/routes/ai-training.ts`

- [ ] **Step 1: Add endpoints**

Add imports (`aiLearnedCorrections`, `runCorrectionsDistill`) at the top, and these handlers inside the plugin (after the facts routes):

```ts
import { aiLearnedCorrections } from "../../db/schema/ai-learned-corrections.js";
import { runCorrectionsDistill } from "../../modules/ai-agent/corrections.js";

  // POST /api/ai-training/corrections/distill — on-demand "learn from edits".
  app.post("/corrections/distill", async (req, reply) => {
    const user = await requireAuth(req);
    try {
      const result = await runCorrectionsDistill(user.id);
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "distill failed");
      return reply.code(500).send({ error: "distill failed", detail: msg });
    }
  });

  // GET /api/ai-training/corrections — list (proposed + active + others).
  app.get("/corrections", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(aiLearnedCorrections)
      .orderBy(desc(aiLearnedCorrections.createdAt));
    return reply.send({ corrections: rows });
  });

  // PATCH /api/ai-training/corrections/:id — approve/reject/retire/edit.
  app.patch<{ Params: { id: string } }>(
    "/corrections/:id",
    async (req, reply) => {
      const user = await requireAuth(req);
      const schema = z.object({
        correction: z.string().min(1).max(4000).optional(),
        tags: z.array(z.string().min(1).max(64)).max(20).optional(),
        status: z.enum(["proposed", "active", "rejected", "retired"]).optional(),
      });
      const parse = schema.safeParse(req.body);
      if (!parse.success) {
        return reply
          .code(400)
          .send({ error: "invalid body", details: parse.error.flatten() });
      }
      if (Object.keys(parse.data).length === 0) {
        return reply.code(400).send({ error: "no fields to update" });
      }
      const beforeRows = await db
        .select()
        .from(aiLearnedCorrections)
        .where(eq(aiLearnedCorrections.id, req.params.id))
        .limit(1);
      if (!beforeRows[0]) return reply.code(404).send({ error: "not found" });
      const writeSet: Record<string, unknown> = { ...parse.data };
      if (parse.data.status) {
        writeSet.decidedByUserId = user.id;
        writeSet.decidedAt = sql`CURRENT_TIMESTAMP`;
      }
      await db
        .update(aiLearnedCorrections)
        .set(writeSet)
        .where(eq(aiLearnedCorrections.id, req.params.id));
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "ai_learned_correction.update",
        entityType: "ai_learned_correction",
        entityId: req.params.id,
        before: beforeRows[0],
        after: parse.data,
      });
      return reply.send({ ok: true });
    },
  );
```

Add `sql` to the existing `drizzle-orm` import in this file (currently `import { desc, eq } from "drizzle-orm";` → `import { desc, eq, sql } from "drizzle-orm";`).

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/server/routes/ai-training.ts
git commit -m "feat(ai-training): corrections distill/list/decide endpoints"
```

---

## Task 5: Weekly distill cron (gated)

**Files:**
- Create: `src/jobs/definitions/ai-corrections-distill.ts`
- Modify: `src/jobs/queues.ts`, `src/jobs/schedule.ts`, `src/jobs/worker.ts`

- [ ] **Step 1: Job definition (gated handler)**

Create `src/jobs/definitions/ai-corrections-distill.ts`:

```ts
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { runCorrectionsDistill } from "../../modules/ai-agent/corrections.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "jobs.ai-corrections-distill" });

export type AiCorrectionsDistillJobData = { trigger: "cron" };
export type AiCorrectionsDistillJobResult = {
  ran: boolean;
  proposed?: number;
  reason?: string;
};

export async function aiCorrectionsDistillHandler(
  job: Job<AiCorrectionsDistillJobData>,
): Promise<AiCorrectionsDistillJobResult> {
  const jobLog = log.child({ jobId: job.id });
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_corrections_cron_enabled"))
    .limit(1);
  if (rows[0]?.value !== "true") {
    jobLog.info({ stage: "skipped" }, "corrections cron disabled");
    return { ran: false, reason: "disabled" };
  }
  const result = await runCorrectionsDistill(null);
  jobLog.info({ proposed: result.proposed }, "corrections cron complete");
  return { ran: true, proposed: result.proposed, reason: result.reason };
}
```

- [ ] **Step 2: Queue + constants**

In `src/jobs/queues.ts`, mirror the autopilot-scan wiring: add constants `AI_CORRECTIONS_QUEUE = "ai-corrections"` + `AI_CORRECTIONS_DISTILL_JOB = "ai-corrections-distill"`; add `aiCorrections: Queue` to the `Queues` type; instantiate it in `getQueues()` exactly like `autopilotScan` (same `defaultJobOptions`).

- [ ] **Step 3: Schedule (weekly)**

In `src/jobs/schedule.ts`, mirror the autopilot-scan repeatable registration:

```ts
// Learn-from-edits distill — Monday 08:00 Europe/London. Gated inside the
// handler by app_settings.ai_corrections_cron_enabled (default off), so this
// repeatable always exists but no-ops until the operator enables it.
await queues.aiCorrections.add(
  AI_CORRECTIONS_DISTILL_JOB,
  { trigger: "cron" },
  {
    jobId: `repeat:${AI_CORRECTIONS_DISTILL_JOB}`,
    repeat: { pattern: "0 8 * * 1", tz: "Europe/London" },
  },
);
registered.push({ name: AI_CORRECTIONS_DISTILL_JOB, cron: "0 8 * * 1" });
```

(Add the imports for `AI_CORRECTIONS_DISTILL_JOB` from queues.js.)

- [ ] **Step 4: Worker**

In `src/jobs/worker.ts`, register a Worker for the `aiCorrections` queue using `aiCorrectionsDistillHandler` — mirror the autopilot-scan Worker block (same connection, concurrency 1).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/jobs/definitions/ai-corrections-distill.ts src/jobs/queues.ts src/jobs/schedule.ts src/jobs/worker.ts
git commit -m "feat(ai-training): weekly learn-from-edits distill cron (gated)"
```

> Job handlers aren't unit-tested in this repo; verified by typecheck + the worker booting in dev.

---

## Task 6: Corrections review card + cron toggle on `/ai-training`

**Files:**
- Modify: `src/web/pages/ai-training.tsx`

- [ ] **Step 1: Add the card**

Add a `CorrectionsCard` component (mirrors `CompanyFactsCard`) and render `<CorrectionsCard />` after `<CompanyFactsCard />`. It:
- `useQuery(["ai-corrections"])` → `GET /api/ai-training/corrections`.
- "Learn from my recent edits" button → `POST /api/ai-training/corrections/distill`; show the returned `{proposed, reason}` (e.g. "Proposed 3" or "not enough edited drafts yet").
- For each correction row: show `correction` + `tags` + `status`; buttons — proposed → **Approve** (PATCH status `active`) / **Reject** (PATCH `rejected`); active → **Retire** (PATCH `retired`).
- A cron toggle: reads `ai_corrections_cron_enabled` from the `["app-settings"]` query (already fetched by the page) and PATCHes `/api/app-settings` `{ ai_corrections_cron_enabled: enabled ? "true" : "" }`, invalidating `["app-settings"]`.

```tsx
type Correction = {
  id: string;
  correction: string;
  tags: string[];
  status: "proposed" | "active" | "rejected" | "retired";
};

function CorrectionsCard() {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery<{ corrections: Correction[] }>({
    queryKey: ["ai-corrections"],
    queryFn: async () => {
      const res = await fetch("/api/ai-training/corrections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  const settings = useQuery<{ settings: Record<string, string> }>({
    queryKey: ["app-settings"],
    queryFn: async () => {
      const res = await fetch("/api/app-settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  const cronOn = settings.data?.settings["ai_corrections_cron_enabled"] === "true";

  const onErr = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ai-corrections"] });

  const distill = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ai-training/corrections/distill", { method: "POST" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { proposed: number; reason?: string };
    },
    onSuccess: (r) => {
      setError(null);
      setMsg(r.proposed > 0 ? `Proposed ${r.proposed} correction(s).` : (r.reason ?? "Nothing to propose."));
      invalidate();
    },
    onError: onErr,
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; status: Correction["status"] }) => {
      const res = await fetch(`/api/ai-training/corrections/${v.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: v.status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => { setError(null); invalidate(); },
    onError: onErr,
  });

  const toggleCron = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch("/api/app-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ai_corrections_cron_enabled: next ? "true" : "" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["app-settings"] }),
    onError: onErr,
  });

  const rows = q.data?.corrections ?? [];
  return (
    <Card>
      <CardHeader>Learned corrections</CardHeader>
      <CardBody>
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs text-secondary">
            Distilled from your edits to AI drafts. Approve to inject into future drafts.
          </p>
          <Button variant="secondary" size="sm" loading={distill.isPending} onClick={() => distill.mutate()}>
            Learn from my recent edits
          </Button>
        </div>
        {msg ? <p className="mb-2 text-xs text-secondary">{msg}</p> : null}

        <div className="space-y-2">
          {rows.map((c) => (
            <div key={c.id} className={`flex items-start justify-between gap-3 rounded border border-default p-2 ${c.status === "active" ? "" : "opacity-70"}`}>
              <div className="min-w-0">
                <div className="text-sm">{c.correction}</div>
                <div className="mt-1 text-xs text-secondary">{c.tags.join(", ") || "—"} · {c.status}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                {c.status === "proposed" ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => decide.mutate({ id: c.id, status: "active" })}>Approve</Button>
                    <Button variant="ghost" size="sm" onClick={() => decide.mutate({ id: c.id, status: "rejected" })}>Reject</Button>
                  </>
                ) : c.status === "active" ? (
                  <Button variant="ghost" size="sm" onClick={() => decide.mutate({ id: c.id, status: "retired" })}>Retire</Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <label className="mt-4 flex items-center gap-2 border-t border-default pt-3 text-xs text-secondary">
          <input type="checkbox" checked={cronOn} onChange={(e) => toggleCron.mutate(e.target.checked)} />
          Auto-distill weekly (Monday 8am)
        </label>
        {error ? <p className="mt-2 text-sm text-accent-danger">{error}</p> : null}
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/web/pages/ai-training.tsx
git commit -m "feat(ai-training): learned-corrections review card + weekly-cron toggle"
```

---

## Task 7: Full verification + manual smoke

- [ ] **Step 1: Build + full test suite**

Run: `npm run build && npm test` → build clean; only the 2 pre-existing CRLF failures remain (no new).

- [ ] **Step 2: Apply migration**

Run: `npm run db:migrate` → `0038` adds `ai_learned_corrections`.

- [ ] **Step 3: Smoke**

Edit a few AI chase/cold drafts (via Edit & Send) so draft ≠ sent; on `/ai-training` click "Learn from my recent edits" → proposed corrections appear (or "not enough edited drafts yet" if <3). Approve one → it shows under active and appears in subsequent drafts' system prompt. Toggle the weekly cron on/off → persists.

- [ ] **Step 4: Commit any smoke fixes**

```bash
git add -A && git commit -m "fix(ai-training): Wave C smoke follow-ups"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** #2 capture (Task 3 — joins `ai_proposals.draftedAction.args.body` to `email_log.bodyHtml` via `aiProposalId`), distill quality gate (Task 3 — `pairsWithEdits` drops unchanged/unsent; prompt demands recurring-only + ignore one-off; `MIN_EDITED_PAIRS` cold-start guard), proposed→approve lifecycle (Tasks 4+6), injection (Task 2 via existing `composeSystem`), on-demand + weekly cron triggers (Tasks 4+5+6). Recent-deltas/fold-into-guide lifecycle is operator practice (surfaced in the card copy).
- **Placeholder scan:** complete code for the novel pieces; the cron file-wiring steps (queues/schedule/worker) say "mirror the autopilot-scan block" with the exact repeat snippet given — to be matched against the real files at execution (the agent confirmed the patterns). voice.test.ts updates are described as concrete diffs to the existing mock chains.
- **Type consistency:** `CorrectionStatus`/`status` strings match across schema, endpoints, distiller, and UI; `globalCorrections`/`categoryCorrections` names match `DraftContext`; `runCorrectionsDistill(userId)` signature matches its endpoint + cron callers; `aiLearnedCorrections` columns match schema↔resolver↔distiller↔route.
- **Caveat carried:** `email_log.bodyHtml` is poller-filled (async post-send); the distiller runs well after sends so bodies are present, and `pairsWithEdits` skips null-body pairs defensively.
```
