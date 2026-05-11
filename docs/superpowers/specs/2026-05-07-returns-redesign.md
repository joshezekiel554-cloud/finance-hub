# Returns Workflow Redesign — Design Spec

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan
**Branch context:** continues `feat/returns-phase-5-7`

---

## Problem

The current returns flow (after the desktop integration) routes the operator through the Today tab's inline review dialog. In daily use this feels like a step backwards from the desktop app:

1. **Inline review is overengineered.** Today tab is doing the job of an inbox AND a processing surface, which clutters the inbox view and forces operators to do focused work without the right context (the RMA itself).
2. **Lost context.** Processing a return inside the Today tab means the operator can't see the RMA's full state (status history, customer profile, related emails) at the same time.
3. **No email aggregation.** Warehouse emails, damage reports, customer follow-ups all sit in Gmail. Nothing pulls them together by RMA, so the operator hunts manually.
4. **Bugs.** SKU order randomly changes during parsing. Credit memo emails go to the wrong recipient list (chase, not invoice). Credit memo memo doesn't appear on statements. Multiple smaller annoyances compound.

Goal: rebuild the flow so that Today is a triage inbox, RMA detail pages are the processing hub, and the create-credit-memo screen mirrors QB exactly so it feels familiar.

## Goal

A daily flow that looks like:

1. **Today tab** shows incoming warehouse emails as collapsible cards with the full HTML body. Three actions per email: `Dismiss — done` / `Dismiss — not return` / `Dismiss — other (provide reason)`. Auto-dismiss `done` once the linked RMA's credit memo is created.
2. **RMA detail page** has a Process Return panel with: all linked emails (auto-pulled by RMA# match), a "Parse warehouse return" button, a "Check for emails" button to force a refresh, a free-text damages note, and a Continue → Credit Memo button.
3. **Create credit memo page** mirrors QB exactly: SKU / description / expected / received / unit price / tax / total. Editable inline. Add/delete lines freely. Notes + memo at bottom. Email recipients pre-filled from invoice list (not chase). Send + create in QB.

## Out of scope

- Consignment renewal flow (separate module per existing plan).
- Extensiv API integration.
- Auto-completion of well-matched receipts (review-only stays).
- Photo upload changes (Drive integration unchanged).
- AI agent integration (will absorb the new tool surface naturally when it ships).

## Approach

Three architectural pillars:

1. **Passive email-RMA linking via Gmail poller.** A background scanner runs on every classified inbound email, regex-matches RMA# patterns, writes link rows to a join table. Cheap, persistent, makes the RMA page feel "alive" without per-page-load API calls.
2. **RMA-page-centric workflow.** Today is a triage inbox only. All processing happens on the RMA page, where the operator has full context.
3. **QBO-mirror credit memo create page.** Replace the existing `RmaCreditMemoDialog` with a screen that visually matches QBO's create-credit-memo UI. Familiarity reduces operator error and gives confidence that the in-app preview matches what'll show up in QB.

## Architecture

### 1. Email ↔ RMA linking

New table `email_rma_links`:

```
gmail_message_id  varchar(64)  PK
rma_id            varchar(24)  PK
source            enum('auto','manual')  default 'auto'
created_at        timestamp
```

Composite PK on (gmail_message_id, rma_id) so an email can link to multiple RMAs and vice versa.

**Population mechanisms:**
- **Gmail poll-time scanner.** When the existing classifier processes an inbound email, run a regex over `(subject + body)` matching all known RMA# formats: sequential `\b\d{5,7}\b` for seasonal/non-seasonal, `\bDC\d{5}\b` for damage. For every match, look up the RMA by number; if found, insert a link row.
- **RMA number assignment.** When an RMA is created or its number is assigned (currently happens at `approve` per existing plan), trigger a one-time backfill: search Gmail for that number across the last 90 days, link any matches.
- **Manual "Check for emails" button.** On the RMA detail page, a button that re-runs the backfill scan for that specific RMA. Used when Gmail is stale or operator just wants to force a refresh.

**Regex format module:** `src/server/modules/rma/rma-number-format.ts` exports the regex + a parser. Single source of truth so format changes propagate everywhere.

### 2. Today tab redesign

Today's returns section becomes a **list of warehouse emails as collapsible cards**.

Each card:
- Sender / date / subject header (Gmail-style)
- Body — full HTML, sanitized via existing sanitize-html pipeline, click to expand/collapse
- Linked RMA badges (clickable → RMA detail page)
- Three actions:
  - `Dismiss — done` (auto-fires when the linked RMA's credit memo is created)
  - `Dismiss — not return`
  - `Dismiss — other (provide reason)` — opens a small reason prompt before saving

Dismissed cards are persisted (`dismissed_at`, `dismissed_reason`, `dismissed_by_user_id`) and disappear from the default Today view. A toggle exposes them for audit.

**Unmatched emails (no RMA# match)** still appear in Today — they're the operator's hook to spot stuff outside the system. Each unlinked card has a "link to RMA" picker for manual association before processing.

**Removals from Today tab:**
- Inline parse / discrepancy table — gone.
- "Continue to credit memo" button — gone.
- Anything that requires processing without RMA context.

### 3. RMA detail page: Process Return panel

A new panel on the RMA detail page, visible when status is `sent_to_warehouse` or `received`.

**Components:**
- **Linked emails list.** Same card renderer as Today. Read-only; dismiss actions only available in Today (single source of truth for inbox state).
- **"Check for emails" button.** Re-runs backfill scan for this RMA's number.
- **"Parse warehouse return" button.** Builds the discrepancy table (next section) by:
  1. Selecting all linked emails of `email_kind = 'return_receipt'`
  2. Running the existing extensiv parser on each
  3. Merging extracted SKU/qty entries (sum across receipts when multiple)
  4. Joining with the RMA's items
  5. Producing the unified create-credit-memo screen
- **Damages note textarea.** Free text; persists on the RMA (`rmas.damages_note`). Shown on the create-credit-memo screen and merged into the QBO `CustomerMemo` field at submit.

### 4. Unified Create Credit Memo screen

Replaces the existing `RmaCreditMemoDialog`. Lives at its own route — `/returns/$rmaId/credit-memo` — so it's deep-linkable, the back button restores it, and the operator can refresh without losing state. Pressing "Parse warehouse return" on the RMA detail page navigates here. The screen mirrors QB:

**Header strip:**
- Customer name + auto-generated CM doc number (`DC#####` for damage, `<rmaNumber>CR` for seasonal/non-seasonal — existing convention preserved)
- Issue date (defaults today, editable)

**Lines table:**

| SKU | Description | Expected | Received | Unit price | Tax | Total | ⌫ |
|---|---|---|---|---|---|---|---|
| ABC123 | ABC123 (invoice 34344, 2026-04-15) | 5 | 3 | $19.99 | ☐ | $59.97 | x |
| XYZ999 | XYZ999 (invoice 34344, 2026-04-15) | — | 1 | $4.50 | ☐ | $4.50 | x |
| (blank — add line via QBO picker or manual) | | | | | | | |

- **SKU** — read-only after add (operator can swap by deleting + re-adding via picker)
- **Description** — auto-formatted as `<SKU> (invoice <docNumber>, <date>)`. Editable inline. Date format = QBO's native return value (typically ISO).
- **Expected** — original RMA item qty. `—` for unexpected items. Read-only.
- **Received** — what came back. Editable. Discrepancies surface visually:
  - Red text on Received when `Received < Expected` (short)
  - Amber text when `Received > Expected` (over)
  - Default (no color cue) when matched
- **Unit price** — pulled via the existing lookup-prices flow on add. Editable inline.
- **Tax** — per-line checkbox. Default OFF. Operator flips on for taxable customers.
- **Total** — auto-calculated `Received × Unit price`.
- **Delete (x)** — removes the line entirely.

**Below table:**
- "Add line" — uses the existing `QboItemPicker` component (with auto lookup-prices)
- "Add blank line" — fully manual entry option

**Subtotal / Tax / Total** strip below, computed from line totals.

**Notes** — small textarea, blank by default. Internal notes only.

**Memo** — bigger textarea, pre-populated with:
- The return-type standard memo ("damaged items" / "returns" / "seasonal returns")
- Plus the damages note from the RMA page on a new line

This is the field that gets sent to QBO as `CustomerMemo` (NOT `PrivateNote` — see Bug #4 below).

**Email recipients block:**
- `To` — pre-filled from customer's invoice recipients (NOT chase — see Bug #3 below). If empty, falls back to customer's primary email; shows a "No invoice recipients set" warning banner.
- `CC` — company-wide invoice CC, editable
- `BCC` — company-wide invoice BCC, editable
- All three editable as comma-separated lists

**Action buttons:**
- `Send + create in QB` — POSTs to QBO, persists email send via existing send-pipeline, marks RMA `completed`, auto-dismisses linked Today receipts
- `Save without sending` — creates in QB but doesn't send the email
- `Cancel` — discards the screen state, returns to RMA detail

## Bug fixes (independent of the redesign)

These three bugs are independent of the workflow redesign and should be fixed alongside (or before) the rest of the work.

### Bug #1 — SKU order randomization

**Symptom:** when SKUs are parsed from an email or pasted into the wizard items table, the order doesn't match the source.

**Investigate:**
- `src/web/components/rma-items-table.tsx` — wizard table. Check if a sort is applied during state updates or rendering.
- `src/server/modules/rma/extensiv-parser.ts` (or wherever the receipt parser lives). Confirm SKU/qty pairs are emitted in source-table order.

**Rule:** insertion order = parse order = email source order = display order. No sorting at any stage.

### Bug #3 — Credit memo email recipients

**Symptom:** credit memo send currently uses chase recipients.

**Fix:** swap the recipient default in the credit memo send-pipeline to use customer invoice recipients. Fallback chain:
1. `customer.invoiceRecipients` (if non-empty)
2. `customer.primaryEmail` (with a UI warning)
3. operator must manually enter (block send if all empty)

Company-wide CC/BCC come from settings (existing pattern from regular invoice sends).

### Bug #4 — Credit memo memo not on statements

**Symptom:** the memo we set on credit memos doesn't appear on QBO statements.

**Investigate:** audit the QBO API call that creates the credit memo. The fields are:
- `PrivateNote` — internal only, never on statements
- `CustomerMemo` — what statements read from
- `Line[].Description` — the per-line description

If we're setting `PrivateNote`, switch to `CustomerMemo`. If we're already setting `CustomerMemo` correctly, the QBO statement template needs configuring (one-time manual change in QBO settings, separate from this code work).

## File structure

**New files:**
- `src/db/schema/returns.ts` — additions: `email_rma_links` table; `damages_note` column on `rmas`; `dismissed_at` / `dismissed_reason` / `dismissed_by_user_id` columns on the existing `extensiv_receipts` (or whatever stores incoming warehouse emails)
- `migrations/<next>_email_rma_links.sql` — Drizzle-generated migration
- `src/server/modules/rma/rma-number-format.ts` — regex + parser, single source of truth
- `src/server/modules/rma/email-linker.ts` — scanner module: `linkEmailToRmas(messageId)`, `backfillLinksForRma(rmaId)`, `searchGmailForRmaNumber(rmaNumber)`
- `src/web/components/return-receipt-card.tsx` — collapsible card renderer (shared between Today tab and RMA Process Return panel)
- `src/web/components/process-return-panel.tsx` — RMA detail page Process Return panel
- `src/web/pages/credit-memo-create.tsx` — the unified QBO-mirror create-CM screen, registered at route `/returns/$rmaId/credit-memo`

**Modified:**
- `src/server/modules/email/inbound-classifier.ts` (or wherever Gmail poll's per-email handler runs) — call `linkEmailToRmas` on every newly classified email
- `src/server/routes/returns.ts` — new endpoints:
  - `POST /:id/refresh-email-links` (backs the Check for emails button)
  - `POST /:id/process-return` (replaces the receipt-confirm-then-CM flow, called by the unified screen on submit)
  - `POST /:id/dismiss-receipt` (backs the three Dismiss actions)
- `src/server/routes/invoicing.ts` — Today tab response includes linked RMAs per receipt
- `src/server/modules/qbo/credit-memo-builder.ts` (or equivalent) — switch from `PrivateNote` to `CustomerMemo` (Bug #4)
- `src/server/modules/email/send-pipeline.ts` — credit memo branch uses invoice recipients (Bug #3)
- `src/web/pages/return-detail.tsx` — wire `ProcessReturnPanel`, replace existing per-status panels where they overlap
- `src/web/pages/invoicing-today.tsx` — replace inline review section with new email card list using `ReturnReceiptCard`
- `src/web/components/rma-items-table.tsx` — preserve SKU order (Bug #1)
- `src/server/modules/rma/extensiv-parser.ts` (or equivalent) — preserve SKU order (Bug #1)

**Deletions (after the brief co-existence migration period — Q8 default):**
- `src/web/components/return-receipt-review-dialog.tsx`
- `src/web/components/rma-credit-memo-dialog.tsx` (the old dialog)

## Edge cases

### Multiple receipts for one RMA

Sometimes the warehouse splits processing into multiple emails. The unified screen handles this by **summing received qty across all linked receipts** when building the discrepancy view. Operator sees one combined table; the underlying receipts remain individually dismissible from Today.

### RMA number formats

The regex must cover:
- Sequential 5-7 digit numbers (seasonal / non-seasonal)
- `DC#####` for damage (current convention starts at DC38771)
- `<rmaNumber>CR` for credit memo doc numbers (these reference back to the RMA but should NOT auto-link the credit memo to its own source RMA — exclude this pattern from the email-linker)

### Stale Gmail data

The Check for emails button uses Gmail's search API directly, so it always returns the latest. The poll-time scanner is best-effort but could miss emails (e.g., poll downtime). The button is the operator's recovery path.

### Customer with no invoice recipients

For Bug #3 fallback chain — if a customer has no invoice recipients and no primary email, the Send button is disabled with a tooltip explaining why. Operator must add at least one recipient via the customer profile or directly in the To field.

### Existing receipts in flight at cutover

Per Q8 default — brief co-existence period (~1 week). Old `ReturnReceiptReviewDialog` stays available so in-flight receipts can finish through the old path. New receipts route through the new flow. After the cutover window, delete the old dialog and force-migrate any remaining open receipts manually.

### Damage emails arriving after credit memo is created

Edge: warehouse sends a damage report after the credit memo has already been issued. The auto-dismiss already fired on the receipt; the damage email links to the RMA but no further action triggers. UI behavior: damage email shows on the RMA page (now `completed`), operator can decide to issue an additional credit memo or note as documentation only. Out of scope for v1: automatically reopening a completed RMA — operator handles manually.

## Open questions / assumptions

These are locked in but flagged for explicit acknowledgment:

- **Tax default OFF per line** — most B2B customers are non-taxable. Operator flips on as needed.
- **Description date format** — ISO (`2026-04-15`) by default since QBO returns it that way. Add a US formatter only if the operator dislikes it.
- **Email auto-attach scope** — any sender, RMA# in subject or body. Broad on purpose so operator-CC'd emails get caught.
- **Multiple receipts → combined view** (Q6 default a). Rare in practice but handles cleanly.
- **Auto-dismiss `done` fires on credit memo creation**, not earlier (Q5).

If real-world testing surfaces a need to tighten any of these, the schema/UI is flexible enough to adjust.

## Implementation handoff

Next: invoke `superpowers:writing-plans` to break this design into a task-by-task implementation plan suitable for subagent-driven execution. Plan should sequence:

1. **Foundation:** schema migration, regex module, email linker module, server endpoints
2. **Bug fixes** (#1, #3, #4) — independent, can ship before the workflow redesign lands
3. **Today tab redesign** — replace inline review with email cards
4. **RMA Process Return panel** — new component, wire to RMA detail page
5. **Unified Create Credit Memo screen** — new component, replaces existing dialog
6. **Co-existence + cutover** — keep old dialog for one week, then delete

Reference: `docs/superpowers/specs/2026-05-06-url-state-design.md` (the prior URL-state spec) for the spec/plan/subagent-driven workflow we just used; same shape applies here.
