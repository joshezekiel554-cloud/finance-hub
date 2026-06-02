# B2B shipment review — "verify against the email" parse-gap guard

**Date:** 2026-06-02
**Status:** Design approved (brainstorm); pending spec review → implementation plan
**Area:** B2B invoicing — shipment reconcile/review on Today → Orders

## Problem

The B2B invoice reconciler treats the **parsed** shipment email as ground truth for what shipped. In `reconciler.ts`, an invoice line whose SKU is absent from the parsed shipment becomes a `remove` action (reason `not_shipped`). The line-item parser (`parser.ts` → `parseLineItems`) **silently skips** any items-table row it can't read (non-numeric qty, empty SKU) — it `continue`s with no record.

So a parser miss (a malformed row, a format quirk) is indistinguishable from "genuinely not shipped": the shipped line gets a `remove`, and on send the B2B sender replaces the whole QBO `Line` array, dropping it. Result: the customer is **under-billed**, silently, in the direction nobody complains about. There is currently no signal in the UI that a `remove` might be a parse gap, and no way to see the original email at the point of review.

## Goal

At review time, surface when a line might have been dropped due to a parse gap, let the operator verify against the source email in one place, correct it inline, and block sending until each flagged line is acknowledged.

## Non-goals

- Improving the parser's accuracy / handling more email formats (separate effort).
- Anything for SMS/returns or non-B2B flows.
- Retroactive review of already-sent invoices.

## Decisions (from brainstorm)

1. **Trigger = Cautious (B):** show the warning banner when **either** the parser recorded an unreadable items-table row **or** any `remove` (`not_shipped`) action exists.
2. **Send gate = per-line tick-to-clear:** each flagged item gets a "✓ verified against email" control; Send stays disabled until all flagged items are resolved. Reuses the existing `blockedFromSend` pattern.
3. **Verify panel = comparison-first + full-email toggle:** default to a focused comparison (email rows vs parsed); a "Show full email" toggle reveals the rendered original.
4. **Fix flow = inline quick-fix:** a flagged `remove` line offers "Keep instead (qty __)", wired to the existing qty-edit handler to flip `remove → keep`/`qty_change`. Resolving via Keep-instead also clears that line's gate.

## Design

### Detection (backend)

**Parser (`src/modules/b2b-invoicing/parser.ts` + `types.ts`):**
- Add `unparsedRows: string[]` to `ParseResult` (and a matching field where the result is consumed).
- Today `parseLineItems` scans **all** `<tr>` in the HTML and `continue`s on any row that isn't a clean SKU+numeric-qty pair. Scope unreadable-row detection to the **items table only** — the table whose header cells are `Item`/`Quantity` — to avoid false positives from layout/other tables. Within that table, a row that has a **non-empty first cell** (looks like a SKU) but an **unreadable/non-numeric second cell** is pushed (raw trimmed text) to `unparsedRows`. The header row and clean rows are never added.
- `confidence`/`missingFields` are unchanged in meaning; `unparsedRows` is an independent signal. (Optionally note unreadable rows in confidence later — out of scope here.)

**Reconciler:** no change — `remove` actions already exist.

### Data flow

- **Route `src/server/routes/invoicing.ts`** (row builder, ~line 330): thread `unparsedRows` onto the row payload. `emailBody` (decoded HTML) is **already** sent to the client; no new email plumbing.
- **Client `Row` type** (`invoicing-today.tsx`): add `unparsedRows: string[]`.

### Review-card behavior (`src/web/pages/invoicing-today.tsx`, the per-row review component)

State already present: `editedActions`, the `addsNeedingPrice`-driven send block (~line 1111), and a qty-edit handler that transitions keep↔qty_change↔remove (~line 1121). Add:
- `verifiedLineIds: Set<string>` and `unreadAck: boolean` local state.
- **Flagged set** = lineIds of all `remove` actions in `editedActions`, plus a single "unreadable rows" flag when `unparsedRows.length > 0`.
- **Banner** (amber) rendered when the flagged set is non-empty; copy names the risk (lines marked not-shipped + N unreadable rows). Banner turns green/positive once all resolved.
- **Per-line verify:** each `remove` line renders a "✓ verified against email" checkbox → adds its lineId to `verifiedLineIds`. The unreadable-rows flag renders one "✓ checked the email" toggle → sets `unreadAck`.
- **Inline quick-fix:** each flagged `remove` line renders "Keep instead ×[qty]" — qty input defaults to the email qty when known, else the invoice line qty. Clicking calls the existing qty-edit handler to convert the action to `keep`/`qty_change`; that line is removed from the flagged set (no longer a removal to verify).
- **Send gate:** extend the existing `blockedFromSend` computed value to also be true while any flagged item is unresolved (not in `verifiedLineIds` / `unreadAck` false). Same disabled-Send + note pattern as `addsNeedingPrice`. Send note: "Verify N flagged item(s) to enable".

Only applies where actions are actually sent (invoices). For `docType === "salesreceipt"` (where the send path ignores actions), do not raise the gate — flagging there would be noise.

### Verify panel ("View source email")

- Collapsible panel on the row (default collapsed).
- **Comparison (default):** two columns — left, the email's item rows = parsed `lineItems` **plus** `unparsedRows` (the unreadable ones highlighted); right, what we parsed. Makes the discrepancy obvious without scanning the whole email.
- **"Show full email" toggle:** renders `emailBody`. Because this is **external HTML**, render it inside a **sandboxed `<iframe srcdoc=… sandbox="">`** (no `allow-scripts`) — dependency-free and XSS-safe. (Do not `dangerouslySetInnerHTML` the email body.)

## Edge cases

- **Multiple removes:** each needs its own verify tick. **Multiple unreadable rows:** one collective ack covers them (all shown in the comparison).
- **Keep-instead qty:** prefilled from the email qty for that SKU when we parsed it; otherwise the invoice line's qty; operator can edit.
- **Genuine not-shipped:** operator ticks verified; line stays removed.
- **No flags:** no banner, Send behaves exactly as today.
- **Already low-confidence parses** route to the existing "Unparseable" tab; this guard targets rows that parsed enough to land in Open but still carry a gap.

## Testing

- **`parser.test.ts`:** unreadable-row detection — stray-space qty, empty qty cell, header row NOT flagged, rows in a non-items table NOT flagged, multiple unreadable rows, and the existing clean-parse fixtures still yield `unparsedRows: []`.
- **Reconciler:** existing `remove` coverage stands.
- **Send-gate logic:** unit-test the "blocked while any flagged item unresolved → unblocks when all resolved (verified or kept)" computation (extract it pure if practical), plus that Keep-instead clears a line's gate.

## Files touched

- `src/modules/b2b-invoicing/parser.ts`, `src/modules/b2b-invoicing/types.ts` — `unparsedRows` detection.
- `src/server/routes/invoicing.ts` — include `unparsedRows` in the row payload.
- `src/web/pages/invoicing-today.tsx` — banner, per-line verify, send-gate extension, inline quick-fix, verify panel.
- Tests as above.

## Risks

- **Parser heuristic** is the main risk: detecting "unreadable item rows" without false-positiving on other tables/layout rows. Mitigated by scoping to the Item/Quantity table and dedicated tests. If the items table can't be reliably identified, fall back to detection-via-removes only (decision B still functions on the `remove` signal alone).
