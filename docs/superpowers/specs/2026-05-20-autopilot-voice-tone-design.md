# Autopilot Voice/Tone Calibration — Design Spec

**Date:** 2026-05-20
**Status:** Approved (design); spec awaiting user review
**Branch context:** new branch off `main` (`feat/autopilot-voice-tone`)

---

## Problem

Autopilot's draft prompts (chase, cold-account, warehouse-nudge) tell
Claude to "mirror the style of the Feldart chase templates" but never
actually include any example. The AI is asked to imitate a voice it
can't see, so drafts come out generically AI-toned rather than sounding
like Feldart.

This is sub-project #1 of a 4-part "training the AI" initiative
(see `project_improvement-opportunities.md` for the full set: voice,
learn-from-edits, company-knowledge, judgment). The other three are
deferred to their own specs. Voice/tone is first because it's the
highest-leverage and foundational — every draft benefits immediately,
and the learn-from-edits loop (#2) builds directly on this prompt
structure.

## Goal

Feed the draft prompt two things it currently lacks:
1. A **global voice guide** — prose rules for how Feldart writes
   (tone, phrasing, sign-offs, dos/don'ts), editable by the operator
   in Settings.
2. A **per-category worked example** — the matching `email_templates`
   body, so the AI adapts a real template to the specific customer
   instead of inventing tone.

End state: a chase draft for "On The Table NJ" reads like the team
wrote it, mirroring chase_l3's tone, signed off the Feldart way.

## Out of scope

- Learn-from-edits feedback loop (sub-project #2 — separate spec).
- Company-knowledge retrieval (sub-project #3).
- Candidate/skip judgment tuning (sub-project #4).
- Per-category voice guides — decided on a single global guide; per-
  category specifics come from the injected template example.
- Fine-tuning Claude itself (not possible / not needed).

## Architecture

### 1. Voice guide storage

New `app_settings` row: `key = 'ai_voice_guide'`, `value = <prose>`.
(Confirm app_settings shape — likely key/value columns; grep
`app_settings` schema. If it's typed-columns rather than generic KV,
add an `aiVoiceGuide` text column instead.)

A baked-in default constant `DEFAULT_VOICE_GUIDE` in the ai-agent
module is used when the row is unset, so the feature works before the
operator customizes anything.

### 2. Voice context resolver

New helper in `src/modules/ai-agent/voice.ts`:

```ts
export type VoiceContext = {
  voiceGuide: string;
  exampleTemplate: string | null;
};

export async function getVoiceContext(
  category: AiProposalCategory,
  summary: Record<string, unknown>,
): Promise<VoiceContext>;
```

- **voiceGuide:** read `app_settings.ai_voice_guide`; fall back to
  `DEFAULT_VOICE_GUIDE`.
- **exampleTemplate:** per-category lookup against `email_templates`
  by slug:
  - `chase_next` → tier-mapped slug: MEDIUM→`chase_l1`, HIGH→`chase_l2`,
    CRITICAL→`chase_l3` (read `summary.tier`)
  - `cadence_cold` → a check-in template slug if one exists; else null
    (graceful — verify whether a suitable template exists; if not, the
    category runs voice-guide-only until one is created)
  - `ops_rma_stalled` (nudge path) → null (voice guide only)
  - `cadence_statement` / `ops_cron_fail` → N/A (deterministic, no AI
    draft)
  - Returns null exampleTemplate when no slug matches → prompt uses
    voice guide alone.

### 3. Prompt refactor + caching

The 3 drafting prompt builders
(`prompts/chase-next.ts`, `prompts/cadence-cold.ts`,
`prompts/ops-rma-stalled.ts`) gain a `voiceContext` parameter and
restructure their output so the stable prefix can be cached:

- **System prompt (cacheable):** role framing + voiceGuide + worked
  example ("Here is a reference email to match the tone of: …").
- **User message (varies per candidate):** the customer summary + the
  specific task instruction.

The draft endpoint (`src/server/routes/autopilot.ts`,
`/proposals/draft`) calls `getVoiceContext(category, summary)` before
`buildPrompt`, and passes the result. The Anthropic call moves the
voice guide + example into a `system` block with
`cache_control: { type: "ephemeral" }`. Within the 5-min cache window
(e.g. bulk-drafting 12 chase emails) the prefix is charged at ~10%.

NOTE: This requires changing the prompt builders' signature from
`buildPrompt(summary)` to `buildPrompt(summary, voiceContext)` and
splitting their return into `{ system, user }` instead of a single
string. The draft endpoint's `anthropic.messages.create` call updates
to pass `system` with cache_control + the user message.

### 4. v1 voice-guide seed

One-shot `scripts/seed-voice-guide.ts`:
1. Fetch all `email_templates` rows + the last ~30 outbound
   `email_log` bodies (direction='outbound', non-null body, recent).
2. Single Claude call (Sonnet 4.6): "Distill a concise voice/style
   guide from these real Feldart emails — tone, common phrasings,
   sign-offs, things they always/never do. Output the guide as prose,
   <600 words."
3. Upsert the result into `app_settings.ai_voice_guide`.
4. Log a summary. Re-runnable — overwrites the row (operator edits in
   Settings are lost on re-run; the "Regenerate" button warns).

Cost-tracked via existing `trackUsage` (surface='background_proposing'
or a new 'voice_guide_seed' — reuse background_proposing for v0).

### 5. Settings UI

New "AI voice guide" card in `src/web/pages/settings.tsx`:
- Textarea bound to `app_settings.ai_voice_guide` (GET to read, PATCH/
  POST to save). Reuse the app-settings route pattern (grep
  `app-settings` route).
- Save button + character count.
- "Regenerate from my emails" button → triggers the seed script logic
  via a new endpoint `POST /api/autopilot/voice-guide/regenerate`
  (enqueue or run inline; warns it overwrites manual edits).
- Read-only note: which categories currently have a worked-example
  template wired (so the operator knows cold-account is voice-only
  until a check-in template exists).

### 6. Endpoints

- `GET /api/app-settings` (existing — confirm it returns/accepts the
  new key) OR a dedicated `GET/PUT /api/autopilot/voice-guide`.
  Prefer reusing app-settings if its shape allows arbitrary keys;
  otherwise add the dedicated pair.
- `POST /api/autopilot/voice-guide/regenerate` — runs the seed logic.

## Testing

### Unit (vitest)

- `src/modules/ai-agent/voice.test.ts`:
  - getVoiceContext('chase_next', {tier:'CRITICAL'}) → resolves
    chase_l3 template (mock email_templates).
  - getVoiceContext with unset app_settings → returns
    DEFAULT_VOICE_GUIDE.
  - getVoiceContext('cadence_cold') with no template → exampleTemplate
    null, voiceGuide still present.
  - tier→slug mapping boundary cases.
- Prompt builder tests: buildPrompt returns a system block containing
  the voice guide text + the example when provided; omits the example
  block when null.

### Manual smoke

1. Run `scripts/seed-voice-guide.ts` → app_settings row populated;
   Settings card shows the generated guide.
2. Edit the guide in Settings → save → reload → persists.
3. On `/autopilot`, draft a CRITICAL chase → the drafted email
   reflects chase_l3 tone + the voice guide (compare against a draft
   produced before this change to confirm the shift).
4. Bulk-draft several chase emails → confirm via ai_interactions /
   logs that cache_read_tokens > 0 on the 2nd+ drafts (caching works).
5. Draft a cold-account check-in (no template) → still drafts, using
   voice guide alone, no error.

## Migration / rollout

- If app_settings is generic KV: no migration (just a new row written
  by the seed script). If it's typed columns: a migration adds
  `ai_voice_guide text` column.
- Ship behind no flag — drafts simply get better. The DEFAULT_VOICE_
  GUIDE ensures sane behavior before the operator seeds/customizes.
- Run the seed script once post-deploy to populate v1.

## Risks and tradeoffs

- **Voice guide drift** — operator edits + re-runs of the seed can
  diverge. The Regenerate button warns it overwrites manual edits.
- **Template staleness** — if chase_l1/l2/l3 templates change, drafts
  shift with them. Desirable (single source of truth) but worth
  knowing.
- **Cache window** — only helps within 5 min. Bulk-draft sessions
  benefit; one-off drafts pay full prefix cost. Acceptable.
- **No check-in template yet** — cold-account runs voice-guide-only
  until one is created. Flagged in Settings so it's visible.
- **Prompt size** — voice guide + template adds ~1-2K tokens per
  draft. Caching mitigates; without cache it's a few cents more per
  draft. Acceptable.

## Effort estimate

~1.5-2 days:
- voice.ts resolver + DEFAULT_VOICE_GUIDE + tests
- prompt builder refactor (3 prompts → system/user split) + draft
  endpoint cache_control wiring
- seed script + regenerate endpoint
- Settings card
- manual smoke

## Follow-ups (the other 3 training sub-projects)

- #2 Learn-from-edits: capture AI-draft vs operator-sent diff (the
  Edit & Send flow already persists the operator's final version),
  distill recurring corrections back into the voice guide.
- #3 Company knowledge: facts/notes store retrieved into the prompt.
- #4 Judgment on who: per-customer AI notes + skip-rule tuning.
