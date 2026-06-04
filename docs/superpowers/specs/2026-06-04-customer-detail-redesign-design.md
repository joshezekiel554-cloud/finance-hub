# Customer detail page redesign

**Date:** 2026-06-04
**Status:** Design approved (brainstorm, hi-fi mockup); pending spec review → plan
**Area:** Web — `src/web/pages/customer-detail.tsx` (desktop)

## Goal

Declutter the desktop customer detail page and give it clear hierarchy: a
compact header, a two-column body (work tabs + a persistent context rail),
customer **notes always visible**, and the **Activity tab rendered as a real
vertical timeline**. Every existing workflow stays (chase/collect,
correspondence, returns, account admin — the operator does all four).

Validated against a hi-fi mockup populated with real data (Bais Hasforim).

## Scope / non-goals

- **Desktop layout only** (≥ the `md` breakpoint). Mobile keeps its current
  single-column experience — the rail simply stacks below the main content.
- No backend/data changes. Reuses the existing customer GET, activities feed,
  AI card, AI context, internal notes, recipients, tags.
- No tab-content changes except Activity (timeline restyle). Invoices, Emails,
  Calls & SMS, Orders, Tasks, Returns tabs are untouched.

## Layout

**Header card** (full width): display name; a sub-line with email · phone ·
badges (customer type, terms, hold/active, `yiddy`, RMA-in-flight,
last-contacted). Right side, two rows: account-state actions (hold ▾, Sync
from QB) above outbound actions (Statement, Chase, New email, New task). The
Autopilot on/off toggle moves to a small control in the header (not its own
prominent line); the chase-dismissal banner stays conditional but rendered
inline within the main column, not in the prominent top stack.

**Two-column body** (desktop, flex):
- **Main column** (~65%): one card holding the existing tab bar + active tab.
- **Right rail** (~330px, persistent): a stack of cards (below).

The current prominent top stack — the 6-card KPI `StatCard` strip, the two AI
cards, the recipients row, and the Shopify-tags row — is removed from the main
flow; those move into the rail.

## Right-rail order (top → bottom)

1. **KPI mini-cards:** Overdue (red when > 0) + Balance (with open-invoice
   count). Open-tasks count and RMA-in-flight surface as header badges, not KPI
   cards.
2. **AI summary** (`CustomerAiCard`): condensed, with regenerate + suggested
   next action.
3. **Notes** (prominent, amber-accented card): always visible, inline-editable
   (✎ edit → textarea → save). Backed by `customer.internalNotes`.
4. **AI context** (`AiContextCard`): a collapsible `<details>`, collapsed by
   default.
5. **Recipients & account meta:** statement/chase recipients, phone, terms,
   unapplied credit, tags.

## Activity timeline

Rebuild the Activity tab (`src/web/components/activity-timeline.tsx`) from a
flat list into a vertical timeline. Same data and same filter/pagination — a
presentation rework:

- A vertical connector line; each event is a circular **node** (icon + colour
  by kind) with an event card to its right.
- Events **grouped by day** under a small uppercase day header.
- Per-kind icon + colour: `qbo_payment` green (highlighted card),
  `qbo_invoice_sent` blue, `qbo_credit_memo`/`rma_credit_memo_issued` violet,
  `qbo_statement_sent` blue (📄), `email_in`/`email_out` blue arrows,
  `rma_created`/`rma_approved` amber/green, `balance_change` slate (＄).
- Each event shows: title, time + source ("QB sync" / "you"), and a one-line
  detail with amounts and a contextual link (open thread / view CM / PDF) where
  the existing data supports it.
- Keep the existing filter (All / Emails / Payments / Returns) and the
  "load earlier activity" pagination.

## Notes behaviour

Notes are the rail card described above — the standalone **"Notes" tab is
removed** (the rail card is now the single, always-visible home for notes, as
shown in the approved mockup). Editing reuses the existing notes save path
(audit-logged customer update).

## Components affected

- `src/web/pages/customer-detail.tsx` — restructure the top render into the
  header card + a two-column grid; relocate `CustomerAiCard`, `AiContextCard`,
  recipients, tags, and KPI stats into the rail; add the Notes rail card; drop
  `notes` from the tab list.
- **New** `src/web/components/customer-context-rail.tsx` — extract the rail as
  its own component (customer-detail.tsx is already very large; a focused rail
  component keeps both manageable).
- `src/web/components/activity-timeline.tsx` — timeline rework.

## Mobile

Below `md`, the rail stacks beneath the main column (single column), preserving
today's mobile experience. The Notes card sits at the top of the stacked rail
on mobile so it stays reasonably prominent.

## Testing / verification

- Renders two-column with the rail on desktop; single column on mobile.
- Timeline: events group by day, correct icon/colour/text per kind, filter +
  load-earlier still work.
- Notes: inline edit saves and persists.
- The repo has no React component-test infra, so verify via the running app /
  Playwright (as with recent UI work), plus `tsc --noEmit`.

## Risks

- `customer-detail.tsx` is very large; the top-render restructure is the main
  effort. Extracting `CustomerContextRail` bounds the change and the file size.
- The timeline rework must preserve the existing activity filter + pagination
  semantics; map each current activity `kind` to a node/icon without dropping
  any kind (unknown kinds fall back to a neutral node).
