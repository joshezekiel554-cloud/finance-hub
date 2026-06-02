# B2B Parse-Gap Verify Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Flag possible shipment-parser misses on the Today→Orders review, let the operator verify against the source email, fix inline, and block send until each flag is cleared — preventing silent under-billing.

**Architecture:** Parser gains an `unparsedRows` signal (rows in the items table it couldn't read). The route forwards it (email body already sent). The review component flags removes + unparsed rows, gates Send behind per-line verification (reusing the existing `blockedFromSend` pattern), offers an inline "Keep instead" fix (reusing the existing qty-edit handler), and shows a comparison + sandboxed full-email panel.

**Tech Stack:** TS, Fastify, React + TanStack Query, vitest. Spec: `docs/superpowers/specs/2026-06-02-b2b-parse-gap-verify-design.md`.

---

### Task 1: Parser — collect unreadable items-table rows

**Files:**
- Modify: `src/modules/b2b-invoicing/types.ts` (add `unparsedRows` to `ParseResult`)
- Modify: `src/modules/b2b-invoicing/parser.ts` (`parseLineItems` → return items + unparsedRows, scoped to the items table)
- Test: `src/modules/b2b-invoicing/parser.test.ts`

- [ ] **Step 1: Add failing tests** — a malformed qty row in the items table is captured in `unparsedRows`; the header row is NOT; clean fixtures yield `unparsedRows: []`; rows outside the items table are NOT captured.
- [ ] **Step 2: Run, expect fail** (`unparsedRows` undefined).
- [ ] **Step 3:** Add `unparsedRows: string[]` to `ParseResult`. Refactor `parseLineItems` to: locate the items table (the `<table>` whose header contains `Item` + `Quantity`); within it, numeric-qty rows with a SKU → items, non-empty-SKU rows with a non-numeric qty → `unparsedRows` (raw trimmed text). If the items table can't be identified, fall back to the current whole-HTML item scan and return `unparsedRows: []` (no false positives). Thread `unparsedRows` into the `ParseResult`.
- [ ] **Step 4:** Run parser tests, expect pass; run full `b2b-invoicing` suite.
- [ ] **Step 5:** Commit.

### Task 2: Route — forward `unparsedRows` to the client

**Files:**
- Modify: `src/server/routes/invoicing.ts` (row builder ~330 / `buildRow` ~1159 — add `unparsedRows` from `parseResult`)
- Modify: `src/web/pages/invoicing-today.tsx` (`Row` type — add `unparsedRows: string[]`)

- [ ] **Step 1:** Add `unparsedRows: parseResult.unparsedRows` to the row payload object. Add `unparsedRows: string[]` to the client `Row` type. (`emailBody` is already sent.)
- [ ] **Step 2:** `npx tsc --noEmit` clean.
- [ ] **Step 3:** Commit.

### Task 3: Review UI — flag set, per-line verify, send gate

**Files:**
- Modify: `src/web/pages/invoicing-today.tsx` (per-row review component)

- [ ] **Step 1:** Add state: `verifiedLineIds: Set<string>`, `unreadAck: boolean`. Derive `flaggedRemoveIds` = lineIds of `editedActions` where `type==="remove"`; `hasUnread` = `row.unparsedRows.length > 0`. (Invoices only — skip the gate when `qbInvoice.docType==="salesreceipt"`.)
- [ ] **Step 2:** Extend the existing `blockedFromSend` computed value: also blocked while any `flaggedRemoveIds` not in `verifiedLineIds`, or (`hasUnread && !unreadAck`). Update the Send note to "Verify N flagged item(s) to enable" when blocked by flags.
- [ ] **Step 3:** Render the amber banner above the action rows when `flaggedRemoveIds.length || hasUnread`; turns positive when all resolved.
- [ ] **Step 4:** On each `remove` action row, render a "✓ verified against email" checkbox toggling membership in `verifiedLineIds`. If `hasUnread`, render a single "✓ checked the email" row toggling `unreadAck`.
- [ ] **Step 5:** "Keep instead ×[qty]" on each flagged remove row → call the existing qty-edit handler to set the line to `keep`/`qty_change` (qty default: email qty for that SKU if parsed, else invoice line qty). Converting drops it from the flagged set.
- [ ] **Step 6:** `tsc --noEmit` clean; manual logic check.
- [ ] **Step 7:** Commit.

### Task 4: Verify panel — comparison + sandboxed full email

**Files:**
- Modify: `src/web/pages/invoicing-today.tsx`

- [ ] **Step 1:** Add a collapsible "View source email (verify)" panel on the row. Comparison: left = `row.parsed.lineItems` + `row.unparsedRows` (unparsed highlighted), right = parsed lineItems.
- [ ] **Step 2:** "Show full email" toggle renders `row.emailBody` inside `<iframe sandbox="" srcDoc={row.emailBody}>` (no `allow-scripts`; never `dangerouslySetInnerHTML`).
- [ ] **Step 3:** `tsc --noEmit` clean.
- [ ] **Step 4:** Commit.

### Task 5: Verify end-to-end

- [ ] **Step 1:** `npx tsc --noEmit` + `npx vitest run src/modules/b2b-invoicing` green.
- [ ] **Step 2:** Playwright spot-check on the running dev app (Today→Orders): confirm a flagged row shows the banner, Send disabled→enabled on verify, panel opens, full-email iframe renders. (Synthetic data acceptable if no live flagged row.)
- [ ] **Step 3:** `/code-review` style pass over the diff; fix anything found.
- [ ] **Step 4:** Final commit; report.

## Self-review

- **Spec coverage:** detection (T1), payload (T2), banner+per-line verify+send gate (T3), inline keep-instead (T3.5), comparison+sandboxed full email (T4), salesreceipt exclusion (T3.1), tests (T1/T5). ✓
- **Type consistency:** `unparsedRows: string[]` used consistently across `ParseResult` (T1), row payload + client `Row` (T2), and UI (T3/T4).
- **Risk:** parser items-table identification — covered by the fallback in T1.3 + tests in T1.1.
