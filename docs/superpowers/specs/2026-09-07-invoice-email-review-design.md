# Invoice email review — design

Date: 2026-09-07. Origin: `docs/superpowers/invoice-delivery-audit-2026-09-07.md`
(operator report "customers not receiving invoices"). Operator approved the
"never emailed report" over radio 2026-09-07 13:32; placement (A: section on
Invoicing Today) was my recommendation, unanswered — see decision log.

## Problem

The hub treats a 200 from QBO `/invoice/{id}/send` as delivered, and
Invoicing Today only offers invoices whose *shipment email* arrived. Two
blind spots follow:

1. Invoices that exist in QBO but were never emailed by anyone (shipment
   email dismissed as "sent manually", never parsed, or never arrived).
2. Invoices QBO accepted but later marked `DeliveryErrorType`
   (Bounced Email / Undeliverable). QBO sets that asynchronously; the hub
   never re-reads it.

Audit numbers since 1 Jul 2026: ~40 real never-emailed invoices, 15 + 1
bounced.

## Goal

One place on the Invoicing Today page that lists both buckets from data the
hub already syncs, with a Send and a Dismiss action per row, so nothing that
exists in QBO can silently stay un-emailed.

## Non-goals (follow-ups, not this pass)

- Auto-creating tasks / notifications on a bounce.
- The 100-char QBO `BillEmail` join guard in the send paths.
- Repairing the four bad customer addresses and resending the 16 bounced docs
  (operator data task; can be done from this UI once shipped).
- Sales receipts (463/485 are B2C `NotSet` by design; different signal).

## Design

### 1. Sync persists QBO email/delivery state (`src/integrations/qb/sync.ts`)

`getInvoices()` already runs `SELECT * FROM Invoice`, so `EmailStatus` and
`DeliveryInfo` are on the wire. Add to `QboInvoice` type:

```ts
DeliveryInfo?: { DeliveryType?: string; DeliveryTime?: string; DeliveryErrorType?: string };
```

New QBO-owned columns on `invoices` (migration 0057):

| column | type | source |
|---|---|---|
| `email_status` | varchar(32) null | `EmailStatus` (`NotSet` / `NeedToSend` / `EmailSent`) |
| `delivery_time` | timestamp null | `DeliveryInfo.DeliveryTime` |
| `delivery_error` | varchar(64) null | `DeliveryInfo.DeliveryErrorType` |

Written on the create path, in the ODKU set, and via `planInvoiceUpdate`
(added to both the drift check and the `set`). `sent_at` / `sent_via` stay
local-only as today. No backfill script: the next 30-min full sync populates
every row.

### 2. Dismissals table (`src/db/schema/invoice-email-dismissals.ts`)

Mirrors `dismissed_shipments`, keyed by the hub invoice id so sync never
touches it:

```
invoice_email_dismissals
  invoice_id            varchar(24) PK, FK invoices.id ON DELETE CASCADE
  reason                enum('sent_elsewhere','no_invoice_needed','other') NOT NULL
  reason_note           text NULL
  dismissed_at          timestamp NOT NULL default now()
  dismissed_by_user_id  varchar(255) NULL, FK users.id ON DELETE SET NULL
```

A dismissal only counts while it is **newer than the last delivery
attempt**: `dismissed_at > delivery_time`; if `delivery_time` is null it
counts only when there is also no `delivery_error` (an undated bounce can't
prove the dismissal came after it, so it stays visible). QBO moves
`DeliveryTime` on every send (observed 2026-09-06: eight Eichlers BP invoices
re-sent from the QBO UI all carry the same new `DeliveryTime`). So a
never-emailed invoice dismissed as "sent elsewhere" that is later sent and
bounces re-surfaces under Delivery failed, and a dismissed bounce that is
re-sent and bounces again re-surfaces too. (Found in Task 1 review: with a
plain "no dismissal row" rule the invisible-bounce class of failure would
have survived the feature.) If QBO later reports `EmailSent` with no error
the invoice leaves both sets anyway. The existing shipment-level "sent
manually in QBO" dismissal is untouched, but no longer hides the invoice
from this report — that is the safety net for the 3 Sep incident.

### 3. Selection rules (pure function + query, `src/modules/invoice-email-review/`)

`select.ts` exports `classifyForEmailReview(row, now)` → `"never_emailed" |
"delivery_failed" | null` and the constants below, unit-tested. The route
applies the same predicates in SQL and the pure function is the documented
contract:

Never emailed:
- `email_status IN ('NotSet','NeedToSend')` (NULL excluded, so the list is
  empty until the first post-deploy sync)
- `status <> 'void'`, `total > 0`, `balance > 0`
- `issue_date <= today` (drops the 2030-01-01 placeholders)
- `issue_date >= today - 90 days` (rolling window; pre-window history is the
  audit doc's job, not the daily queue's)
- `created_at < now - 24h` (grace: today's shipments are still in the normal
  queue)
- no *active* dismissal (see §2: `dismissed_at > delivery_time`, or
  `delivery_time` null)

Delivery failed:
- `delivery_error IS NOT NULL`, `status <> 'void'`, `issue_date >= today - 90
  days`, no *active* dismissal. (Balance not required: a bounced invoice the
  customer later paid still tells us the address is bad.)

`select.ts` also exports `isDismissalActive(dismissedAt, deliveryTime, deliveryError)` so
the route and the classifier share the one definition; the candidate carries
`dismissedAt` and `deliveryTime` rather than a pre-computed boolean. It
exports `emailReviewWindowStart(now)` too, and the route's SQL floor MUST use
it (not `CURDATE()`), so the pre-filter can never be narrower than the rule.
The "not future-dated" and "inside the window" checks apply to BOTH buckets
(keeps the 2030-01-01 placeholders out of the bounce list as well).
`issue_date` is selected as a `DATE_FORMAT` string: mysql2 returns DATE
columns as local-midnight `Date`s, which read back as the previous day on any
host ahead of UTC (the VPS is UTC today; the rule should not depend on it).

Rows are ordered oldest first, then balance desc.

### 4. API (`src/server/routes/invoicing-email-review.ts`, registered at `/api/invoicing/email-review`, same auth as the rest)

- `GET /api/invoicing/email-review` →
  ```ts
  { neverEmailed: Row[]; deliveryFailed: Row[]; dismissed: Row[]; syncedAt: string | null }
  Row = { invoiceId, qbInvoiceId, docNumber, customerId, customerName, origin,
          issueDate, createdAt, total, balance, status, emailStatus,
          deliveryTime, deliveryError, recipients: { to: string[]; cc: string[] },
          dismissal: { reason, reasonNote, dismissedAt, dismissedBy } | null }
  ```
  `recipients` come from `customers.invoice_to_emails` / `invoice_cc_emails`
  (what the send would use), so the bad address is visible in the row.
  `syncedAt` = `MAX(invoices.last_synced_at)` so the UI can say "as of".
- `POST /api/invoicing/email-review/dismiss` `{ invoiceId, reason,
  reasonNote? }` — upsert dismissal; `reason='other'` requires a note. Writes
  `audit_log` (`action: invoice_email_review.dismiss`, before/after) in the
  same transaction. Returns `{ ok: true, hidden }` where `hidden` is whether
  the dismissal actually hides the row now (false for an undated bounce, see
  §2); the UI shows a notice when it is false.
- `POST /api/invoicing/email-review/restore` `{ invoiceId }` — delete
  dismissal + audit row in one transaction; idempotent: returns
  `{ ok: true, restored: false }` when there was nothing to restore.
- Bucketing is a pure, tested function `bucketEmailReviewRows(rows, now)` in
  `src/modules/invoice-email-review/bucket.ts`; the route only runs the SQL
  and calls it.

Send reuses the existing `POST /api/customers/:id/invoices/:qbInvoiceId/send`
via `InvoiceSendDialog`; nothing new server-side for sending.

### 5. UI (`src/web/components/invoicing/email-review-section.tsx`)

Rendered on the Invoicing Today page directly under the shipment queue,
own `useQuery(["invoicing","email-review"])`, `staleTime` 60s.

- Header: **Email review** + "as of HH:MM" from `syncedAt`.
- Tabs: `Never emailed (n)` · `Delivery failed (n)` · `Dismissed (n)`
  (the dismissed tab is the restore path).
- Row: doc# · customer (link to `/customers/$id`) · issued + age ("5d") ·
  total / balance · recipients (TO bold, CC muted; on the failed tab the
  `deliveryError` pill sits next to them) · actions.
- Actions: **Send** opens `InvoiceSendDialog` (props already match:
  customerId, customerName, invoice {qbInvoiceId, docNumber, total, balance,
  issueDate, dueDate}); on `onSent` the row is optimistically removed and the
  query invalidated. **Dismiss** opens a small popover: reason select + note
  (required for "other"). Dismissed tab rows get **Restore**.
- Summary strip: a fourth `StatCard` "need email review" (never + failed
  count, warning colour) that scrolls to the section, so the count is visible
  without scrolling. Zero state: card shows 0, section shows a one-line
  "Nothing waiting — QBO agrees every recent invoice was emailed."
- Mobile: rows stack (doc#/customer line, then amounts, then actions) using
  the same pattern as `shipment-row-mobile.tsx`.

### 6. Error handling

- Sync: missing `DeliveryInfo` → nulls; unparsable `DeliveryTime` → null with
  a `warn` log, never throws.
- Route: dismiss on unknown invoice → 404; invalid reason → 400 via zod.
- UI: query error → inline retry button; send/dismiss errors → toast with the
  server message (matches existing dialogs).

### 7. Testing

- `sync.email-status.test.ts`: `planInvoiceUpdate` detects drift on the three
  new fields and includes them in `set`; no drift → null (regression for the
  existing exclusion of `sent_at`).
- `select.test.ts`: `classifyForEmailReview` table-driven cases: NotSet+open
  → never_emailed; NotSet+void → null; future issue date → null; < 24h old →
  null; > 90d → null; delivery_error set + paid → delivery_failed;
  active dismissal → null in both buckets; stale dismissal (older than
  delivery_time) → still classified; NULL email_status → null.
- `invoicing-email-review.test.ts`: zod body-schema contract tests (the
  repo's route-test convention, as in `statements.test.ts`); the GET's
  bucketing logic is covered by `bucket.test.ts` instead of an HTTP test.
- Manual: deploy, wait one sync, confirm the never-emailed list matches the
  audit's bucket 2 for the last 90 days and the failed list shows the 15
  bounced invoices with `fak423@verizon.ne` visible on Elegant Linen rows.

### 8. Rollout

Migration 0057 (three `ALTER TABLE invoices ADD`, one `CREATE TABLE`, two
FKs, one index; all instant/metadata-only on the hot `invoices` table). The
first sync after deploy will report `updated` ≈ every invoice (email_status
NULL → value) and re-run the per-invoice line resync once — pre-existing
per-drift behaviour, no activities or audit rows emitted. Because that resync
was delete-then-insert with no transaction, an over-long `sku` (varchar 64)
could strand an invoice with zero lines; this branch makes the resync
transactional and clamps `sku`. Pre-deploy baseline on prod (2026-09-07
15:30 UK): 73 invoices already have zero lines, 10 of them open — the
pre-existing hazard had already fired. **Post-deploy result (15:40 UK, forced
sync job 5762):** 3,419 invoices updated, 0 failed, 104 sku truncation warns,
and invoices-without-lines went 73 → **0** — the clamp let the previously
failing invoices resync their lines. `email_status`: 3,231 EmailSent / 353
NotSet / 24 NULL (rows no longer returned by QBO, all void). Email review
showed 27 never-emailed and 16 delivery-failed within the 90-day window,
matching the audit plus three June rows. Manual
deploy over `ssh finance-vps` per the standing recipe: build → tar dist +
migrations → `db:migrate` → `pm2 reload`. First sync after reload populates
`email_status`; the section is empty until then (by design, see §3).

## Decision log

- Section on Invoicing Today (A) rather than a new page (B): that page is
  the daily invoicing workstation; a separate page would be another place to
  forget to look. Operator answer recorded below.
- Dismissals in their own table rather than columns on `invoices`: keeps the
  sync-owned/local-owned split obvious and avoids widening `planInvoiceUpdate`.
- 90-day window + 24h grace: the report is a daily queue, not an audit; the
  audit doc covers history.
- No live QBO call from the route: the 30-min sync is already a full fetch,
  and a live call would add QBO latency/rate-limit risk to a page that loads
  many times a day.
- `syncedAt` is `MAX(invoices.last_synced_at)`, an unindexed aggregate over
  ~3.2k rows (≈1 ms). Not worth an index; revisit at six-figure row counts.
- The Dismissed tab is a *restore path*, not a dismissal history: a dismissed
  invoice that is later paid, voided, or emailed drops off it (the dismissal
  row stays in the table and in `audit_log`).
- No pagination: the 90-day window plus the NotSet/bounced pre-filter bounds
  the list to tens of rows in practice.

Operator A/B answer: no reply within 30 min of the question (13:39–14:10 UK);
proceeded with A per the standing "decide independently, flag at end"
convention. Operator confirmed "A please" over radio at 14:43 UK.
