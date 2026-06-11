# AI Agent — Conversational + Agentic Layer

**Date:** 2026-06-11 · **Status:** Approved design, awaiting plan · **Branch:** `feat/ai-agent`

The full AI agent the plan deferred ("week 9 agent loop") — designed now
that its stated gates are met: tool surface settled, autopilot shipped,
Vocatech live, origin split complete. Decisions below came from a long
operator brainstorm (2026-06-11); the operator chose maximal scope with
phased delivery.

## Problem

The app has four disconnected AI conveniences (customer card, draft
reply, autopilot proposals, compose enhance) but no way to *converse*
with the system: no cross-system Q&A ("who promised payment and didn't
pay?"), no multi-step commands ("chase everyone over 90 days except open
disputes"), no taught background watching, no document understanding
(uploads, email attachments — currently discarded), no report
generation. Autopilot's watcher is hardcoded finders that can't be
extended by talking to it.

## Goal

**One agent brain, three triggers**, built in two phases:

- *You ask* → it answers (cross-system Q&A over everything).
- *You command* → it plans, executes reads freely, and proposes writes
  you approve in-chat.
- *(Phase 2) Schedule ticks* → it watches accounts and raises proposals;
  absorbs the autopilot scanner.

Operator-locked decisions: all three jobs done well (not one); writes
from day one behind the approve gate; the agent reads **everything**
(emails, call transcripts, notes, attachments) with an injection defense
stack; memory writes free + fully visible; per-user threads with shared
brain; soft cost ceiling + model tiering; persistent overlay UI + a
dedicated page; files linkable to records; reports library; CSV + PDF
outputs; scoped inbound triage in Phase 1.

## Out of scope

- Phase 2 items (designed here at sketch level, built later): watch mode
  + scanner absorption, watch instructions, standing briefings,
  generalized inbound interpretation.
- Absorbing the existing AI surfaces (card/draft-reply/enhance) — they
  stay as fast buttons, gain agent-awareness only (e.g. "Ask the agent"
  opens the panel pre-loaded).
- Roles/permissions (team remains all-access; proposals approvable by
  anyone).
- Voice input; conversation sharing between users (deferred).

## Design

### 1. Architecture — one brain beside the old one

New module `src/modules/agent/`:

```
agent/
├── loop.ts            # multi-turn tool-use loop (server-side)
├── context.ts         # context assembly + provenance fencing
├── tools/             # read tools + artifact tools (write tools reused)
│   ├── read-*.ts
│   ├── report.ts      # generate_pdf_report
│   └── export.ts      # export_csv
├── conversations.ts   # persistence, titles, rolling summary
├── files.ts           # uploads + email-attachment fetch + record links
├── triage.ts          # inbound-email classifier (P1 scoped)
└── memory.ts          # agent observations + AI-context writes
```

It **imports** from `ai-agent/` (tool registry + the six write tools,
proposal lifecycle, voice/facts/corrections) and `integrations/anthropic/`
(client, cost tracker — the unused `agent_chat` surface enum finally gets
used). `ai-agent/` is untouched; autopilot keeps running as-is until
Phase 2 swaps its scanner for agent watch passes. A module README states
the relationship so the coexistence reads as deliberate.

Chat-initiated writes create `ai_proposals` rows with new
`source: 'chat'` (enum column added; autopilot rows = 'scan'), rendered
inline in the conversation. One approval mechanism everywhere; approvals
from chat or /autopilot queue are equivalent (shared brain, any user).

### 2. The loop

- Server-side `messages.create` tool-use loop; SSE streaming to the
  client (existing SSE infra); tool calls render as chips in the chat
  while it works.
- **Model tiering:** Haiku-class for mechanical steps (triage
  classification, email summarization, title generation); Sonnet 4.6 for
  the conversational loop + drafting. Tier recorded per call by the cost
  tracker (already multi-model).
- **Iteration cap:** ~15 tool calls per turn, then the agent checkpoints
  ("I've done X of Y — keep going?"). Prevents runaway loops; the cap is
  a constant, not a setting.
- **Background completion:** a turn keeps executing server-side if the
  operator navigates away or closes the panel; on completion the
  conversation updates and a notification fires (existing notifications
  table + SSE bell).
- **Rolling summary:** when a conversation approaches context limits,
  older turns are summarized (Haiku) into a pinned summary block;
  recent turns stay verbatim.
- Ambiguity behavior: ask a clarifying question rather than guess when a
  command is ambiguous; act directly when clear.
- Failure UX: Anthropic errors surface as a friendly retryable chat
  message; never a blank hang.

### 3. Tools

**Read family (new, in `agent/tools/`)** — all DI-seamed and unit-tested:
customers (search/detail incl. per-book balances), invoices + credit
memos, email log **including attachment fetch from Gmail** (attachments
are currently discarded — this closes that gap), call transcripts +
summaries, notes/AI context, RMAs, tasks, statement/chase history,
non-secret app settings, `refresh_customer_from_qb` (existing per-customer
sync endpoint as a tool, so answers aren't stale-data answers).

**Write family (reused + extended, all proposal-gated):** new write
tools are added to the existing registry in `ai-agent/tools.ts` (not
`agent/tools/`) so the one BullMQ proposal executor runs everything —
`agent/` contributes only read + artifact tools.
- Existing six sends (chase/check-in/statement/bookkeeper/warehouse/
  notification) — unchanged executors.
- New: create/complete/assign tasks — assignable to any team member
  (default: the requesting operator), with due dates parsed from natural
  language ("charge their card on the 15th" → task assigned, due the
  15th, linked to the customer); update customer notes / AI context;
  hold/release (Shopify tag flip via the atomic tagsAdd/Remove path);
  payment-terms change; dispute transitions (claims-paid / not-paid);
  QBO void + credit memo (dispute resolution path) — these two carry a
  **heavier approval**: type-to-confirm in the approval UI.
- Recipient/destination fields are **never free-typed by the model**:
  server resolves them from customer records or settings at execution
  time (the send_bookkeeper_email pattern, generalized).

**Artifact tools:**
- `generate_pdf_report`: the model supplies structured content (title,
  sections, tables, simple charts); the server renders it through the
  house statement-PDF pipeline's styling. The model never writes raw
  layout — consistent branding, no layout injection.
- `export_csv`: tabular data → CSV download.

**Memory tools:** save observation / save customer fact — write freely
(no approval; zero external blast radius), surfaced as "📝 noted" in
chat, stored visibly (see §7).

**Interaction logging:** `record_interaction` — the operator dictates
out-of-band conversations ("Brown & Co WhatsApped: they'll pay £5k
Friday") and the agent writes an operator-reported entry to the
customer's `activities` timeline (kind: whatsapp/phone/in-person/other,
with the dictated summary), visible in the Activity tab beside emails
and calls. Free-write like memory (it's the operator's own report;
deletable), confirmed inline ("📝 logged to Brown & Co's timeline").
When the dictation contains a durable fact or commitment, the agent
also distills it into AI context — and payment promises recorded this
way become first-class watch signals in Phase 2 ("promised payment not
received").

### 4. Batch approval UX

The doer's core interaction. A multi-action plan renders as a compact
review list in-chat: who, amount, tier, one-line preview; rows expand to
the full draft; any draft is **editable inline before approval**; rows
can be dropped; then "Approve all (N)" executes the rest via the
existing BullMQ proposal executor. Per-item approve also available.
Operator edits diff against the original draft and feed
`ai_learned_corrections` (existing learn-from-edits pipeline) so the
agent improves from every correction.

### 5. Safety stack (prompt injection becomes first-class)

The agent reads attacker-writable text (customer emails, attachments,
transcripts) while holding tools. Defenses, layered:

1. **Provenance fencing** in context assembly: customer-originated text
   wrapped in labeled delimiters (`<untrusted source="email" ...>`) with
   system-prompt rules to treat it as data, never instructions;
   operator-written notes fenced as a distinct softer class; system data
   unfenced. `context.ts` owns this — one place, testable.
2. **Approve gate**: no write executes without an operator click. Ever.
3. **Server-side recipient/destination locks** (§3).
4. **Provenance labels on proposals**: any proposal whose turn read
   untrusted content is labeled ("drafted after reading 3 customer
   emails — view") in chat and in the /autopilot queue.
5. **Injection test suite**: hostile fixture emails/attachments
   (embedded instructions, tool-call lookalikes, "ignore previous
   instructions") pinned by tests — fenced content must never alter the
   tool-call stream.
6. **Kill switch**: `app_settings.agent_enabled` (default on once
   shipped); watch mode gets its own switch in Phase 2.
7. Existing: every call cost-tracked (`agent_chat` surface), tool calls
   logged in `ai_interactions.toolsCalled`, writes audit-logged by the
   proposal executor.

### 6. Conversations, UI, multi-user

**Schema (new tables):**
- `agent_conversations` (id, userId, title, createdAt, updatedAt,
  summary, archivedAt)
- `agent_messages` (id, conversationId, role, content json — text +
  tool-call records + proposal refs + file refs, createdAt)
- `agent_files` (id, conversationId, uploaderUserId, filename, mime,
  size, storagePath, sourceEmailLogId nullable, customerId/rmaId/
  invoiceId nullable links, createdAt)
- `agent_reports` (id, conversationId, requestedByUserId, title, kind
  pdf|csv, storagePath, createdAt)
- `ai_proposals.source` enum('scan','chat') added (migration).

**UI:**
- **Persistent overlay panel** mounted at App-shell level, outside the
  router — survives page navigation; a conversation started on one page
  continues seamlessly on another. Keyboard shortcut + header button.
  Context chip shows the current page's subject ("● Brown & Co"); each
  user message carries current page context as metadata, so "this
  customer" always means the one on screen *now*.
- **/agent page**: the one place the overlay docks INTO the page —
  active conversation full-width, plus conversation list + search,
  reports library, memory browser (observations + taught facts,
  editable), spend dashboard. Navigating away un-docks back to the
  panel.
- **Mobile**: the panel renders as a full-screen sheet (app-bar
  patterns from the mobile redesign).
- **Multi-user**: per-user conversation threads; memory, learnings,
  files, reports, and proposals are team-global; the agent never reads
  another user's conversations.

### 7. Memory & learning

- Reads (existing stores): voice guide, company facts, learned
  corrections, per-customer AI context.
- Writes: per-customer facts → existing `ai_customer_context` (visible
  in the customer rail, editable); non-customer operational notes →
  agent memory store (visible in /agent memory browser). Agent-inferred
  observations are marked distinctly from operator-told facts.
- Batch-edit diffs → `ai_learned_corrections` (existing pipeline).

### 8. Files in

Uploads (images, PDFs; ~20MB cap) and email attachments fetched on
demand. Stored under `data/agent-files/` on the VPS with DB metadata
(the `data/` dir is already rsync-excluded from deploys). Both enter
model context via the SDK's multimodal blocks, fenced as untrusted.
Files are linkable to customer/RMA/invoice records ("file this
remittance under Brown & Co") and surface in the customer activity rail.

### 9. Reports out

Saved to the **reports library** (/agent page): title, date, requester,
re-downloadable, attachable to outgoing emails via the compose flow.
PDF via the house template; CSV for tabular asks.

### 10. Inbound triage (P1, scoped)

At Gmail-ingest time (poller), a Haiku classifier runs per new inbound
email for exactly three high-confidence patterns:
1. tracking number present → RMA-update proposal,
2. payment claim or payment instruction → dispute-flow proposal (TJ) /
   payment-check task (Feldart); instructions carrying a date ("charge
   my card on the 15th") become dated task proposals,
3. statement or invoice-copy request → send proposal.

Anything else: untouched. Proposals carry the triggering email as
provenance. The existing dumb auto-action-on-reply fast path stays.
Generalized interpretation waits for Phase 2.

### 11. Cost

Soft monthly ceiling in `app_settings` (default $150, editable in
Settings): notifications at 80% and 100%, **never blocks**. Spend
dashboard on /agent from `ai_interactions` (per-surface, per-model,
per-day). Prompt caching on the system prompt + stable context blocks.

### 12. Phase 2 sketch (designed-for, not built now)

Watch mode: scheduled agent passes replace `scanner.ts`'s finder loop —
existing finders demote to cheap candidate signals the agent reviews
with full context; proposals flow to the same queue. **Watch
instructions**: operator-taught rules ("watch for customers who break
payment promises") stored in a visible, editable store the watcher
reads every pass. **Standing briefings**: user-defined scheduled
conversations ("Monday 8am: cash position") landing as notifications +
conversations. Generalized inbound interpretation. Nothing in Phase 1's
schema or module boundaries needs rework for this — the loop, tools,
queue, and memory are shared.

## Existing-AI-surface integration (P1, light touch)

Customer AI card gains "Ask the agent" (opens panel pre-loaded with that
customer context). Draft-reply and compose-enhance unchanged. Card/agent
share the learning stores already; deeper consolidation is a later
cleanup, not this project.

## Testing

- Unit (DI seams, house pattern): loop control flow (iteration cap,
  checkpoint, background completion), context assembly + fencing, every
  read tool, triage classifier branches, report/CSV builders,
  conversation rolling summary.
- **Injection suite** (§5.5) — hostile fixtures, pinned.
- Route tests (schema-export pattern): conversation CRUD, upload
  validation, proposal-from-chat creation.
- Playwright: panel persistence across navigation, /agent dock/undock,
  batch review approve/edit flow, upload → ask → answer, report
  download.
- Cost assertions: tiering (triage calls must be Haiku-class), cache
  hits on repeat turns.

## Risks

- **Prompt injection** — the central one; mitigated by §5's stack and
  the test suite; residual risk is operator-annoyance proposals, not
  autonomous action.
- **Cost surprises** — tiering + ceiling alerts + dashboard; watch mode
  (the bigger spender) is Phase 2.
- **Scope weight** — Phase 1 is the largest single project yet; built in
  internal waves (see plan), each shippable.
- **Two AI modules coexisting** (`ai-agent/`, `agent/`) — accepted
  deliberately; README documents the boundary; Phase 2 shrinks
  `ai-agent/` to executors + finders-as-signals.

## Build order (Phase 1 internal waves, each deployable)

- **Wave A — foundation:** schema + conversations + loop + context/
  fencing + read tools + panel & /agent page (Q&A agent, read-only).
- **Wave B — the doer:** write tools via chat proposals + batch review/
  edit/approve UX + learning wiring + new write tools (tasks/notes/
  state/QBO with type-to-confirm).
- **Wave C — documents & triage:** uploads + email attachments + record
  linking + PDF/CSV reports + library + inbound triage + cost dashboard
  + ceiling alerts + AI-card "Ask the agent" button.

Each wave: worktree/branch → TDD → Playwright verify → independent Opus
review → merge/push/watch deploy (per `feedback_finance-hub-workflow`).
