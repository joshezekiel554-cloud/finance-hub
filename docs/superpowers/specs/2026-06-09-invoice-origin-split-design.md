# Invoice Origin Split — Feldart vs Torah Judaica (TJ)

**Status:** Design approved (brainstorm) — pending spec review
**Date:** 2026-06-09
**Owner:** Josh (Feldart accounts)

## Problem

Feldart's QuickBooks file holds two kinds of receivable, mixed together:

- **Feldart invoices** (docNumber begins `1`) — we supplied the goods, we can
  prove it, collection is simple: we are owed, we chase, we get paid.
- **Torah Judaica (TJ) invoices** (docNumber begins `2`) — legacy receivables
  handed over from Torah Judaica, who used to sell our items. This book is a
  **wind-down** (closed, only shrinks). It is messy: customers frequently claim
  they already paid TJ, and proof of payment lives in TJ's books, not ours, so
  every claim needs an out-of-band check with the TJ bookkeeper before we can
  void or keep chasing.

Today nothing in the hub is origin-aware. The two books are blended in every
view — balances, the chase list, scoring, autopilot, statements. The TJ noise
clouds the clean Feldart chase picture, which is the operator's primary pain.

**Goal:** make invoice origin a first-class dimension and separate the two books
across the app, so Feldart chasing is clean and TJ chasing is its own clearly
bounded track (runnable in-house now, handed to a third party later). A
lightweight, operator-driven dispute loop handles the "claims paid → verify with
TJ → void or resume" mess. **No AI in this phase** — AI may assist later (Wave C).

## Key decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Split model | **Logical** — explicit `origin` on invoices, no QBO surgery, customer stays 1:1 with QBO |
| Invoice classification | docNumber prefix `1`→feldart / `2`→tj (reliable for invoices), **stored explicitly** |
| Credit-memo classification | prefix unreliable; store origin explicitly, auto-classify where possible, manual sweep/override for the rest |
| Scope | **Scope 2, AI-free**, shipped Wave A then Wave B |
| TJ chase differences | softer tone + invite dispute (a); lower escalation ceiling, never hard final-demand (c); separate TJ templates (d); **one-click** park on push-back (e — manual, not auto-detected) |
| Chase list UI | **Toggle** on one `/chase` page: `Feldart | TJ`, default Feldart |
| Customer **detail** UI | **Both tracks visible, sectioned** — two balance KPIs in the rail, invoices grouped by origin with chips |
| Customer **list** UI | **Split balance columns** — Feldart + TJ columns always shown |
| Dispute resolution "Paid → Void" | **Hub voids in QBO** (with confirm), reusing the existing void write-path + audit row |
| Bookkeeper email | one-click **fixed template** (no AI), sent via existing Gmail compose; address configured in Settings |

**The app's origin rule (learnable in one line):** *lists toggle one book at a
time; the single-customer page shows both at once.* (The Customers list is the
one exception — it shows both balance columns rather than toggling, by request.)

## Data model

### 1. `invoices.origin` (new column)

```
origin: mysqlEnum('origin', ['feldart','tj']).notNull().default('feldart')
originSource: mysqlEnum('origin_source', ['prefix','manual']).notNull().default('prefix')
```

- Backfilled and kept in sync from docNumber: `startsWith('2') → 'tj'`, else
  `'feldart'`. The QB sync sets `origin` on upsert **only when
  `originSource = 'prefix'`** — a manual override (`originSource = 'manual'`) is
  never overwritten by sync.
- `originSource` lets the one-time sweep / manual corrections survive the 30-min
  sync. Indexed for the per-origin queries.

### 2. Credit memos — `credit_memos` (new table)

Credit memos are not stored individually today; the sync only aggregates their
unapplied balance per customer into `customers.unapplied_credit_balance`
(`credit-memo-aggregation.ts`). Per-origin balances require splitting that, so we
introduce a minimal table:

```
credit_memos:
  id                pk
  qbCreditMemoId    unique (from QBO)
  customerId        fk → customers
  docNumber         varchar
  balance           decimal   -- unapplied balance (what reduces AR)
  total             decimal
  origin            enum(feldart, tj)
  originSource      enum(auto, manual)
  appliedInvoiceId  fk → invoices nullable  -- when QBO links it to an invoice
  txnDate           date
  lastSyncedAt / createdAt / updatedAt
```

**Credit-memo origin auto-classification (in priority order):**
1. **Applied to an invoice** → inherits that invoice's `origin` (QBO LinkedTxn).
2. **Feldart-generated** → `feldart`. RMA/damage memos created in-app carry the
   `DC#####` counter (`app_settings`) and/or originate from the returns flow
   (`returns.qboCreditMemoId`). Treat those `qbCreditMemoId`s as Feldart.
3. **Otherwise ambiguous** → leave `origin` best-guess from prefix but mark for
   review (a "needs origin" flag surfaced in a one-time sweep UI; small volume
   expected). Manual override sets `originSource = 'manual'`.

`customers.unapplied_credit_balance` stays (blended, for back-compat), and we add
**per-origin** unapplied credit available via aggregation
(`credit_memos` grouped by `(customerId, origin)`).

### 3. Per-origin balances

Computed from `invoices` + `credit_memos` grouped by origin. Two options for the
chase/scoring hot path:

- **Compute on read** (preferred for v1): the chase + customer queries already
  scan invoices; add `WHERE origin = ?` / `GROUP BY origin`. No denormalized
  columns to keep fresh.
- If profiling shows it's hot, denormalize `balanceFeldart / overdueFeldart /
  balanceTj / overdueTj` onto `customers`, written by sync. **Deferred** unless
  needed.

The TJ chase numbers are **invoice-driven** (open TJ invoices + overdue). Whether
TJ unapplied credit nets against the TJ chase figure is a minor open question
(see Open questions) — default: show net, target chasing on open invoices.

### 4. Dispute state — `invoices` local columns (new)

TJ-only, local, never round-trips to QBO except the eventual void.

```
disputeState     enum(verifying, confirmed_paid, confirmed_unpaid) nullable
disputeClaimedAt timestamp nullable
disputeNote      text nullable
disputeUpdatedBy fk → users nullable
```

- `disputeState = 'verifying'` ⇒ invoice is **excluded from the active TJ chase
  list, scoring, and digest** (no more dunning).
- `confirmed_unpaid` ⇒ returns to the active TJ chase at the level it was on.
- `confirmed_paid` ⇒ triggers the QBO void (see Dispute flow); after the void
  syncs, `invoices.status = void` and the balance clears.
- `status` (the QBO-mirrored enum) is **not** overloaded with dispute states —
  dispute is a separate local concern.

## Behaviour

### Classification & sweep (Wave A)

- Migration adds columns + `credit_memos` table; a backfill sets `origin` on all
  existing invoices from prefix and runs the credit-memo auto-classifier.
- A one-time **"Review origin"** screen lists any `needs-origin` credit memos
  (and lets the operator override any invoice/credit-memo origin). Manual changes
  set `originSource = 'manual'`.

### Chase split (Wave A)

- `/chase` gains a `Feldart | TJ` toggle (query param `origin`, default
  `feldart`). Each side is an independent list: its own scoring, sort, batch
  actions, digest.
- Chase scoring (`modules/chase/scoring.ts`) becomes origin-scoped.
- **Autopilot:** the `chase-next` candidate (and other chase-ish candidates) are
  scoped to **Feldart only** in Wave A. TJ chasing is manual/templated; TJ is
  excluded from the AI proposer for now (revisit in Wave C).
- Customer **detail**: rail shows two KPIs (Feldart owed / TJ owed); the Invoices
  tab groups invoices into Feldart and TJ sections with subtotals + origin chips.
- Customer **list**: Feldart + TJ balance columns (consolidate or rely on the
  existing horizontal overflow for width; sticky header already in place).

### TJ tone + dispute loop (Wave B)

- **TJ template set:** new `tj_l1`, `tj_l2` chase templates (email_templates
  enum). Softer, acknowledge the handover, invite *"if you've already settled
  this with Torah Judaica, tell us and we'll verify."* **Lower ceiling** — no
  hard final-demand tier (2 levels, not 3).
- **Auto-pause on push-back (e):** when an inbound reply lands on a TJ chase
  thread, the operator gets a one-click park; (full auto-detection is explicitly
  *not* attempted — disputes mostly arrive by phone with varied phrasing).
- **Dispute actions** live on the TJ invoice row in three places: the TJ chase
  list, the customer page invoice row, and as a quick action after a logged call.
  - `Customer claims paid` → `disputeState = verifying`, stamps `disputeClaimedAt`,
    removes from active chase, exposes the note field.
  - `✉ Email TJ bookkeeper` → opens the existing compose modal pre-filled to the
    configured bookkeeper address with a fixed template referencing the invoice
    (number, customer, amount, date). Reply threads onto the customer timeline.
  - `Paid → Void` → confirm dialog → hub voids the invoice in QBO (reusing the
    existing void write-path), writes an audit row, balance clears on next sync.
  - `Not paid → Resume` → `confirmed_unpaid`, back into the TJ chase.
- **Settings:** `app_settings.tj_bookkeeper_email` (+ optional bookkeeper name).
- **Statements:** statement rendering filters by origin so a customer can receive
  a Feldart statement and/or a TJ statement, not a blended one.

## UI summary (mockups in `.superpowers/brainstorm/247903-*/content/`)

- **Chase:** one page, `Feldart | TJ` toggle, default Feldart. (`chase-ia.html`)
- **Customer detail:** both tracks visible — two rail KPIs + origin-grouped
  invoices with chips (`1·0241` purple = Feldart, `2·0567` amber = TJ).
  (`customer-origin.html`)
- **Customer list:** split Feldart + TJ balance columns.
  (`customers-list-origin.html`)
- **Dispute:** row button → Verifying badge + note + bookkeeper email + Paid→Void
  / Not-paid. (`dispute-flow.html`)

## Scope & phasing

- **Wave A — Foundation + unclouding (ship first, independently valuable):**
  origin columns + `credit_memos` table + backfill + sweep UI; per-origin balance
  queries; chase toggle + origin-scoped scoring; autopilot scoped to Feldart;
  customer detail two-track; customer list split columns.
- **Wave B — TJ tone + dispute loop:** TJ templates (lower ceiling); dispute
  state machine + row actions in all three places; one-click bookkeeper email +
  Settings; Paid→Void in QBO; per-origin statements.
- **Wave C — later, optional:** AI assist off **call transcripts** (suggest, never
  auto-pause); external handover (export or scoped login). Out of scope here.

## Testing

- **Classification:** unit tests for prefix→origin; credit-memo classifier
  priority (applied-to-invoice inherits; DC/returns → feldart; ambiguous →
  needs-origin). Sync does not overwrite `originSource = 'manual'`.
- **Per-origin balances:** invoices + credit memos aggregate correctly per
  origin; a TJ credit memo never offsets a Feldart invoice.
- **Chase split:** TJ invoices absent from Feldart chase/scoring/digest and vice
  versa; `verifying` invoices excluded from active TJ chase.
- **Dispute state machine:** verifying → confirmed_paid triggers void path;
  confirmed_unpaid resumes at prior level; audit rows written.
- **Real-app verification (Playwright):** toggle filters correctly; customer
  detail shows two tracks; dispute buttons drive the lifecycle; bookkeeper email
  pre-fills.

## Open questions (small, can resolve during planning)

1. **TJ credit & chase figure:** does TJ unapplied credit net against the TJ
   chase number, or is the TJ list purely "open TJ invoices"? Default: show net,
   chase on open invoices.
2. **Customer-list width:** which existing column (if any) to drop/consolidate to
   fit two balance columns, vs leaning on horizontal scroll. Decide at build time
   with the real columns in view.
3. **Credit-memo volume:** rough count of ambiguous legacy TJ credit memos — sizes
   the sweep UI (trivial if a handful).
4. **TJ chase levels:** confirm 2 tiers (`tj_l1`, `tj_l2`) is the right ceiling,
   or 1 gentle reminder only.

## Non-goals

- No physical split of customers into two QBO accounts (history loss, identity
  duplication, recurring surgery).
- No AI in Waves A/B. No inbound-email dispute auto-detection.
- No third-party access subsystem (roles/permissions) yet — deferred to Wave C
  once the handover arrangement is concrete.
