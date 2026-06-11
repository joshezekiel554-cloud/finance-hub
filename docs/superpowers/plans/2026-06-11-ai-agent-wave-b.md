# AI Agent — Wave B (The Doer) Implementation Plan

> Inline execution. Spec §3 (write family), §4 (batch approval UX), §7/§interaction-logging. Wave A foundations live in prod.

**Goal:** Chat writes as proposals: the agent proposes actions inline (tool_use → ai_proposals row, source 'chat'), the operator approves/edits/dismisses in the conversation; new write tools (tasks w/ assignees+dates, notes/context, record_interaction, hold, terms, dispute transitions incl. void w/ type-to-confirm).

## Locked decisions

- **New category `chat_action`** in AI_PROPOSAL_CATEGORIES (varchar col — TS-only change). Chat proposals: status 'drafted' immediately (the args ARE the draft), `source: 'chat'`, scanId = conversation id (reuse of the required field — documented), entityType/entityId derived from args (customer/invoice/task), expiresAt +7d, candidateSummary {tool, conversationId, summary line, dangerous flag}.
- **Loop write-path:** requiresConfirmation tool_use no longer refused — creates the proposal via a new `src/modules/agent/chat-proposals.ts`, persists a `tool_event` message with `content.kind='proposal'` + proposalId + preview, returns tool_result "Proposal N created — the operator must approve it in the chat. Do not repeat or assume it executed."
- **Adapters:** the agent-loop tools (registry `ToolDefinition`) for writes are thin wrappers declaring name/description/schema with `requiresConfirmation: true` and NO handler execution path (handler never runs — the loop intercepts before dispatch; handler returns an error if ever called directly, defense in depth). EXECUTION stays in ai-agent/tools.ts `TOOLS` via the existing BullMQ approve flow — one executor.
- **New executable tools in ai-agent/tools.ts (Tool<A> shape):** create_task (title, body?, customerId?, assigneeEmail?, dueAtIso?, priority?), complete_task (taskId), update_customer_context (customerId, append text — appends to aiCustomerContext with attribution line, never replaces), record_interaction (customerId, kind whatsapp|phone|in_person|other, summary, occurredAtIso? — recordActivity kind 'operator_logged' source... check ACTIVITY_KINDS enum; add value if needed via migration? AVOID migration: reuse closest existing kind ('note'? check) — resolve at implementation), set_hold_status (customerId, status active|hold|payment_upfront — reuses holds route logic via extracted helper or direct tagOps; SIMPLEST: call the same code path the route uses), set_payment_terms (customerId, terms string), dispute_transition (invoiceId, action claims_paid|not_paid|paid_void — paid_void marked dangerous; reuses dispute route logic).
- **Mirror agent-loop declarations** in `src/modules/agent/tools/write-tools.ts`: same names/schemas as the 6 existing sends + the new ones, all requiresConfirmation true. The model sees ALL writes; the loop proposalizes them.
- **Dangerous set** (type-to-confirm in UI): dispute_transition with action paid_void. UI requires typing the invoice docNumber.
- **Chat UI:** `content.kind==='proposal'` tool_event rows render ProposalCard (tool label, preview args, Approve / Edit (json-light field editing for subject/body/title/text fields) / Dismiss → POST /api/autopilot/proposals/:id/approve {editedArgs?} / /dismiss). After approve: card shows executing→done via proposals refetch (poll once on agent.complete + on approve response). Approve-all bar when ≥2 pending proposal cards in the conversation (skips dangerous ones with a note).
- **Learning:** chat edits flow through the SAME approve endpoint editedArgs path → existing corrections capture. No new code.
- **Autopilot queue parity:** chat proposals appear in /autopilot too (same table) — acceptable + desirable (one queue); they carry category chat_action badge. Add CATEGORY_LABELS entry.

## Tasks
- [ ] WB T1 executable write tools in ai-agent/tools.ts + tests
- [ ] WB T2 chat-proposals module + loop write-path + declarations + tests
- [ ] WB T3 chat ProposalCard UI + approve/edit/dismiss + approve-all + dangerous confirm
- [ ] WB T4 gates + Opus wave review + fixes + SHIP
