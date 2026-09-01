# Yiddy roster sales-focus report — design

**Date:** 2026-09-01
**Status:** approved-pending-review
**Type:** one-off generated deliverable (no app changes)

## Purpose

A self-contained interactive HTML report covering every `yiddy`-tagged
customer (~119 stores, Yiddy's commission roster), handed to Yiddy so he
can see where to focus sales effort: who's growing, who's gone quiet and
why, and what each store could be buying but isn't. Privacy is not a
constraint — Yiddy is well involved; balances and full details are shown.

## Deliverable

One static HTML file: embedded JSON data, vanilla JS, no external
dependencies, no server, no login. Searchable / sortable / filterable in
any browser. Josh reviews it, then sends Yiddy the file.

## Population & definitions

- **Stores:** customers whose `tags` JSON array contains `"yiddy"`.
- **An order:** a non-voided QBO invoice (`invoices` table). Value =
  invoice total. Both books combined (Feldart + TJ), with a per-book
  split shown where a store spans both. Shopify `orders` are used only
  for hold-lifecycle context, not for order counts/values.
- **Window:** trailing 12 months, month-by-month, plus the prior 12
  months for year-on-year comparison. Lifetime first-order date shown.
- **New product:** a `products` row created within the last 6 months
  AND after the initial catalog-sync epoch (rows seeded by the first
  sync all share one created date and are excluded — determined at
  generation time by finding that epoch date).

## Report structure

### 1. Roster overview (top of page)

- Headline stats: total TTM spend vs prior year, order counts, how many
  stores growing / steady / declining / dormant.
- **Win-back list:** ranked strip of the biggest opportunities —
  dormant or declining stores ordered by prior spend ("spent £14k last
  year, nothing in 5 months").
- **Season flag list:** stores that ordered in this same season last
  year (same-period YoY, e.g. Aug–Sep when generated in Elul) but not
  yet this year. Regenerating before Pesach flags that season instead.

### 2. Filter bar

Text search (store name), trend filter (growing / steady / declining /
dormant), blocker filter (on hold / prepay-only / clear), sortable
columns.

### 3. Summary table — one row per store

Store name · TTM spend · YoY % · TTM order count · days since last
order · typical order gap · trend badge · blocker badge.

### 4. Expanded store panel (click a row)

- **Call-sheet header:** phone(s), email, contact names/roles from the
  customer record; payment terms; current balance; overdue balance;
  hold status badge. (Deliberately no "last contact" date — the email
  log only sees the shared inbox, and stores often deal with Yiddy
  directly, so it would misread as "gone cold".)
- **12-month chart:** monthly order count + spend bars, with hold
  periods shaded onto the timeline (reason captured: customer on hold /
  prepay unpaid / overdue non-communicating / manual + note) so a lull
  visibly lines up with its cause. YoY comparison figures alongside.
- **Averages:** average order value TTM vs prior year, median days
  between orders, distinct SKUs bought TTM.
- **Orders dropdown (collapsed by default):** every invoice in the
  trailing 12 months — invoice number, date, value, book, paid/open
  status — with an "open invoices" subtotal above it. Older history
  stays aggregate-only to keep the file small.
- **Top 5 products** by value for this store (conversation opener).
- **New-product adoption:** which recently-added products the store has
  taken; "not yet taken" list as a pitch list.
- **Popular-gap list (top 10):** products ranked by *breadth* — how
  many other roster stores bought them in the TTM — that this store has
  not bought. Framing: "N of the stores we supply carry this."
- **Returns:** credit-memo count + value TTM.
- **Sanitized note:** one neutral AI-written sentence where
  `internal_notes` / hold notes explain something relevant (e.g.
  "account was on hold over an unpaid balance, resolved in June").

## Sanitized-notes workflow

1. Generator collects `internal_notes`, `ai_customer_context`, and
   order-hold notes per store.
2. Claude produces one neutral sentence per store (or none if nothing
   relevant) into a **separate review file**.
3. Josh reviews/edits that file; only then are the notes baked into the
   final HTML. Raw notes never enter the deliverable.

## Generation approach

- A read-only script queries prod MySQL over `ssh finance-vps`
  (established recipe). No writes to prod, no app/schema changes.
- Data is crunched locally; the HTML is rendered from a template with
  the JSON embedded.
- The script is kept in `scripts/` so the report can be regenerated
  later (e.g. pre-Pesach), but this build is a one-off deliverable, not
  a product feature.

## Metric definitions

- **Trend badge:** trailing-90-days spend vs prior-90-days and YoY;
  *dormant* = no order in over ~2× the store's typical gap (minimum 90
  days for low-frequency stores).
- **Typical gap:** median days between invoice dates (lifetime, so new
  lulls stand out against established cadence).
- **Season flag:** had ≥1 invoice in the same calendar period last year
  (generation month ± 1), none in that period this year.

## Out of scope

- Any finance-hub app changes (routes, UI, schema).
- Live/refreshing data — the file is a snapshot, regenerated on demand.
- Shopify order values (context only).
- Peer-gap analysis beyond the roster (popularity baseline is the
  roster itself, not all B2B customers — "stores like yours" framing).
