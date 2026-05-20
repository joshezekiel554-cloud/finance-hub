# AI-Training Suite — Wave A (Voice Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every autopilot draft a Feldart "voice" — a global voice guide (editable in a new /ai-training page) plus a per-category worked-example template — by introducing a shared `buildDraftContext` resolver and refactoring the prompt builders to a cacheable `{ system, user }` split.

**Architecture:** A new `src/modules/ai-agent/voice.ts` resolves a `DraftContext` (Wave A populates `voiceGuide` + `exampleTemplate`; facts/corrections/customerContext are stubbed for Waves B/C). The five prompt builders change from `buildPrompt(summary): string` to `buildPrompt(summary, context): { system, user }`. The draft endpoint (`routes/autopilot.ts`) calls `buildDraftContext`, passes the result to the builder, and sends `system` as a `cache_control: ephemeral` block (omitted when empty). The voice guide lives in the existing `app_settings` KV table (no migration) and is read/written through the existing `/api/app-settings` route; a new `/api/ai-training` route adds "regenerate". A one-shot `scripts/seed-voice-guide.ts` distills v1 from real emails.

**Tech Stack:** Fastify v5, TypeScript (strict), Drizzle ORM (MySQL 8), `@anthropic-ai/sdk` (Sonnet 4.6, prompt caching), Vite + React 18 + TanStack Query/Router, vitest.

**Scope note:** This is Wave A of a 3-wave suite (spec: `docs/superpowers/specs/2026-05-20-ai-training-suite-design.md`). Waves B (#3 facts + #4 per-customer) and C (#2 learn-from-edits) get their own plans authored after this wave lands. The `DraftContext` type is defined in full here so later waves only fill in fields, not reshape the interface.

---

## File Structure

**Create:**
- `src/modules/ai-agent/voice.ts` — `DEFAULT_VOICE_GUIDE`, `DraftContext`, `BuiltPrompt`, `buildDraftContext()`.
- `src/modules/ai-agent/voice.test.ts` — unit tests for the resolver.
- `src/modules/ai-agent/prompts/system-param.ts` — `toSystemParam()` helper (wrap a system string into the Anthropic blocks array, or `undefined`).
- `src/modules/ai-agent/prompts/system-param.test.ts` — unit tests for the helper.
- `src/server/routes/ai-training.ts` — `POST /api/ai-training/voice-guide/regenerate`.
- `scripts/seed-voice-guide.ts` — one-shot v1 seed.
- `src/modules/ai-agent/voice-seed.ts` — `buildSeedPrompt()` pure helper + `runVoiceGuideSeed()` (shared by the script and the regenerate endpoint).
- `src/modules/ai-agent/voice-seed.test.ts` — unit tests for `buildSeedPrompt()`.
- `src/web/pages/ai-training.tsx` — the AI Training page with the Voice Guide card.

**Modify:**
- `src/db/schema/app-settings.ts` — add `ai_voice_guide` + `ai_corrections_cron_enabled` to `APP_SETTING_KEYS`.
- `src/modules/ai-agent/prompts/chase-next.ts` — new signature + system/user split.
- `src/modules/ai-agent/prompts/cadence-cold.ts` — same.
- `src/modules/ai-agent/prompts/cadence-statement.ts` — same.
- `src/modules/ai-agent/prompts/ops-rma-stalled.ts` — same (voice only on warehouse branch).
- `src/modules/ai-agent/prompts/ops-cron-fail.ts` — same (ignores context; empty system).
- `src/server/routes/autopilot.ts` — `PROMPTS` type + draft loop wiring + `system` block.
- `src/server/routes/index.ts` — register the new `/api/ai-training` route.
- `src/web/main.tsx` — register the `/ai-training` route.
- `src/web/App.tsx` — add the nav item.
- `package.json` — add the `seed:voice-guide` script.

---

## Task 1: Voice resolver — `DEFAULT_VOICE_GUIDE`, types, and `buildDraftContext`

**Files:**
- Create: `src/modules/ai-agent/voice.ts`
- Test: `src/modules/ai-agent/voice.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/ai-agent/voice.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ db: { select: vi.fn() } }));

import { db } from "../../db/index.js";
import { buildDraftContext, DEFAULT_VOICE_GUIDE } from "./voice.js";

type Mock = ReturnType<typeof vi.fn>;

// Drizzle chain stub: .from().where().limit() resolves to `rows`.
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = () => c;
  c.limit = () => Promise.resolve(rows);
  return c;
}

beforeEach(() => {
  (db.select as Mock).mockReset();
});

describe("buildDraftContext", () => {
  it("falls back to DEFAULT_VOICE_GUIDE when the row is unset", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([])) // app_settings: no row
      .mockReturnValueOnce(chain([{ body: "L3 BODY" }])); // template
    const ctx = await buildDraftContext("chase_next", { tier: "CRITICAL" }, null);
    expect(ctx.voiceGuide).toBe(DEFAULT_VOICE_GUIDE);
  });

  it("uses the stored guide when present and non-empty", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "CUSTOM GUIDE" }]))
      .mockReturnValueOnce(chain([{ body: "L1 BODY" }]));
    const ctx = await buildDraftContext("chase_next", { tier: "MEDIUM" }, null);
    expect(ctx.voiceGuide).toBe("CUSTOM GUIDE");
  });

  it("maps chase tier CRITICAL -> chase_l3 body", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }]))
      .mockReturnValueOnce(chain([{ body: "L3 BODY" }]));
    const ctx = await buildDraftContext("chase_next", { tier: "CRITICAL" }, null);
    expect(ctx.exampleTemplate).toBe("L3 BODY");
  });

  it("returns null example for cadence_cold (no template) and never queries templates", async () => {
    (db.select as Mock).mockReturnValueOnce(chain([{ value: "G" }]));
    const ctx = await buildDraftContext("cadence_cold", {}, null);
    expect(ctx.exampleTemplate).toBeNull();
    expect((db.select as Mock).mock.calls.length).toBe(1); // only the voice-guide query
  });

  it("stubs facts/corrections/customerContext for later waves", async () => {
    (db.select as Mock).mockReturnValueOnce(chain([{ value: "G" }]));
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_123");
    expect(ctx.globalFacts).toEqual([]);
    expect(ctx.categoryFacts).toEqual([]);
    expect(ctx.globalCorrections).toEqual([]);
    expect(ctx.categoryCorrections).toEqual([]);
    expect(ctx.customerContext).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/ai-agent/voice.test.ts`
Expected: FAIL — `Cannot find module './voice.js'` / `buildDraftContext is not a function`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/ai-agent/voice.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import type { AiProposalCategory } from "../../db/schema/ai-proposals.js";

// Baked-in fallback so drafts have a Feldart voice before the operator
// seeds/customizes app_settings.ai_voice_guide.
export const DEFAULT_VOICE_GUIDE = `Feldart is a family-run trade supplier. Our accounts team writes to customers directly, in the first person plural ("we"), as real people who know the account.

Tone: warm, direct, professional. Friendly but not chatty; firm when needed but never aggressive. Assume good faith — most late payments are oversights, not bad actors. Match the seriousness of the situation: a first reminder is light and assumes the invoice slipped through; an escalation is clear and states consequences plainly, without threats or legal language.

Phrasing: plain British business English. Short paragraphs (2-4 sentences). No marketing language, no buzzwords, no exclamation marks. Reference specific invoice numbers and amounts. Always give the customer a clear, easy next step (a reply, a payment date, a call).

Sign-off: close warmly and sign as "The Feldart Accounts Team". The signature block is appended automatically — do not add one. Avoid "Dear Sir/Madam"; use the contact's name or a simple "Hello".

Never: threaten legal action unless explicitly escalated, use guilt or passive-aggression, send a wall of text, or invent facts about the account.`;

// Resolved context fed into a draft. Wave A populates voiceGuide +
// exampleTemplate; the array fields and customerContext are filled by
// Wave B (#3 facts, #4 per-customer) and Wave C (#2 corrections).
export type DraftContext = {
  voiceGuide: string;
  globalFacts: string[];
  categoryFacts: string[];
  globalCorrections: string[];
  categoryCorrections: string[];
  customerContext: string | null;
  exampleTemplate: string | null;
};

// What every prompt builder returns. `system` is the cacheable prefix
// (role + voice guide, later + facts/corrections); `user` varies per
// candidate. Empty `system` => the endpoint sends no system block.
export type BuiltPrompt = { system: string; user: string };

const CHASE_TIER_SLUG: Record<string, string> = {
  MEDIUM: "chase_l1",
  HIGH: "chase_l2",
  CRITICAL: "chase_l3",
};

function exampleSlugFor(
  category: AiProposalCategory,
  summary: Record<string, unknown>,
): string | null {
  if (category === "chase_next") {
    const tier = String(summary.tier ?? "");
    return CHASE_TIER_SLUG[tier] ?? null;
  }
  // cadence_cold (no check-in template), cadence_statement, ops_* -> none.
  return null;
}

export async function buildDraftContext(
  category: AiProposalCategory,
  summary: Record<string, unknown>,
  _customerId: string | null,
): Promise<DraftContext> {
  const guideRows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_voice_guide"))
    .limit(1);
  const stored = guideRows[0]?.value;
  const voiceGuide = stored && stored.trim().length > 0 ? stored : DEFAULT_VOICE_GUIDE;

  let exampleTemplate: string | null = null;
  const slug = exampleSlugFor(category, summary);
  if (slug) {
    const tplRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, slug))
      .limit(1);
    exampleTemplate = tplRows[0]?.body ?? null;
  }

  return {
    voiceGuide,
    globalFacts: [],
    categoryFacts: [],
    globalCorrections: [],
    categoryCorrections: [],
    customerContext: null, // Wave B (#4) populates from customers.ai_customer_context
    exampleTemplate,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/ai-agent/voice.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-agent/voice.ts src/modules/ai-agent/voice.test.ts
git commit -m "feat(ai-training): voice resolver + DEFAULT_VOICE_GUIDE (Wave A)"
```

---

## Task 2: Register the new app_settings keys

**Files:**
- Modify: `src/db/schema/app-settings.ts:37-72` (the `APP_SETTING_KEYS` array)

- [ ] **Step 1: Add the keys**

In `src/db/schema/app-settings.ts`, add two entries to the `APP_SETTING_KEYS` array (before the closing `] as const;`):

```ts
  // AI voice/style guide consumed by autopilot draft prompts. Free prose,
  // editable on the /ai-training page; seeded by scripts/seed-voice-guide.ts.
  "ai_voice_guide",
  // "true"/"" flag — enables the weekly learn-from-edits distill cron
  // (Wave C). Default off; added now so the KV key is recognized.
  "ai_corrections_cron_enabled",
```

This makes the voice guide readable via `GET /api/app-settings` and writable via `PATCH /api/app-settings` (the route validates keys against this array — see `routes/app-settings.ts:85`).

- [ ] **Step 2: Verify the typecheck/build passes**

Run: `npm run build`
Expected: success, no TypeScript errors. (`AppSettingKey` now includes the two new literals.)

- [ ] **Step 3: Commit**

```bash
git add src/db/schema/app-settings.ts
git commit -m "feat(ai-training): register ai_voice_guide + cron-flag app_settings keys"
```

---

## Task 3: `toSystemParam` helper (cache_control wrapping)

**Files:**
- Create: `src/modules/ai-agent/prompts/system-param.ts`
- Test: `src/modules/ai-agent/prompts/system-param.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/ai-agent/prompts/system-param.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toSystemParam } from "./system-param.js";

describe("toSystemParam", () => {
  it("returns undefined for empty/whitespace system text", () => {
    expect(toSystemParam("")).toBeUndefined();
    expect(toSystemParam("   \n ")).toBeUndefined();
  });

  it("wraps non-empty text in one ephemeral-cached text block", () => {
    const out = toSystemParam("ROLE + GUIDE");
    expect(out).toEqual([
      { type: "text", text: "ROLE + GUIDE", cache_control: { type: "ephemeral" } },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/ai-agent/prompts/system-param.test.ts`
Expected: FAIL — `Cannot find module './system-param.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/ai-agent/prompts/system-param.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";

// Wrap a system prompt string into the Anthropic `system` param as a single
// cacheable text block. Returns undefined when there's nothing to send, so
// the caller omits the system field entirely (internal builders with no
// voice context). NOTE: Anthropic only caches a prefix once it exceeds the
// model minimum (~1024 tokens for Sonnet). Below that the block is sent but
// not cached — harmless; savings kick in once Waves B/C grow the prefix.
export function toSystemParam(
  system: string,
): Anthropic.Messages.TextBlockParam[] | undefined {
  if (!system || system.trim().length === 0) return undefined;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/ai-agent/prompts/system-param.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-agent/prompts/system-param.ts src/modules/ai-agent/prompts/system-param.test.ts
git commit -m "feat(ai-training): toSystemParam cache_control helper"
```

---

## Task 4: Refactor `chase-next` builder to `{ system, user }`

**Files:**
- Modify: `src/modules/ai-agent/prompts/chase-next.ts`
- Test: `src/modules/ai-agent/prompts/chase-next.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/modules/ai-agent/prompts/chase-next.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt } from "./chase-next.js";
import type { DraftContext } from "../voice.js";

const ctx: DraftContext = {
  voiceGuide: "VOICE_GUIDE_MARKER",
  globalFacts: [],
  categoryFacts: [],
  globalCorrections: [],
  categoryCorrections: [],
  customerContext: null,
  exampleTemplate: "EXAMPLE_TEMPLATE_MARKER",
};

const summary = {
  customerId: "c1",
  customerName: "On The Table NJ",
  overdueBalance: 1234.5,
  daysOverdue: 45,
  tier: "CRITICAL",
  lastChaseAt: null,
};

describe("chase-next buildPrompt", () => {
  it("puts role + voice guide in system", () => {
    const { system } = buildPrompt(summary, ctx);
    expect(system).toContain("VOICE_GUIDE_MARKER");
    expect(system).toContain("Feldart");
  });

  it("puts the situation + example in user, not system", () => {
    const { system, user } = buildPrompt(summary, ctx);
    expect(user).toContain("On The Table NJ");
    expect(user).toContain("EXAMPLE_TEMPLATE_MARKER");
    expect(system).not.toContain("EXAMPLE_TEMPLATE_MARKER");
  });

  it("omits the example block when exampleTemplate is null", () => {
    const { user } = buildPrompt(summary, { ...ctx, exampleTemplate: null });
    expect(user).not.toContain("reference email");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/ai-agent/prompts/chase-next.test.ts`
Expected: FAIL — `buildPrompt` returns a string, so `.system` is undefined / type error.

- [ ] **Step 3: Rewrite the builder**

Replace the body of `src/modules/ai-agent/prompts/chase-next.ts` (keep `TOOL_NAME`, `ChaseSummary`, `TONE_INSTRUCTIONS`, `formatCurrency`, `formatLastChase` exactly as-is) — change only `buildPrompt`:

```ts
import type { BuiltPrompt, DraftContext } from "../voice.js";

// ...existing TOOL_NAME, ChaseSummary, TONE_INSTRUCTIONS, formatCurrency,
// formatLastChase unchanged...

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const s = summary as ChaseSummary;

  const system = `You are the accounts team at Feldart, preparing a chase email for an overdue customer account.

## How Feldart writes
${context.voiceGuide}`;

  const exampleBlock = context.exampleTemplate
    ? `\n## Reference email to match the tone of\n${context.exampleTemplate}\n`
    : "";

  const user = `## Account situation
Customer: ${s.customerName} (ID: ${s.customerId})
Overdue balance: ${formatCurrency(s.overdueBalance)}
Days overdue: ${s.daysOverdue}
Severity tier: ${s.tier}
${formatLastChase(s.lastChaseAt)}
${exampleBlock}
## Tone instructions
${TONE_INSTRUCTIONS[s.tier]}

## Your task
Call the \`${TOOL_NAME}\` tool with:
- customerId: "${s.customerId}"
- tier: "${s.tier}"
- subject: a concise subject line matching the tier's urgency
- body: an HTML email body of 3-5 short paragraphs. Use <p> tags. Adapt the
  reference email and Feldart voice above to this customer's situation. Do
  NOT include a signature block — it is appended automatically.

## Skip condition
If the account situation clearly indicates the customer has already paid or a
chase would be inappropriate (e.g. daysOverdue is 0 or balance is 0), return
plain JSON instead of calling the tool:
{"skip": true, "reason": "<one sentence>"}

Act now.`;

  return { system, user };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/ai-agent/prompts/chase-next.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-agent/prompts/chase-next.ts src/modules/ai-agent/prompts/chase-next.test.ts
git commit -m "refactor(ai-training): chase-next builder -> {system,user} with voice"
```

---

## Task 5: Refactor `cadence-cold` and `cadence-statement` builders

**Files:**
- Modify: `src/modules/ai-agent/prompts/cadence-cold.ts`
- Modify: `src/modules/ai-agent/prompts/cadence-statement.ts`
- Test: `src/modules/ai-agent/prompts/cadence-cold.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/modules/ai-agent/prompts/cadence-cold.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt as buildCold } from "./cadence-cold.js";
import { buildPrompt as buildStatement } from "./cadence-statement.js";
import type { DraftContext } from "../voice.js";

const ctx: DraftContext = {
  voiceGuide: "VOICE_MARK",
  globalFacts: [], categoryFacts: [], globalCorrections: [],
  categoryCorrections: [], customerContext: null, exampleTemplate: null,
};

describe("cadence builders", () => {
  it("cold: voice in system, customer in user", () => {
    const { system, user } = buildCold(
      { customerName: "Acme", openBalance: 500, daysSinceLastPayment: 60, daysSinceLastContact: 30 },
      ctx,
    );
    expect(system).toContain("VOICE_MARK");
    expect(user).toContain("Acme");
  });

  it("statement: voice in system, customer in user", () => {
    const { system, user } = buildStatement(
      { customerName: "Acme", openInvoiceCount: 3, totalOpenBalance: 900, lastStatementSentAt: null, daysSinceLastStatement: 99999 },
      ctx,
    );
    expect(system).toContain("VOICE_MARK");
    expect(user).toContain("Acme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/ai-agent/prompts/cadence-cold.test.ts`
Expected: FAIL — builders still return strings.

- [ ] **Step 3: Rewrite `cadence-cold.ts`**

Replace `buildPrompt` in `src/modules/ai-agent/prompts/cadence-cold.ts` (keep `TOOL_NAME` + `ColdSummary` + the `paymentLabel`/`contactLabel` logic):

```ts
import type { BuiltPrompt, DraftContext } from "../voice.js";

// ...existing TOOL_NAME + ColdSummary unchanged...

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const s = summary as ColdSummary;
  const paymentLabel =
    s.daysSinceLastPayment >= 99999
      ? "no payment on record"
      : `last payment ${s.daysSinceLastPayment} days ago`;
  const contactLabel =
    s.daysSinceLastContact >= 99999
      ? "no prior contact on record"
      : `last contact ${s.daysSinceLastContact} days ago`;

  const system = `You are an accounts assistant at Feldart deciding whether to send a gentle check-in email to a customer who has gone quiet.

## How Feldart writes
${context.voiceGuide}`;

  const user = `Customer: ${s.customerName}
Open balance: $${s.openBalance.toFixed(2)}
Payment activity: ${paymentLabel}
Contact activity: ${contactLabel}

Context: This customer has an outstanding balance but has not paid or been contacted in a while. The goal is NOT to chase or pressure — check in warmly, acknowledge the silence without passive-aggression, and open a door in case there is anything they need or any reason for the gap.

Rules:
- Skip if the open balance is trivially small (under ~$150). Respond with JSON only: {"skip": true, "reason": "<one sentence>"}
- Skip if context suggests this is not the right moment (e.g. very recent first contact).
- If you send: warm and low-pressure. Do not mention overdue, chase, or demand. Assume good faith.

If you decide to send: call the \`${TOOL_NAME}\` tool with:
  - \`customerId\`: you will receive this from the system context
  - \`subject\`: a friendly, non-alarming subject line (e.g. "Checking in — ${s.customerName} account")
  - \`body\`: HTML, 3 short paragraphs: (1) warm greeting + light reason for reaching out; (2) acknowledge you haven't connected in a bit, ask if all is well or anything is needed; (3) soft reference to the open balance, offer to answer invoice questions, friendly close.

If you decide to skip: respond with plain JSON only — no tool call:
  {"skip": true, "reason": "<one sentence>"}

Do not explain your reasoning outside of the skip reason. Act directly.`;

  return { system, user };
}
```

- [ ] **Step 4: Rewrite `cadence-statement.ts`**

Replace `buildPrompt` in `src/modules/ai-agent/prompts/cadence-statement.ts` (keep `TOOL_NAME` + `StatementSummary` + the `lastSent` logic):

```ts
import type { BuiltPrompt, DraftContext } from "../voice.js";

// ...existing TOOL_NAME + StatementSummary unchanged...

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const s = summary as StatementSummary;
  const lastSent = s.lastStatementSentAt
    ? `last sent ${s.daysSinceLastStatement} days ago`
    : "never sent a statement";

  const system = `You are an accounts assistant at Feldart deciding whether to send a statement of open invoices to a customer, and writing the short cover note that accompanies it.

## How Feldart writes
${context.voiceGuide}`;

  const user = `Customer: ${s.customerName}
Open invoices: ${s.openInvoiceCount}
Total open balance: $${s.totalOpenBalance.toFixed(2)}
Statement history: ${lastSent}

Decide whether sending a statement is worthwhile right now.

Rules:
- Skip if the balance is trivially small (under ~$100) and the relationship seems low-priority.
- Skip if a statement was sent very recently (under 14 days) and nothing material has changed.
- Prefer sending when balance is significant or there are multiple open invoices.

If you decide to send: call the \`${TOOL_NAME}\` tool with:
  - \`customerId\`: you will receive this from the system context
  - \`coverNote\` (optional): a single short sentence in the Feldart voice, e.g. "Hi ${s.customerName}, please find attached your current statement of open invoices."

If you decide to skip: respond with plain JSON only — no tool call:
  {"skip": true, "reason": "<one sentence>"}

Do not explain your reasoning outside of the skip reason. Act directly.`;

  return { system, user };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/ai-agent/prompts/cadence-cold.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai-agent/prompts/cadence-cold.ts src/modules/ai-agent/prompts/cadence-statement.ts src/modules/ai-agent/prompts/cadence-cold.test.ts
git commit -m "refactor(ai-training): cadence-cold + cadence-statement builders -> {system,user}"
```

---

## Task 6: Refactor `ops-rma-stalled` (warehouse-only voice) and `ops-cron-fail` (no context)

**Files:**
- Modify: `src/modules/ai-agent/prompts/ops-rma-stalled.ts`
- Modify: `src/modules/ai-agent/prompts/ops-cron-fail.ts`
- Test: `src/modules/ai-agent/prompts/ops-rma-stalled.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/modules/ai-agent/prompts/ops-rma-stalled.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt as buildRma } from "./ops-rma-stalled.js";
import { buildPrompt as buildCron } from "./ops-cron-fail.js";
import type { DraftContext } from "../voice.js";

const ctx: DraftContext = {
  voiceGuide: "VOICE_MARK",
  globalFacts: [], categoryFacts: [], globalCorrections: [],
  categoryCorrections: [], customerContext: null, exampleTemplate: null,
};

describe("ops builders", () => {
  it("rma warehouse branch includes voice in system", () => {
    const { system, user } = buildRma(
      { rmaNumber: "RMA-1", customerName: "Acme", status: "sent_to_warehouse", daysInState: 20 },
      ctx,
    );
    expect(system).toContain("VOICE_MARK");
    expect(user).toContain("RMA-1");
  });

  it("rma admin branch sends NO system (internal notification)", () => {
    const { system } = buildRma(
      { rmaNumber: "RMA-2", customerName: "Acme", status: "needs_review", daysInState: 30 },
      ctx,
    );
    expect(system).toBe("");
  });

  it("cron-fail ignores context and sends NO system", () => {
    const { system, user } = buildCron(
      { jobKind: "qb_full", lastFailureAt: new Date().toISOString(), lastErrorExcerpt: "boom" },
      ctx,
    );
    expect(system).toBe("");
    expect(user).toContain("qb_full");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/ai-agent/prompts/ops-rma-stalled.test.ts`
Expected: FAIL — builders return strings.

- [ ] **Step 3: Rewrite `ops-rma-stalled.ts`**

Replace `buildPrompt` in `src/modules/ai-agent/prompts/ops-rma-stalled.ts` (keep `TOOL_NAMES` + `OpRmaStalledSummary` + `warehouseStatuses`):

```ts
import type { BuiltPrompt, DraftContext } from "../voice.js";

// ...existing TOOL_NAMES + OpRmaStalledSummary unchanged...

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const { rmaNumber, customerName, status, daysInState } =
    summary as OpRmaStalledSummary;

  const warehouseStatuses = ["sent_to_warehouse", "awaiting_warehouse_number"];
  const isWarehouseCase = warehouseStatuses.includes(status);

  // Warehouse branch writes an outbound email -> Feldart voice. Admin
  // branch writes an internal notification -> no voice context.
  const system = isWarehouseCase
    ? `You are an operations assistant at Feldart writing a brief warehouse nudge email.

## How Feldart writes
${context.voiceGuide}`
    : "";

  const user = isWarehouseCase
    ? `RMA ${rmaNumber} for ${customerName} has been stuck in status "${status}" for ${daysInState} days.

Call \`nudge_warehouse_email\` with:
- rmaId: the RMA's database ID
- subject: "RMA ${rmaNumber} status check"
- body: a brief, factual message (2-4 sentences) stating the RMA number, customer name, current status, how many days it has been waiting, and asking for an update on next steps.

If context clearly indicates no action is needed, return exactly:
{"skip": true, "reason": "<brief reason>"}

Be concise. Do not add preamble or explanation outside the tool call or skip response.`
    : `You are an operations assistant reviewing a stalled RMA.

RMA ${rmaNumber} for ${customerName} has been stuck in status "${status}" for ${daysInState} days.

Call \`create_admin_notification\` with:
- title: "RMA ${rmaNumber} needs attention"
- message: a sentence describing the current state ("${status}") and the operator action required to move it forward
- severity: "warning"

If context clearly indicates no action is needed, return exactly:
{"skip": true, "reason": "<brief reason>"}

Be concise. Do not add preamble or explanation outside the tool call or skip response.`;

  return { system, user };
}
```

- [ ] **Step 4: Rewrite `ops-cron-fail.ts`**

In `src/modules/ai-agent/prompts/ops-cron-fail.ts`, keep everything (TOOL_NAME, INVESTIGATION_HINTS, TRANSIENT_PATTERNS, helpers) and change only the `buildPrompt` signature + return. The body becomes the `user`; `system` is empty. Add the import and wrap the existing returned string:

```ts
import type { BuiltPrompt, DraftContext } from "../voice.js";

// ...existing TOOL_NAME, INVESTIGATION_HINTS, TRANSIENT_PATTERNS,
// isLikelyTransient, relativeTime unchanged...

export function buildPrompt(
  summary: Record<string, unknown>,
  _context: DraftContext,
): BuiltPrompt {
  const s = summary as CronFailSummary;
  const hint = INVESTIGATION_HINTS[s.jobKind];
  const when = relativeTime(s.lastFailureAt);
  const transientNote = isLikelyTransient(s.lastErrorExcerpt)
    ? "\n\nNote: the error pattern looks potentially transient (rate limit / network reset). You MAY skip with reason if you believe it will self-resolve."
    : "";

  const user = `You are an ops assistant monitoring background cron jobs.

Job: ${s.jobKind}
Failed twice in a row. Last failure: ${when} (${s.lastFailureAt})
Error excerpt (first 500 chars):
---
${s.lastErrorExcerpt}
---
${transientNote}

Call the \`${TOOL_NAME}\` tool with:
  - title: "[Cron] ${s.jobKind} failed twice"
  - message: a 2-3 sentence summary covering which job failed, since when, the key part of the error, and this suggested next step: "${hint}"
  - severity: "warning"

Failed crons almost always warrant a notification. Only skip if the error is clearly transient and very likely to self-resolve on the next run.

If you decide to skip: respond with plain JSON only — no tool call:
  {"skip": true, "reason": "<one sentence>"}

Do not explain your reasoning outside of the skip reason. Act directly.`;

  return { system: "", user };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/ai-agent/prompts/ops-rma-stalled.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai-agent/prompts/ops-rma-stalled.ts src/modules/ai-agent/prompts/ops-cron-fail.ts src/modules/ai-agent/prompts/ops-rma-stalled.test.ts
git commit -m "refactor(ai-training): ops builders -> {system,user} (warehouse voice only)"
```

---

## Task 7: Wire `buildDraftContext` + system block into the draft endpoint

**Files:**
- Modify: `src/server/routes/autopilot.ts:66-84` (PROMPTS type) and `:206-216` (the create call)

- [ ] **Step 1: Update the `PROMPTS` builder type**

In `src/server/routes/autopilot.ts`, change the `PROMPTS` map type (line 66-72). The `build` signature now takes a context and returns `{ system, user }`:

```ts
import { buildDraftContext, type BuiltPrompt, type DraftContext } from "../../modules/ai-agent/voice.js";
import { toSystemParam } from "../../modules/ai-agent/prompts/system-param.js";

const PROMPTS: Record<
  AiProposalCategory,
  {
    build: (s: Record<string, unknown>, ctx: DraftContext) => BuiltPrompt;
    toolNames: string[];
  }
> = {
  // ...entries unchanged (chase_next, cadence_statement, cadence_cold,
  // ops_rma_stalled, ops_cron_fail) — only the build *type* changed...
};
```

(The five `build:` entries stay as-is — each now matches the new signature after Tasks 4-6.)

- [ ] **Step 2: Resolve context and pass system/user in the draft loop**

Replace the `anthropic.messages.create({...})` block (`src/server/routes/autopilot.ts:206-216`) with:

```ts
            const customerId =
              p.entityType === "customer" ? p.entityId : null;
            const context = await buildDraftContext(
              cat,
              p.candidateSummary as Record<string, unknown>,
              customerId,
            );
            const built = prompt.build(
              p.candidateSummary as Record<string, unknown>,
              context,
            );
            const systemParam = toSystemParam(built.system);

            const response = await anthropic.messages.create({
              model: SONNET,
              max_tokens: 2000,
              tools,
              ...(systemParam ? { system: systemParam } : {}),
              messages: [{ role: "user", content: built.user }],
            });
```

(`cat` and `prompt` are already in scope from lines 176-177. `p.entityType` / `p.entityId` exist on the proposal row — see `ai-proposals.ts:41-42`. The `customer` entity check is best-effort for Wave A; `customerContext` is unused until Wave B, so a wrong/null value here is harmless.)

- [ ] **Step 3: Verify the build passes**

Run: `npm run build`
Expected: success. Confirms the new builder signatures, the PROMPTS type, and the create-call all line up across the codebase.

- [ ] **Step 4: Run the full prompt + helper test suite**

Run: `npm test -- src/modules/ai-agent`
Expected: PASS — all voice/builder/helper tests green.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/autopilot.ts
git commit -m "feat(ai-training): draft endpoint resolves DraftContext + cached system block"
```

---

## Task 8: Voice-guide seed — pure prompt builder + runner

**Files:**
- Create: `src/modules/ai-agent/voice-seed.ts`
- Test: `src/modules/ai-agent/voice-seed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/ai-agent/voice-seed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSeedPrompt } from "./voice-seed.js";

describe("buildSeedPrompt", () => {
  it("includes template bodies and outbound email bodies", () => {
    const prompt = buildSeedPrompt(
      [{ slug: "chase_l1", body: "TEMPLATE_BODY_1" }],
      ["EMAIL_BODY_1", "EMAIL_BODY_2"],
    );
    expect(prompt).toContain("TEMPLATE_BODY_1");
    expect(prompt).toContain("EMAIL_BODY_1");
    expect(prompt).toContain("EMAIL_BODY_2");
  });

  it("instructs a concise prose guide under 600 words", () => {
    const prompt = buildSeedPrompt([], []);
    expect(prompt.toLowerCase()).toContain("voice");
    expect(prompt).toContain("600");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/ai-agent/voice-seed.test.ts`
Expected: FAIL — `Cannot find module './voice-seed.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/ai-agent/voice-seed.ts`:

```ts
import { desc, eq, isNotNull, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import { emailLog } from "../../db/schema/crm.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";

const log = createLogger({ module: "ai-agent.voice-seed" });
const SONNET = "claude-sonnet-4-6";

// Pure: assemble the distillation prompt from real Feldart content.
export function buildSeedPrompt(
  templates: Array<{ slug: string; body: string }>,
  emailBodies: string[],
): string {
  const tpl = templates
    .map((t) => `### Template: ${t.slug}\n${t.body}`)
    .join("\n\n");
  const mails = emailBodies
    .map((b, i) => `### Sent email ${i + 1}\n${b}`)
    .join("\n\n");
  return `Distill a concise voice/style guide from these real Feldart accounts emails and templates.

Capture: tone, common phrasings, sign-offs, sentence length, formality, and things they always/never do. Output the guide as prose (no preamble, no headings list), under 600 words. Write it as instructions a writer could follow to sound like Feldart.

## Templates
${tpl || "(none)"}

## Recent sent emails
${mails || "(none)"}`;
}

// Side-effecting: gather inputs, call the model, upsert the guide.
export async function runVoiceGuideSeed(userId: string | null): Promise<{ words: number }> {
  const templates = await db
    .select({ slug: emailTemplates.slug, body: emailTemplates.body })
    .from(emailTemplates);
  const emails = await db
    .select({ body: emailLog.body })
    .from(emailLog)
    .where(and(eq(emailLog.direction, "outbound"), isNotNull(emailLog.body)))
    .orderBy(desc(emailLog.emailDate))
    .limit(30);
  const emailBodies = emails.map((e) => e.body ?? "").filter((b) => b.length > 0);

  const prompt = buildSeedPrompt(templates, emailBodies);
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: SONNET,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  await trackUsage(response, { surface: "background_proposing", userId });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();

  const existing = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_voice_guide"))
    .limit(1);
  if (existing[0]) {
    await db
      .update(appSettings)
      .set({ value: text, updatedByUserId: userId, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(appSettings.key, "ai_voice_guide"));
  } else {
    await db.insert(appSettings).values({
      key: "ai_voice_guide",
      value: text,
      updatedByUserId: userId,
    });
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  log.info({ words }, "voice guide seeded");
  return { words };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/ai-agent/voice-seed.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-agent/voice-seed.ts src/modules/ai-agent/voice-seed.test.ts
git commit -m "feat(ai-training): voice-guide seed prompt builder + runner"
```

---

## Task 9: One-shot seed script + npm script

**Files:**
- Create: `scripts/seed-voice-guide.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the script**

Create `scripts/seed-voice-guide.ts`:

```ts
import { runVoiceGuideSeed } from "../src/modules/ai-agent/voice-seed.js";

async function main() {
  const { words } = await runVoiceGuideSeed(null);
  console.log(`Voice guide seeded (${words} words). Edit it at /ai-training.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to the `scripts` block (next to the other `seed:*` entries):

```json
"seed:voice-guide": "tsx scripts/seed-voice-guide.ts",
```

- [ ] **Step 3: Verify it builds/typechecks**

Run: `npm run build`
Expected: success. (Do NOT run the seed here — it makes a live Anthropic + DB call; that happens at rollout per the Manual Smoke section.)

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-voice-guide.ts package.json
git commit -m "feat(ai-training): seed-voice-guide one-shot script"
```

---

## Task 10: Regenerate endpoint (`/api/ai-training`)

**Files:**
- Create: `src/server/routes/ai-training.ts`
- Modify: `src/server/routes/index.ts` (register at `/api/ai-training`)

- [ ] **Step 1: Write the route**

Create `src/server/routes/ai-training.ts`:

```ts
// AI-training routes.
//
//   POST /api/ai-training/voice-guide/regenerate — re-distill the voice
//     guide from templates + recent outbound emails (overwrites the
//     app_settings.ai_voice_guide row; warns in the UI before calling).
//
// Mounting: registered in src/server/routes/index.ts at /api/ai-training.

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../lib/auth.js";
import { runVoiceGuideSeed } from "../../modules/ai-agent/voice-seed.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.ai-training" });

const aiTrainingRoute: FastifyPluginAsync = async (app) => {
  app.post("/voice-guide/regenerate", async (req, reply) => {
    const user = await requireAuth(req);
    try {
      const { words } = await runVoiceGuideSeed(user.id);
      return reply.send({ ok: true, words });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "voice guide regenerate failed");
      return reply.code(500).send({ error: "regenerate failed", detail: msg });
    }
  });
};

export default aiTrainingRoute;
```

- [ ] **Step 2: Register the route**

In `src/server/routes/index.ts`, follow the existing registration pattern (mirror how `app-settings` / `autopilot` are registered) to mount `aiTrainingRoute` at prefix `/api/ai-training`. Add the import and the `app.register(aiTrainingRoute, { prefix: "/api/ai-training" })` call alongside the others.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/ai-training.ts src/server/routes/index.ts
git commit -m "feat(ai-training): POST /voice-guide/regenerate endpoint"
```

---

## Task 11: AI Training page + Voice Guide card + route + nav

**Files:**
- Create: `src/web/pages/ai-training.tsx`
- Modify: `src/web/main.tsx` (route), `src/web/App.tsx` (nav item)

- [ ] **Step 1: Write the page**

Create `src/web/pages/ai-training.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";

type AppSettingsResponse = { settings: Record<string, string> };

export default function AiTrainingPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery<AppSettingsResponse>({
    queryKey: ["app-settings"],
    queryFn: async () => {
      const res = await fetch("/api/app-settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  useEffect(() => {
    if (settingsQuery.data) setDraft(settingsQuery.data.settings["ai_voice_guide"] ?? "");
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/app-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ai_voice_guide: draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as AppSettingsResponse;
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const regenMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ai-training/voice-guide/regenerate", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { ok: boolean; words: number };
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI Training</h1>
        <p className="mt-1 text-sm text-secondary">
          Teach autopilot how Feldart writes. The voice guide is injected into every AI draft.
        </p>
      </div>

      <Card>
        <CardHeader>Voice guide</CardHeader>
        <CardBody>
          <textarea
            className="w-full min-h-[320px] rounded border border-default bg-transparent p-3 font-mono text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Loading…"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-secondary">{draft.length} characters</span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={regenMutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Regenerate overwrites the current guide (including manual edits) from your templates + recent emails. Continue?",
                    )
                  )
                    regenMutation.mutate();
                }}
              >
                Regenerate from my emails
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                Save
              </Button>
            </div>
          </div>
          {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
          <p className="mt-3 text-xs text-secondary">
            Worked-example templates are wired for chase emails (L1/L2/L3 by
            severity). Cold check-ins and statements use the voice guide alone
            until a matching template exists.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
```

(If the Card subcomponents are named differently than `CardBody`/`CardHeader`, match `src/web/components/ui/card.tsx` exactly. If `Button` lacks a `loading` prop, use `disabled={mutation.isPending}`.)

- [ ] **Step 2: Register the route**

In `src/web/main.tsx`: import the page and add the route, mirroring the `/autopilot` registration:

```tsx
import AiTrainingPage from "./pages/ai-training";

const aiTrainingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai-training",
  component: AiTrainingPage,
});
```

Then add `aiTrainingRoute` to the `routeTree.addChildren([...])` array.

- [ ] **Step 3: Add the nav item**

In `src/web/App.tsx`, add to the `navItems` array (use an imported icon, e.g. `Sparkles`):

```tsx
{ to: "/ai-training", label: "AI Training", icon: Sparkles },
```

- [ ] **Step 4: Verify build + start dev server**

Run: `npm run build`
Expected: success.

Then run `npm run dev` and load `http://localhost:5173/ai-training` — the page renders with the Voice Guide card; the textarea shows the current guide (empty on a fresh DB).

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/ai-training.tsx src/web/main.tsx src/web/App.tsx
git commit -m "feat(ai-training): /ai-training page with editable voice guide card"
```

---

## Task 12: Full verification + manual smoke

- [ ] **Step 1: Typecheck + full test suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass. (Note: two pre-existing CRLF/LF failures may exist in `src/integrations/qb/sync.regression.test.ts` per the backlog — they predate this work; confirm no NEW failures.)

- [ ] **Step 2: Seed the v1 guide (live call)**

Run: `npm run seed:voice-guide`
Expected: prints `Voice guide seeded (N words)…`. Reload `/ai-training` → the textarea now shows the generated guide. (Requires `ANTHROPIC_API_KEY` + DB access.)

- [ ] **Step 3: Edit + persist**

On `/ai-training`, edit the guide, click Save, reload → the edit persists (it round-trips through `PATCH /api/app-settings`).

- [ ] **Step 4: Draft quality check**

On `/autopilot`, draft a CRITICAL chase proposal. Confirm the drafted email reflects the voice guide + chase_l3 tone (compare against a pre-change draft if available). Draft a cold check-in (no template) → it still drafts using the voice guide alone, no error.

- [ ] **Step 5: Caching mechanism check (not a hit assertion)**

Bulk-draft several chase proposals. Confirm no errors from the `system` block. NOTE: `cache_read_tokens > 0` is NOT expected yet — the Wave A prefix (role + voice guide) is likely under Anthropic's ~1024-token cache minimum. Cache hits begin once Waves B/C add facts/corrections to the prefix. Verify only that drafting succeeds with the cached-block shape in place.

- [ ] **Step 6: Final commit (if any smoke fixes were needed)**

```bash
git add -A
git commit -m "fix(ai-training): Wave A smoke-test follow-ups"
```

---

## Self-Review (completed by plan author)

- **Spec coverage (Wave A scope):** voice guide storage (Task 2, KV — no migration ✓), `DEFAULT_VOICE_GUIDE` (Task 1 ✓), `buildDraftContext` resolver with full `DraftContext` shape (Task 1 ✓), tier→slug example mapping (Task 1 ✓), all 5 builders refactored to `{system,user}` with the customer-facing/internal split (Tasks 4-6 ✓ — including the `cadence_statement` correction), draft-endpoint cache wiring (Tasks 3+7 ✓), seed script + regenerate endpoint (Tasks 8-10 ✓), /ai-training page + Voice Guide card (Task 11 ✓). Facts/corrections/per-customer are intentionally stubbed for Waves B/C.
- **Placeholder scan:** no TBD/TODO; every code step has complete code. Route/UI steps that can't be unit-tested (no Fastify route harness in this repo — see `project_improvement-opportunities`) use `npm run build` + explicit manual smoke instead of fabricated tests.
- **Type consistency:** `DraftContext` + `BuiltPrompt` defined once in `voice.ts`, imported (type-only) by all builders and the endpoint. `buildDraftContext(category, summary, customerId)` signature is identical across Task 1, its tests, and the endpoint call (Task 7). `toSystemParam` return type matches the endpoint's spread usage.
```
