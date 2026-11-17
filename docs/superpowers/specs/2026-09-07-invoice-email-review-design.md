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

A dismissed row stays dismissed; if QBO later reports `EmailSent` it leaves
the never-emailed set anyway. The existing shipment-level "sent manually in
QBO" dismissal is untouched, but no longer hides the invoice from this
report — that is the safety net for the 3 Sep incident.

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
- no dismissal row

Delivery failed:
- `delivery_error IS NOT NULL`, `status <> 'void'`, `issue_date >= today - 90
  days`, no dismissal row. (Balance not required: a bounced invoice the
  customer later paid still tells us the address is bad.)

Rows are ordered oldest first, then balance desc.

### 4. API (`src/server/routes/invoicing.ts`, same auth as the rest)

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
  `audit_log` (`action: invoice_email_review.dismiss`, before/after).
- `POST /api/invoicing/email-review/restore` `{ invoiceId }` — delete
  dismissal; audit row.

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
  dismissed → null; NULL email_status → null.
- `email-review.route.test.ts`: GET shape + dismiss/restore audit rows,
  using the mocked-db pattern from `statements.test.ts`.
- Manual: deploy, wait one sync, confirm the never-emailed list matches the
  audit's bucket 2 for the last 90 days and the failed list shows the 15
  bounced invoices with `fak423@verizon.ne` visible on Elegant Linen rows.

### 8. Rollout

Migration 0057 (two `ALTER TABLE invoices ADD`, one `CREATE TABLE`). Manual
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

Operator A/B answer: no reply within 30 min of the question (13:39–14:10 UK);
proceeded with A per the standing "decide independently, flag at end"
convention and told the operator over radio that B is a cheap switch until
ship.
