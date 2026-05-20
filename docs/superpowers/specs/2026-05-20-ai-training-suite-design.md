# AI-Training Suite — Design Spec

**Date:** 2026-05-20
**Status:** Approved (design); spec awaiting user review
**Branch context:** `feat/autopilot-voice-tone` (scope broadened from voice/tone alone to the full suite)
**Supersedes:** `2026-05-20-autopilot-voice-tone-design.md` — that spec's voice/tone work is folded in here as Wave A. The standalone spec remains for #1 detail but this umbrella is the source of truth.

---

## Problem

Autopilot's draft prompts (chase, cold-account, RMA-nudge) ask Claude to
"mirror the Feldart style" but feed it nothing to mirror, know nothing
about the company beyond the immediate row, know nothing customer-specific
beyond the candidate summary, and never learn from the operator's edits.
Drafts come out generically AI-toned and have to be hand-fixed every time.

This is the "training the AI" initiative — four sub-projects that give the
draft prompt the context a human accounts person has in their head:

1. **#1 Voice/tone** — how Feldart writes (global prose guide + a worked
   template example).
2. **#3 Company knowledge** — durable facts about the business.
3. **#4 Per-customer judgment** — what to know/do for a specific customer.
4. **#2 Learn-from-edits** — distill the operator's draft→sent edits back
   into reusable corrections.

## Goals

- A single shared context layer that assembles all four sources into every
  autopilot draft, refactoring the prompt builders **once**.
- Operator-curated, structured stores (facts and corrections as rows, not
  one opaque blob) with real management UI.
- Preserve and extend #1's prompt-caching win (~90% off the stable prefix
  on bulk-draft runs).
- "AI proposes, human approves" throughout — distilled corrections are
  proposed, never auto-applied.

## Scope

In: sub-projects #1, #2, #3, #4, built in dependency order.

Out of scope:
- Semantic / embedding retrieval (data volume is dozens–few hundred curated
  rows; inject-all with tag filtering fits and keeps caching). Revisit only
  if the knowledge base grows into the thousands.
- Hard per-category per-customer skip toggles (soft text-driven skip + the
  existing global `agent_mode_excluded` cover it; add structure later only
  if AI discretion proves unreliable).
- A full Fastify route-test harness (unit/schema tests this round).
- Fine-tuning the model.

## Architecture

### Unified context resolver

`src/modules/ai-agent/voice.ts`'s `getVoiceContext` (from the #1 spec)
generalizes into one resolver:

```ts
export type DraftContext = {
  voiceGuide: string;              // blob or DEFAULT_VOICE_GUIDE
  globalFacts: string[];           // #3 — cacheable across all drafts
  categoryFacts: string[];         // #3 — cacheable within a category
  globalCorrections: string[];     // #2 active — cacheable across all
  categoryCorrections: string[];   // #2 active — cacheable within a category
  customerContext: string | null;  // #4 — per-customer, NOT cached
  exampleTemplate: string | null;  // #1 — tier-mapped, NOT cached
};

export async function buildDraftContext(
  category: AiProposalCategory,
  summary: Record<string, unknown>,
  customerId: string,
): Promise<DraftContext>;
```

Resolution:
- **voiceGuide** — `app_settings.ai_voice_guide`, else `DEFAULT_VOICE_GUIDE`.
- **facts / corrections** — tag-filtered from their tables: `global` rows
  always, plus rows tagged to the current `category`. Inject the whole
  relevant set (no ranking, no embeddings).
- **customerContext** — `customers.ai_customer_context` for `customerId`.
- **exampleTemplate** — per-category `email_templates` lookup:
  `chase_next` → tier-mapped slug (`MEDIUM→chase_l1`, `HIGH→chase_l2`,
  `CRITICAL→chase_l3`); `cadence_cold`, `cadence_statement`,
  `ops_rma_stalled` → none (no per-tier example template). Null example →
  the prompt uses voice + facts + corrections without a worked example.

### Which builders get context (builder scope)

All five autopilot categories have a `buildPrompt(summary): string`
(confirmed). They are NOT uniform — context applies only to outbound text,
not internal alerts. Per-customer context (#4) applies only where we write
*to the customer*:

| Builder | Output | Voice + facts + corrections | Per-customer (#4) | Example |
|---|---|---|---|---|
| `chase_next` | customer chase email | ✓ | ✓ | tier-mapped |
| `cadence_cold` | customer check-in email | ✓ | ✓ | none |
| `cadence_statement` | customer statement **cover note** | ✓ | ✓ | none |
| `ops_rma_stalled` (warehouse branch) | warehouse nudge email | voice guide only | ✗ (not the customer) | none |
| `ops_rma_stalled` (admin branch) | internal notification | ✗ | ✗ | ✗ |
| `ops_cron_fail` | internal notification | ✗ | ✗ | ✗ |

`ops_rma_stalled` branches on RMA status inside `buildPrompt`
(`isWarehouseCase`), so it knows pre-inference whether it is drafting the
warehouse email (inject the voice guide) or an admin notification (inject
nothing). `cadence_statement` was previously (and wrongly) treated as
deterministic; it generates a customer-facing cover note via AI and so is
in scope.

### Hybrid storage (the "structured stores" decision)

| Source | Store | Shape | Why |
|---|---|---|---|
| Voice guide (#1) | `app_settings.ai_voice_guide` | prose **blob** | Style rules are naturally prose. |
| Company facts (#3) | `ai_company_facts` | **rows** | Discrete, individually add/edit/tag/retire. |
| Learned corrections (#2) | `ai_learned_corrections` | **rows** | Individually approve/reject/retire. |
| Per-customer (#4) | `customers.ai_customer_context` | text column | One note per customer; explicit AI-visibility control. |

### Retrieval & caching

Retrieval = **tag filter + inject-all-relevant**. Facts and corrections
carry `global` or per-category tags only — **never per-customer** (all
per-customer knowledge lives in #4's `ai_customer_context`). This keeps the
entire facts/corrections set free of per-candidate variation, so it can sit
in the cached prefix.

The in-scope builders (see Builder scope) refactor from
`buildPrompt(summary): string` to
`buildPrompt(summary, context: DraftContext): { system, user }`:

- **`system` (cached):** role framing + voiceGuide + global facts + global
  corrections **[cache breakpoint]** + category facts + category
  corrections. Global content is ordered first so it caches across *all*
  drafts; category content sits after a second breakpoint so it caches
  within same-category bulk runs (the dominant case — e.g. 12 chase
  drafts). `cache_control: { type: "ephemeral" }`.
- **`user` (varies, uncached):** customerContext + tier-mapped example
  ("Here is a reference email to match the tone of: …") + customer summary
  + the task/skip instruction.

The draft endpoint (`src/server/routes/autopilot.ts`, `/proposals/draft`)
calls `buildDraftContext` before `buildPrompt` and passes `system` (with
cache_control) + `user` to `anthropic.messages.create`.

## Data model

One migration adds:

- **`ai_company_facts`** — `{ id, fact text, tags json string[] (global |
  category slugs), active boolean default true, createdByUserId, createdAt,
  updatedAt }`.
- **`ai_learned_corrections`** — `{ id, correction text, tags json string[],
  status varchar (proposed | active | rejected | retired), sourceProposalIds
  json string[], createdAt, decidedByUserId, decidedAt }`.
- **`customers.ai_customer_context`** — `text`, nullable.

No migration for the voice guide — it is a KV row in the existing
`app_settings` (generic key/value, value is TEXT). Add `ai_voice_guide`
(and `ai_corrections_cron_enabled`) to `APP_SETTING_KEYS`.

All CRUD writes (facts, corrections decisions, per-customer context edits)
go through `audit_log` per the project convention.

## Sub-projects

### #1 Voice/tone (Wave A — foundation)

As designed in the standalone spec, now feeding the unified resolver:
- `DEFAULT_VOICE_GUIDE` constant in the ai-agent module.
- `scripts/seed-voice-guide.ts` — one-shot: read `email_templates` + last
  ~30 outbound `email_log` bodies → single Sonnet call distills a <600-word
  guide → upsert `app_settings.ai_voice_guide`. Re-runnable; the
  Regenerate button warns it overwrites manual edits. Cost-tracked via
  `trackUsage`.
- Prompt-builder refactor (the customer-facing builders per Builder scope:
  chase_next, cadence_cold, cadence_statement, plus ops_rma_stalled's
  warehouse branch voice-guide-only) + draft-endpoint cache wiring described
  in Architecture.
- Voice Guide card (on the new `/ai-training` page): textarea bound to the
  guide + char count + "Regenerate from my emails" button + a read-only
  note of which categories currently have a worked-example template wired.

### #3 Company knowledge (Wave B)

- `ai_company_facts` CRUD: add / edit / tag (`global` or category) / retire
  (`active=false`). Operator-curated; starts empty.
- Injected via `buildDraftContext` (global + category-tagged), into the
  cached system block.
- No AI-assisted fact suggestion in v1 (possible follow-up).

### #4 Per-customer judgment (Wave B)

- `customers.ai_customer_context` editor on the customer detail page, near
  the existing agent-mode toggle / HoldBanner.
- Injected into that customer's draft (user message) and consulted for the
  skip decision (the existing prompt skip logic references it: e.g. "Honor
  any customer-specific guidance below; skip if it says not to contact").
- **Soft, text-driven** — no new skip schema. `agent_mode_excluded` remains
  the hard global opt-out. Accepted tradeoff: a customer the operator has
  told the AI to skip *in text* still surfaces as a deterministic candidate
  and costs one draft call to skip.
- Operators should treat this field as AI-visible (no secrets); human-only
  commentary stays in `internal_notes`, which is **never** sent to the model.

### #2 Learn-from-edits (Wave C — last)

Depends on the resolver being live and on accumulated draft-vs-sent data.

- **Capture (no new plumbing):** the AI draft is in
  `ai_proposals.drafted_action` / `drafted_preview`; the operator's sent
  version is in `email_log` joined by `ai_proposal_id`. The distiller reads
  recent executed proposals with a linked sent email and diffs them.
- **Distill (quality-gated):** feed draft+sent pairs to Sonnet asking for
  *recurring stylistic/structural* corrections only. The prompt explicitly
  instructs it to **ignore one-off factual edits** (changed number, date,
  name) and to propose a correction only when a pattern has **support
  across multiple emails**. Each result becomes a `proposed` row (with
  `sourceProposalIds`). Cost-tracked.
- **Triggers:** on-demand "Learn from my recent edits" button **and** an
  optional weekly BullMQ cron governed by `app_settings.ai_corrections_cron_enabled`
  (default off). Cron-distilled proposals raise a bell notification; the
  button returns inline. With too few diffs, the distiller reports "not
  enough edit data yet" rather than inventing corrections.
- **Review:** queue lists `proposed` corrections; operator approves
  (→ `active`, gets injected), rejects (→ `rejected`), or edits then
  approves. Any active correction can be retired.
- **Lifecycle (anti-sprawl):** active corrections are a *recent-deltas*
  layer, not a forever-pile. The intended practice — surfaced as a UI note
  — is to periodically fold stable corrections into the voice guide and
  retire them, preventing accumulation/contradiction with the guide. There
  is a live loop (corrections → drafts → edits → more corrections); the
  approve-gate + retire + fold-in practice keep it curated.

## Surfaces & endpoints

- **New `/ai-training` page** (its own route, not stuffed into the already
  ~2.5k-LOC `settings.tsx` — also chips at known page-split debt). Cards:
  Voice Guide (#1), Company Facts (#3), Corrections review queue + "Learn
  from my edits" button + weekly-cron toggle (#2).
- **#4** lives on the customer detail page.
- **Endpoints:**
  - Voice: reuse the app-settings route if it permits the `ai_voice_guide`
    key (confirm at plan time; add to `APP_SETTING_KEYS`), else a dedicated
    `GET/PUT /api/ai-training/voice-guide`. `POST /api/ai-training/voice-guide/regenerate`.
  - Facts: `GET / POST /api/ai-training/facts`, `PATCH /api/ai-training/facts/:id`
    (edit / retire).
  - Corrections: `GET /api/ai-training/corrections`,
    `POST /api/ai-training/corrections/distill`,
    `PATCH /api/ai-training/corrections/:id` (approve / reject / edit / retire).
  - #4: extend the existing customer-update (PATCH) route to accept
    `ai_customer_context`.

## Build order / waves

- **Wave A (#1):** migration scaffold + `buildDraftContext` (voice +
  example only to start) + `DEFAULT_VOICE_GUIDE` + seed script + prompt
  refactor + cache wiring + Settings card. This is the shared spine; it
  must land first.
- **Wave B (#3 + #4, parallelizable):** facts table + CRUD + UI; extend the
  resolver to read facts. `ai_customer_context` column + customer-page
  editor + resolver wiring. File-disjoint (facts module vs customer page) →
  candidate for a 2-agent team.
- **Wave C (#2):** corrections table + distiller + on-demand endpoint +
  weekly cron + review UI; extend the resolver to inject active corrections.

## Testing

- Unit (vitest):
  - `buildDraftContext`: tier→slug mapping; unset voice guide →
    `DEFAULT_VOICE_GUIDE`; `cadence_cold` → null example, voice still
    present; tag filtering (global always, category match, customer never
    in facts); active-only corrections.
  - Prompt builders: `{ system, user }` shape — system carries voice +
    facts + corrections with the cache breakpoints; user carries
    customerContext + example + summary; example omitted when null.
    `cadence_statement` produces a cover-note prompt with context + null
    example. `ops_rma_stalled` warehouse branch carries voice guide only;
    its admin branch and `ops_cron_fail` are unchanged (no context).
  - Distiller: parses draft/sent pairs; ignores a one-off factual-only
    diff; emits a proposed row only with multi-email support.
- Manual smoke:
  - Run the voice seed → guide populated; Settings shows it.
  - Edit guide → save → reload → persists.
  - Add a global fact + a chase-tagged fact → draft a chase → both present;
    draft a cold → only the global fact present.
  - Set a customer's `ai_customer_context` ("pays late but always pays —
    stay warm") → draft for them → tone reflects it.
  - Bulk-draft several chase emails → `cache_read_tokens > 0` on 2nd+.
  - Edit a few AI drafts then click "Learn from my edits" → proposed
    corrections appear; approve one → it shows in subsequent drafts.

## Migration / rollout

- One additive migration (2 tables + 1 column). Voice guide needs none.
- No feature flag — drafts simply improve. `DEFAULT_VOICE_GUIDE` + empty
  facts/corrections = sane day-one behavior.
- Post-deploy: run `scripts/seed-voice-guide.ts` once to populate v1.
- Rollback: revert the merge; the new tables/column go inert (no data
  loss). The resolver falls back to `DEFAULT_VOICE_GUIDE` + empty sets.

## Risks & tradeoffs

- **Prompt size** — voice guide + all relevant facts + active corrections +
  example adds tokens per draft. At dozens–few hundred facts this is a few
  thousand tokens; caching covers cost on bulk runs, tag-discipline keeps
  per-draft sets small. "Few hundred" is the ceiling where inject-all stays
  sane; beyond that, revisit top-N / embeddings.
- **Correction drift / contradiction** — mitigated by approve-gate, retire,
  and the fold-into-guide practice.
- **Distiller noise** — mitigated by the stylistic-only + multi-email
  quality gate; cold-start handled by the "not enough data" path.
- **Soft skip waste** — text-skipped customers still cost a draft call to
  skip (accepted; hard toggles deferred).
- **Template / guide staleness** — drafts shift if templates or the guide
  change; desirable (single source of truth) but worth knowing.

## Effort estimate

~4–6 days across the three waves (vs ~1.5–2 days for #1 alone): shared
resolver + one-time prompt refactor + caching (A); 2 tables + migration +
two CRUD/UI surfaces (B); distiller + cron + review UI (C).

## Open verification items (resolve at plan time)

- Voice guide: confirm whether the existing app-settings route accepts an
  arbitrary/new key, or add the dedicated voice-guide pair.
- Confirm the `anthropic.messages.create` call site in
  `routes/autopilot.ts` and `src/integrations/anthropic` — exact shape for
  passing a `system` array with `cache_control` + the user message.
- All five `buildPrompt(summary): string` signatures confirmed (chase_next,
  cadence_cold, cadence_statement, ops_rma_stalled, ops_cron_fail). The
  draft endpoint's category→builder dispatch must be updated to pass
  `DraftContext` to the in-scope builders only.

## Follow-ups (deferred)

- AI-assisted fact suggestion (propose facts from templates/email history).
- Hard per-category skip toggles, if soft skip proves leaky.
- Auto-fold stable corrections into the voice guide (vs the manual practice).
- Embedding retrieval, only if the knowledge base outgrows inject-all.
