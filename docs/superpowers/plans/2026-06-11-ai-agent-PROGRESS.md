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
- [x] Recon for Wave A plan (2 agents)
- [x] Wave A plan written — `59a644a`
- [x] WA T1 schema + migration 0045 — `ddb08b5`
- [x] WA T2 context+fencing+injection suite — `997a80e` + breakout fix `67f33c2`
- [x] WA T3 read tools (10, fenced) — `7a8753a`
- [x] WA T4 loop + conversations — `86b6f65`
- [x] WA T5 routes + SSE events + kill switch — `f5f08c5`
- [x] WA T6 web (panel/page/chat/useAuth) — `897c449`
- [x] WA T7 verify — live E2E turn vs real API (15 tool calls, books separate, graceful QB-fail), SPA-nav persistence + /agent dock verified in browser; 841 tests, tsc, build green; Opus wave review FIX-FIRST caught fence-label breakout → fixed `67f33c2` → SHIP
- [ ] Wave B plan + execution + SHIP
- [ ] Wave C plan + execution + SHIP
