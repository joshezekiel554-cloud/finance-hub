# AI Agent (Phase 1) — live progress tracker

Spec: `../specs/2026-06-11-ai-agent-design.md` · Branch: `feat/ai-agent` (off main `8f0cab7`) · Started 2026-06-11 · Operator authorized full autonomous execution of all 3 waves.

Wave A = foundation (schema, loop, fencing, read tools, panel + /agent page — read-only Q&A agent).
Wave B = the doer (chat write proposals, batch review/edit/approve, learning, new write tools incl. tasks w/ assignees+dates, record_interaction, QBO type-to-confirm).
Wave C = documents & triage (uploads, email attachments, record linking, PDF/CSV reports + library, inbound triage, cost dashboard + ceiling, AI-card button).

Context notes (survive compact):
- Working norms: INLINE implementation (operator directive 2026-06-11 — no implementer subagents; agents for recon/review only), independent Opus review per task batch, fix-first findings closed before shipping, tracker updated+pushed after every task, merge each wave → watch Deploy (port-2222 hardened) → prod checks over `ssh finance-vps`.
- Local dev: DEV_USER_EMAIL bypass in .env (re-comment before merge), kill stale 3001/5173, db:migrate clean locally (journal fixed 2026-06-10), Redis usually down locally (worker jobs untestable locally — unit-cover instead).
- Key spec decisions: one brain/three triggers; writes day-one behind approve; read-everything + 5-layer injection stack (fencing in context.ts, injection test suite REQUIRED); per-user threads/shared brain; overlay survives navigation, docks on /agent; proposals from chat = ai_proposals.source='chat'; new write tools go in ai-agent/tools.ts (one executor); model tiering Haiku/Sonnet; soft $150 ceiling.

## Status log
- [x] Spec approved + committed (`d4ca559` tip; incl. record_interaction + task assignees/dates)
- [ ] Recon for Wave A plan
- [ ] Wave A plan written
- [ ] WA T1 schema (conversations/messages/files/reports + proposals.source) + migration 0045
- [ ] WA T2 context assembly + fencing + injection suite
- [ ] WA T3 read tools
- [ ] WA T4 agent loop + SSE + conversation persistence
- [ ] WA T5 routes (conversations CRUD, chat turn, SSE)
- [ ] WA T6 overlay panel + /agent page
- [ ] WA T7 verify + wave review + SHIP
- [ ] Wave B plan + execution + SHIP
- [ ] Wave C plan + execution + SHIP
