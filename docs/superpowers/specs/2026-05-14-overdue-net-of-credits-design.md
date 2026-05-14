# Overdue Balance Net of Unapplied Credit Memos — Design Spec

**Date:** 2026-05-14
**Status:** Awaiting user review
**Branch context:** new branch off `main`

---

## Problem

When we send a statement email today, the cover-note text says
"Total open balance is **$1,000**; of that, **$800** is past due." But that
"$800 past due" is the raw `customers.overdue_balance` column from QBO sync
— it ignores any **unapplied credit memos** sitting on the customer's
account. Same applies in chase emails (L1/L2/L3) and on UI surfaces that
display overdue (customer profile, customer list, chase page).

So a customer who genuinely owes us $800 overdue but has $200 in unapplied
credits gets dunned for $800 when the real ask is $600. Operator wants the
customer-facing overdue figure to reflect credits-already-on-account.

## Goal

End state:

1. Every place we show a customer-facing "overdue" figure subtracts
   unapplied credit memos, floored at zero.
2. Where it makes sense (statement cover email, chase emails, customer
   profile page), a short inline note tells the recipient/operator that
   the figure is net of credits and how much credit was applied — but only
   when credits actually exist on the account.
3. The QBO-style PDF statement attachment is unchanged. It already lists
   credit memos as separate rows and nets at the bottom; that's the
   formal document.

## Out of scope

- The QBO-style PDF statement renderer (`src/modules/statements/pdf.tsx`)
  — no changes; it already lists credit memos and computes net.
- Storing per-credit-memo detail in finance-hub's DB (credit memos remain
  activity-only; we only need the per-customer **aggregate** balance).
- The `renderStatementTable` HTML helper in
  `src/modules/statements/render.ts` — it isn't currently substituted
  into any live template (`statement_table: ""` in `send.ts:492`) and
  already nets correctly inside its own output.
- Real-time freshness of the aggregate. The cached column is updated on
  QB sync; staleness between syncs is acceptable since the PDF attachment
  is always live-fetched and is the formal document.

## Approach

Add a single per-customer aggregate column populated by the existing QB
sync. Build one tiny helper that converts `(overdueBalance,
unappliedCreditBalance) → effectiveOverdue` (floored at zero). Route every
display surface — `buildTemplateVars` for emails, UI components for
profile/list/chase — through the helper. Templates pick up a new
auto-empty `{{overdue_credit_note}}` variable that renders the
parenthetical note only when credits > 0.

## Architecture

### 1. Schema migration (`drizzle/0028_overdue_net_of_credits.sql`)

```sql
ALTER TABLE customers
  ADD COLUMN unapplied_credit_balance DECIMAL(12,2) NOT NULL DEFAULT '0';
```

Drizzle source: `src/db/schema/customers.ts` — add
`unappliedCreditBalance: decimal("unapplied_credit_balance", { precision: 12, scale: 2 }).notNull().default("0")`
adjacent to the existing `balance` / `overdueBalance` declarations.

No backfill script needed — the next QB sync repopulates the column for
every customer.

### 2. QB sync — populate the aggregate (`src/integrations/qb/sync.ts`)

`syncCreditMemos()` currently fetches all credit memos from QBO and emits
activities (`sync.ts:555-600`). Append a bulk recompute step mirroring the
overdue recompute at `sync.ts:340-360`:

```ts
// After credit memo activities are emitted, recompute the per-customer
// unapplied credit total in one UPDATE — same pattern as the
// overdue_balance recompute below the invoice sync.
async function recomputeUnappliedCreditBalances(): Promise<void> {
  // For every customer, sum the QBO-fetched credit memos with Balance > 0.
  // Source: in-memory `memos` array from the caller scope.
  // Write: customers.unapplied_credit_balance.
}
```

Implementation: aggregate `memos` by `CustomerRef.value` in JS, then do
one `INSERT ... ON DUPLICATE KEY UPDATE` style bulk write — or a single
`UPDATE customers c SET unapplied_credit_balance = COALESCE((SELECT ...), 0)`
if QBO credit memos get persisted to a transient table. Concrete SQL
shape is a plan-level decision; the spec just requires "one bulk write,
not per-customer."

Also wire into the per-customer single-sync path
(`syncSingleCustomer` / `qb/sync.ts:744-760`) so a one-off resync of a
single customer refreshes its unapplied credit total too.

### 3. Effective-overdue helper (`src/modules/customer-balance/effective-overdue.ts`)

New tiny module — single exported function:

```ts
export function effectiveOverdue(
  overdueBalance: string | number | null | undefined,
  unappliedCreditBalance: string | number | null | undefined,
): number {
  const overdue = parseAmount(overdueBalance);
  const credits = parseAmount(unappliedCreditBalance);
  return Math.max(0, Math.round((overdue - credits) * 100) / 100);
}
```

Why a dedicated module: this expression appears in `buildTemplateVars`,
two UI page components, and a chase-list query. One source of truth
prevents drift. Co-located with related future helpers (e.g.
`effectiveOpenBalance` if we ever need it).

### 4. Template variables (`src/modules/email-compose/template-vars.ts`)

Extend `BuildTemplateVarsInput.customer` Pick to include
`unappliedCreditBalance`. In the returned `TemplateVars` object:

- `overdue_balance`: change from `formatMoney(customer.overdueBalance)` to
  `formatMoney(effectiveOverdue(customer.overdueBalance, customer.unappliedCreditBalance))`.
- `unapplied_credit_balance` (**new** key): formatted credits string
  (e.g. `"$200.00"`).
- `overdue_credit_note` (**new** key): a pre-rendered string that's either
  `""` (when credits = 0) or `" (after $200.00 in unapplied credits applied)"`
  (with a leading space).

Templates can then write `{{overdue_balance}}{{overdue_credit_note}}` and
get the right behavior in both branches without conditional logic in the
template engine.

Update the `TemplateVars` type in the same file. Update all `select`/`Pick`
calls upstream (route handlers that load customers for chase/statement
sends — `customers.id, displayName, primaryEmail, balance, overdueBalance`
must add `unappliedCreditBalance`).

### 5. Seed email templates (`scripts/seed-email-templates.ts`)

Update the seed bodies + subjects so re-seeding (and reading the seed for
docs/diffs) reflects the new behavior:

- `statement_open_items` body: change `{{overdue_balance}} is past due.`
  → `{{overdue_balance}} is past due{{overdue_credit_note}}.`
- `chase_l1` body: change `of which {{overdue_balance}} is past due.`
  → `of which {{overdue_balance}}{{overdue_credit_note}} is past due.`
- `chase_l2` body: change `is now {{overdue_balance}} ({{days_overdue}} days past due...)`
  → `is now {{overdue_balance}}{{overdue_credit_note}} ({{days_overdue}} days past due...)`
- `chase_l3` body: same shape as L2.
- Subject lines of `chase_l2` + `chase_l3` (`overdue balance ({{overdue_balance}})`):
  leave alone — adding the note to a subject line clutters it; the body
  already explains.

Note: existing seeded templates in the DB do **not** auto-update — seed
writes are idempotent on slug but skip if the row exists. Operator can
re-seed via the existing `scripts/seed-email-templates.ts` runner if they
want the new placeholder rendered. For customers who don't re-seed, the
emails still send the **net** overdue figure (because `{{overdue_balance}}`
is now net), they just don't get the parenthetical note. Plan task will
include a one-shot update script that updates the four DB rows in place
for the operator's prod instance.

### 6. UI — customer profile (`src/web/pages/customer-detail.tsx`)

Find the "Overdue" stat card (existing component near the page header).
Replace its source from `customer.overdueBalance` to
`effectiveOverdue(customer.overdueBalance, customer.unappliedCreditBalance)`.
When `unappliedCreditBalance > 0`, render a small caption below the
figure: `net of $200.00 in unapplied credits`.

Customer fetcher (the `/api/customers/:id` endpoint backing this page)
must include `unappliedCreditBalance` in the JSON it returns.

### 7. UI — customer list (`src/web/pages/customers.tsx`)

Find the existing "Overdue" column. Display
`effectiveOverdue(...)` instead of raw `overdueBalance`. **Density wins**:
no inline breakdown text. Instead:

- Add a `title=` tooltip on the cell: `Overdue net of $200.00 in unapplied credits`
  (only when credits > 0; otherwise no tooltip, plain cell).
- Optional follow-up (not blocking): a `ⓘ` icon next to the column header
  with a tooltip `Overdue net of any unapplied credit memos.` — keeps the
  list scannable while flagging the policy to operators.

List API (`/api/customers` or equivalent) must include
`unappliedCreditBalance` in the row shape.

### 8. UI — chase page (`src/web/pages/chase.tsx`)

The chase list shows a per-customer overdue figure used both for display
and for tier-ordering. Two changes:

- **Display**: use `effectiveOverdue(...)` everywhere the chase row shows
  overdue. Same tooltip pattern as the customer list.
- **Sorting / severity**: the chase-engine severity score (currently
  `overdue × min(days_overdue, 365) / 30`) should use the **effective**
  overdue. A customer whose overdue is fully covered by credits should
  not surface as a chase target.

Both `chase-engine` server module + the chase route's customer fetch
must read `unappliedCreditBalance` and route through the helper.

## Edge cases

- **credits > overdue**: helper returns `0`. UI shows `$0` overdue; chase
  list excludes the customer (severity score is zero); chase emails would
  not be sent (no overdue to chase). The customer can still appear on
  the customer list with a non-zero balance and zero overdue — correct.
- **No credits**: helper returns raw overdue; `overdue_credit_note` is
  `""`. No visible change.
- **Stale column** (credits were applied or created in QBO since last sync):
  cached column is wrong until next sync runs. Acceptable because:
  (a) statement PDFs are live-fetched and are the formal record;
  (b) chase emails are operator-triggered with the operator looking at
  the same cached value the email will use, so they can re-sync if
  something feels off;
  (c) the auto-sync interval (default 15-30 min) bounds drift.
- **Decimal precision**: helper rounds to 2dp after subtraction; same
  precision as the source columns. Avoids `0.30000000000000004`-style
  display artifacts.

## Testing

- **`effective-overdue.test.ts`**: zero credits, positive net, credits >
  overdue (floor at zero), null inputs, string-decimal inputs (Drizzle's
  `decimal` returns strings), large-scale precision.
- **`template-vars.test.ts`** (extend): assert `overdue_balance` is net;
  assert `overdue_credit_note` is `""` when credits=0 and
  `" (after $X in unapplied credits applied)"` when credits>0.
- **`qb/sync.test.ts`** (extend or add): after `syncCreditMemos()`, the
  customers table has `unapplied_credit_balance` populated.
- **Smoke**: render a chase L2 preview for a customer with credits, eyeball
  the body string — should read naturally.

## Migration / rollout

- One Drizzle migration (`0028_*`).
- No data backfill — first sync after deploy populates the column. Until
  then, the column is `0` for everyone and behavior is unchanged from
  today.
- One-shot SQL script to update the 4 seeded templates in the prod DB
  with the new `{{overdue_credit_note}}` placeholder. (Plan-level
  task — committed alongside the migration.)
- No env vars, no feature flag — change is purely additive.
