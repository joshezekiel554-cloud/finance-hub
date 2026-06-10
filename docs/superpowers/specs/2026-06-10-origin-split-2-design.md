# Origin Split 2.0 — Full Separation (Feldart / Torah Judaica)

**Date:** 2026-06-10 · **Status:** Approved design, awaiting plan · **Branch:** `feat/origin-split-2`

Follow-on to the invoice origin split (Waves A+B, shipped 2026-06-09, spec
`2026-06-09-invoice-origin-split-design.md`). All four surface treatments
below were selected by the operator from high-fidelity mockups (visual
brainstorm session 330083-1781098583; mockups are gitignored session
artifacts — the selected options are fully described here).

## Problem

Waves A+B made origin first-class but presented it through **modes**: a
Feldart|TJ|Both toggle on /chase, a book lens + split/Combined columns on
/customers, and blended numbers in several places (customer-detail header
balance, dashboard chase widget, default statements). Operator pain, in
their words: "a bit messy still… effectively 2 separate things."
Specifically:

1. **The toggles themselves** — having to flip modes and remember which
   one you're in, instead of just seeing both books, separated.
2. **TJ workflow scattered** — chasing on /chase, dispute actions on
   customer detail; no single place showing the wind-down picture.
3. **AI ignores the split** — the autopilot proposer silently skips TJ;
   the customer AI card and digest treat the customer as one blob.

## Goal

Every surface treats the two books as **two separate things on one
page**: no view modes, no blended numbers, the TJ wind-down workflow
consolidated, and the AI working both books — separately. TJ surfaces are
designed to gracefully disappear as the wind-down book reaches zero.

## Out of scope

- A dedicated /tj area (explicitly rejected — two sections per page won).
- Auto-sending by AI (propose → approve stays, per CLAUDE.md).
- Wave C ideas from the original split (Vocatech-transcript AI assist,
  external 3rd-party TJ handover) — still deferred.
- Mobile redesign of pages not yet mobile-passed (/autopilot etc.) —
  sections must stack acceptably but the full row-card mobile pass stays
  a separate backlog item.
- Dashboard rework beyond the chase widget's book indicators.

## Design

### 1. /chase — Feldart queue + TJ wind-down panel

- Origin toggle **removed** (and its URL search-schema param dropped;
  stale bookmarks land on the new layout).
- **Feldart section** (indigo band): the existing chase table unchanged
  in shape — severity, overdue, oldest, last chase, per-row chase action,
  selection + batch send. Section header carries Feldart KPIs (overdue
  total, account count) and Feldart-scoped batch actions.
- **TJ wind-down panel** (amber band) below, purpose-built:
  - Header: net exposure, monthly delta (↓/↑ vs last month), verifying
    count, "next" hint (e.g. "chase 2 accounts ≥120d").
  - **Aging bar**: horizontal stacked bar of TJ exposure by age bucket
    (<90d / 90–180d / >180d).
  - **Customer rows**: net TJ owed (credits netted, per Wave A), open
    invoice count, dispute-pipeline chips (per-invoice state), TJ chase
    action (tj_l1/2/3 by severity tier).
  - Rows **expand inline** to per-invoice dispute actions: claims-paid →
    verifying badge + note → ✉ Email bookkeeper / Paid→Void (confirm) /
    Not paid — the full Wave B dispute loop, now operable from /chase
    (the "Dispute on customer page →" link goes away).
  - Batch statement sends from this section are TJ-scoped.
  - When TJ exposure is zero: panel collapses to a one-line "Torah
    Judaica wind-down complete — $0 outstanding" row; when the last TJ
    invoice is voided/paid and no disputes remain, hide entirely.

### 2. Customer detail — two book panels

- **Header**: blended balance/overdue line replaced by two pills —
  `Feldart $X · oldest Nd` (indigo) and `TJ $Y · M disputes` (amber).
  Pure-Feldart customers show only the Feldart pill.
- **Body** (within the existing two-column layout, content side): two
  self-contained panels replacing the origin-grouped invoice table:
  - **Feldart panel** (indigo left edge): per-book KPIs, invoice list,
    Chase/Statement actions. Always rendered.
  - **TJ panel** (amber tint): net exposure, verifying count, invoice
    list with inline dispute actions, TJ chase + ✉ Bookkeeper actions.
    Hidden entirely when the customer has no TJ history (same predicate
    as today's rail card: zero balance AND zero overdue — extended to
    also require zero open disputes).
- **Context rail** keeps shared, book-agnostic items: notes, AI context,
  recipients/terms. The split KPI cards in the rail are superseded by
  the header pills + panel KPIs (rail cards removed to avoid triple
  display).
- **AI summary card** (rail) becomes origin-aware: one read per book,
  rendered with origin chips (`FELDART` / `TJ`), e.g. "Feldart: slow
  payer, responds to L2+" / "TJ: claims 2 paid, awaiting bookkeeper
  since 06-02". Generation prompt receives per-book balances, invoice
  ages, dispute states; output schema gains per-book fields (single
  blob retained as fallback for customers with one book).

### 3. /autopilot — two proposal sections

- The proposer's hardcoded `origin='feldart'` scope is replaced by a
  **per-book run**:
  - **Feldart section**: proposals exactly as today.
  - **TJ section** (amber): TJ proposals using TJ severity (net of
    credits; `disputeState='verifying'` invoices excluded, per Wave B),
    tj_l1/l2/l3 templates with their tone rules, plus a new category:
    - **`tj_dispute_nudge`** — a verifying invoice whose bookkeeper email
      thread has been silent ≥ 7 days → drafts a follow-up to the
      bookkeeper. (Threshold constant; configurable later if needed.)
- All TJ proposals follow the existing lifecycle (pending → drafted →
  approved/dismissed; BullMQ executes on approve; audit_log rows). No
  auto-send.
- The daily **chase digest** gains a TJ section mirroring the proposer
  scope (it currently omits TJ silently).

### 4. /customers — Feldart list + TJ on demand

- Book lens and Combined column **removed** (URL params dropped).
- List is Feldart-shaped: one balance column (Feldart).
- **TJ strip** above the table (amber): "N customers carry Torah Judaica
  exposure ($total)" + a **Show TJ column** control that adds the TJ
  column (and a TJ-exposure sort) to the same list — additive reveal,
  not a mode; default off, persisted as a UI preference (localStorage).
- TJ-exposed customers get a small amber `TJ` chip beside their name
  (always, independent of the column).
- Strip and chip disappear when total TJ exposure is zero.

### 5. Cross-cutting

- **Dashboard chase widget**: rows gain book indicators — a customer
  with both books shows two amounts (indigo/amber color-keyed), never
  one blended number. Widget continues to rank by blended severity
  (computed per the audit-#12 fix) but displays per-book figures.
- **Statements**: every statement send is book-scoped by its trigger
  context (Feldart section/panel → Feldart statement; TJ → TJ). The
  blended both-books statement path is removed (API keeps `origin` as a
  required param on statement sends; the "both"/omitted value is
  rejected). Existing `sendStatement(origin?)` becomes `origin` required.
- **No blended money number anywhere operator-facing.** The denormalized
  `customers.balance`/`overdueBalance` fields stay in the DB (sync
  bookkeeping + candidate pre-filters per audit #12) but stop being
  displayed.

## Architecture notes

- **Backend largely exists**: per-origin balances with TJ credit netting
  (`computeOriginBalances`), origin-scoped chase lookups, dispute
  endpoints, per-origin statements, TJ templates — all Wave A/B. This
  project is mostly: new UI composition, removing mode params, the TJ
  proposer + dispute-nudge candidate, per-book AI card schema, digest
  section, and the monthly-delta + aging-bucket queries for the
  wind-down panel (new lightweight aggregation endpoint
  `GET /api/chase/tj-winddown` returning exposure, delta, aging buckets,
  verifying count).
- **Dispute-nudge detection**: a verifying invoice with
  `disputeClaimedAt`/last bookkeeper-email activity older than 7 days —
  derived from `email_log` rows linked to the dispute's bookkeeper
  thread; if no thread exists yet, nudge proposes the *first* bookkeeper
  email instead.
- **Component reuse**: the TJ panel (chase) and TJ panel (customer
  detail) share dispute-action components (`dispute-actions.tsx` exists)
  and an amber "book section" wrapper component; build once in
  `src/web/components/book-sections/`.
- **AI card schema**: `customer_ai_cards` gains nullable
  `summary_feldart` / `summary_tj` columns (existing `summary` kept as
  the blended fallback); actions array entries gain an `origin` field.
  Migration required.

## Testing

- Unit: TJ proposer scoping (verifying excluded, credits netted, tier →
  template mapping), dispute-nudge detection (7-day boundary, no-thread
  case), wind-down aggregation (aging buckets, monthly delta), statements
  origin-required rejection.
- Existing chase/balances test fixtures reused (Wave A patterns).
- Playwright pass on the four surfaces with a both-books fixture
  customer, a pure-Feldart one, and a pure-TJ one (DEV_USER_EMAIL local
  flow per `reference_local-dev-verification`).
- Mobile spot-check: sections stack; sticky headers respect `top-14
  md:top-0` (per the sticky-overflow gotcha).

## Risks / mitigations

- **Page length** on /chase and customer detail for both-books cases —
  mitigated by TJ auto-hide/collapse and compact TJ row design.
- **AI chasing TJ is new behavior** — guarded by the existing
  propose→approve gate; TJ templates' tone rules (firm-not-legalistic)
  already seeded; digest makes the new activity visible.
- **Removed URL params** break deep links — acceptable (internal tool);
  search-schema migration drops them silently.
- **Statements origin now required** — all callers updated in the same
  wave; API rejects rather than silently blending.

## Build order

- **Wave 1 — UI separation** (ships alone): chase page restructure +
  wind-down endpoint, customer detail panels + header pills, customers
  list strip/column, dashboard widget book indicators, statement origin
  scoping, URL param removal.
- **Wave 2 — AI separation**: TJ proposer + tj_dispute_nudge + autopilot
  sections, per-book AI card (migration), digest TJ section.

Each wave: worktree/branch → TDD where testable → Playwright verify →
independent Opus review → merge/push/watch deploy (per
`feedback_finance-hub-workflow`).
