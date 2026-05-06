# Progress Log

**Source of truth for "where are we right now."** Updated after every
meaningful commit so any new Claude session (or human picking up work)
can re-orient in 60 seconds.

If you're new to this file:
- **Plan**: `C:\Users\user\.claude\plans\steady-crunching-kahn.md` (full roadmap)
- **Conventions**: `CLAUDE.md` in this repo
- **Memory**: `C:\Users\user\.claude\projects\C--Users-user-Documents-QuickBooksSync\memory\project_finance_hub_2.md`

---

## Current phase

**Customer-page chase email + per-invoice tracking. 🟢 SHIPPED**
(commits `1fa1499` → `f5aa7c5`, 2026-05-06, 2 commits). Operator-
requested polish: chase emails are now reachable directly from the
customer page (no need to flip to /chase), AND the Invoices tab
supports targeted chases on selected subsets — so an operator with
a customer who has 8 open invoices can chase just the 3 oldest
without dragging the others into the message.

**Backend** (`1fa1499`):
- New `invoice_chases` table (migration `0026_faulty_infant_terrible`)
  — one row per (invoice × chase email send), preserving history
  rather than just the latest. Composite index on
  (invoice_id, sent_at) backs the "Last chased" subqueries.
- `POST /api/chase/send-chase-email` accepts optional `invoiceIds[]`
  (≤100). Subset filter applied to the open-invoice fetch + the
  post-send `invoice_chases` insert. After the Gmail send succeeds,
  best-effort INSERT one row per scoped invoice; failure is logged
  but doesn't fail the request (the email already went out).
- Same `invoiceIds` param on `/preview-chase-email` so the dialog's
  template re-renders with the subset table when the operator
  switches level mid-review.
- Both routes gate the invoice fetch on `customers.id` WHERE so a
  cross-customer id-guess just falls out of the result set —
  defence-in-depth.
- `meta.invoiceIds: string[]` written on the chase activity row +
  `audit_log.after.invoiceIds` so future timeline UIs can show
  "chased these N invoices" by reading the activity meta.
- `GET /api/customers/:id/invoices` adds `lastChasedAt` +
  `lastChasedLevel` per invoice via correlated subqueries.

**Frontend** (`f5aa7c5`):
- `<ChaseEmailSendDialog>` gets an L1/L2/L3 segmented selector
  inside the dialog. Switching levels re-fetches the preview and
  re-snaps form fields. Optional `invoiceIds` prop threaded through
  to backend calls.
- Customer page header: new **Send chase email** button next to
  **Send statement**. Defaults to L1, opens the dialog scoped to
  "all open." Auto-fading "Chase L1 sent · N invoices chased"
  pill mirrors the statement-sent pattern.
- Invoices tab: new sortable **Last chased** column showing
  "5d ago L1" with tone gradient muted → secondary → warning
  across <7d / 7-30d / 30d+. Sort by `lastChasedAt` puts
  never-chased rows at the front in ascending order — directly
  enables the "show me invoices I haven't chased recently"
  workflow.
- Invoices tab bulk-action bar: when 1+ rows selected, **Send
  chase email** button appears next to "Download N PDFs". Filters
  to invoice rows (credit memos can't be chased), opens the dialog
  scoped to the selected ids.

**No backfill.** Pre-existing chase emails (from before this commit)
have no per-invoice rows in `invoice_chases`. Old invoices show as
"never chased" — operator can look at the activity timeline if they
care about historical context. Reconstructing from `activities` would
be inaccurate (only "all open at the time of send" was the scope, and
"open at that moment" isn't recoverable from the current schema).

---

**Pre-cutover bug-check + cleanup wave. 🟢 SHIPPED** (commits
`69c0a62` → `0e3c26f`, 2026-05-06, 10 commits). Five-agent code
review across the entire `feat/returns-phase-5-7` branch (returns
core backend, returns analysis modules, returns frontend, friction
polish, plus a synthesis pass) surfaced 17 critical + 15 important
findings. Six parallel implementation agents + me cleared the
backlog over a single session.

Top hits — these were real bugs, not nits:

- **Cache-invalidation gap was system-wide.** Every RMA mutation
  was invalidating only `["rma", id]`, leaving the customer's
  Returns tab, customers list `hasPendingRma` flag, chase RMA
  pill, and customer-detail KPI strip stale until hard reload.
  New helper `src/web/lib/invalidate-rma.ts` applied across 21
  mutation sites in `rma-action-panel`, all rma-*-dialog/action
  components, customer-detail RmaRowMenu, chase per-row send,
  email-list backfill (`69c0a62`, `1da048b`).
- **Wizard silently dropped operator data.** Items removed from
  local state never DELETEd on backend; items missing `qbItemId`
  silently skipped at Approve; `classification` edits on resumed
  wizards omitted from PATCH body. All three fixed (`c5291b9`).
- **Credit-memo line `Amount` ≠ `Qty * UnitPrice`** when
  `receivedQuantity` overrode the original quantity — wrong
  customer credit. Builder now derives Amount from qty × unitPrice
  (`7a74c48`).
- **Receipt-review "Create RMA from receipt" was unreachable** —
  customer search input had no result list and `setFrCustomer`
  was never called from any UI. Now wired with the same
  `CustomerPicker` shape from `return-new.tsx` (`c5291b9`).
- **`mark_already_credited` didn't verify CustomerRef** — operator
  paste-typo could silently link another customer's CM. Now
  cross-checks `cm.CustomerRef.value === current.qbCustomerId`
  (`d022fc3`).
- **`eligibility-pdf` GET trusted client-supplied `x-user-id`** for
  Drive token routing, despite calling `requireAuth(req)` and
  discarding the result. Auth bypass / IDOR. Now uses `user.id`
  from auth (`d022fc3`).
- **`/from-receipt` accepted `customerId`/`qbCustomerId` from body**
  without verifying the receipt was unconfirmed or that the ids
  matched. Now cross-checks both (`d022fc3`).
- **Photo upload + addRmaItem position** assigned via SELECT-then-
  INSERT, racing under concurrent uploads. Both wrapped in
  `db.transaction(...).for("update")` on the parent rmas row
  (`d022fc3`).
- **Drive folder allocation race** — two concurrent first-uploads
  on the same RMA both saw `driveFolderId=null` and both called
  `ensureFolder`, creating duplicate folders. Now atomic via the
  same FOR UPDATE pattern (`d022fc3`).
- **`/api/email/send` inherited Fastify's default 1MB bodyLimit**,
  silently 413-ing any meaningful multi-attachment send. Raised
  to 25MB + per-attachment Zod cap (`d022fc3`).
- **Customer-detail KPI dates not normalized** — mysql2 returned
  subquery TIMESTAMPs as `"YYYY-MM-DD HH:MM:SS"` strings, parsed
  by browsers as local time → "5h ago" for a 4h-old contact on
  BST. Wrapped through the same normaliser the list route uses
  (`7a74c48`).
- **Extensiv export tab/newline injection** — customer names with
  embedded `\t` or `\n` (rare but real for QBO data) silently
  broke warehouse parser column alignment. Now sanitised
  per-column (`7a74c48`).
- **Tier-3 fuzzy matcher was dead code** — the receipt classifier
  never extracted `inferredCustomerName` from the `Ref:` line, so
  the matcher's tier-3 fuzzy path got `null` for every receipt
  and never fired. Classifier now strips `\sreturns?$` + leading
  season token; threaded through `gmail/poller` (`7a74c48`).
- **Reply-linker fallback was dead code** — the "fallback" query
  was a strict subset of the first (additionally constrained on
  customerId) and could never return rows the first didn't. Test
  passed vacuously. Dropped (`7a74c48`).
- **Hardcoded `SHIPPING_FEE_ITEM_ID = "1"` placeholder** in the
  CM builder would either 502 ("Item id 1 doesn't exist") or
  silently issue CMs against whatever item id 1 happened to be.
  First moved to env vars (`0e3c26f`) then promoted to operator-
  editable `app_settings` rows (`ef9e520`) — same shape as the
  existing `drive_root_folder_id` / `warehouse_team_email` /
  `statement_bcc_email` config. Surfaced in `/settings → Returns`
  with two new input fields. CM builder loads from settings and
  throws if a deduction is requested with the matching id unset
  — refusing to silently issue against the wrong QBO item. **Pre-
  cutover blocker:** operator sets `rma_shipping_fee_item_id` and
  `rma_restocking_fee_item_id` to the real QBO service-item ids
  before issuing any CM with shipping or restocking deductions.

Important-tier hardening that landed in the same wave:

- **forceStatus + deleteRma now require admin** — `ADMIN_EMAILS`
  env var (mirrors existing `ALLOWED_EMAILS` pattern), `isAdmin()`
  helper checks against it. Empty list = nobody is admin
  (fail-closed). `deleteRma` also cleans up Drive folder + files
  best-effort before cascading the row delete (`31bf7a5`).
- **`confirmExtensivReceipt` now transactional** — receipt
  confirmation + RMA status advance no longer split-brain on
  mid-flight failure (`31bf7a5`).
- **`listRmas` accepts `offset`** — was silently truncating past
  500 rows (`31bf7a5`).
- **Matcher tier-3 customer-name match** uses token-overlap with
  4-char minimum — was bidirectional `includes()` so "Co" matched
  every "Cohen"/"Corp"/"Company" customer (`fcb03f3`).
- **AI parser hardened against prompt injection** — email body +
  attachment now wrapped in `<email>` / `<attachment>` markers
  with a system-prompt note that those tags are untrusted data.
  Input also truncated to 32KB to bound cost (`fcb03f3`).
- **Classifier item-row regex tightened** — SKU now requires ≥3
  chars + ≥1 letter, stopping false-positive matches on prose
  like `"1 5"` (`fcb03f3`).
- **Bulk markGmailAsRead** now bounded to 5-parallel via
  `mapWithLimit` with per-call error catch — was serial fire-and-
  forget, lost on process restart (`1d94dff`).
- **QBO sync upsert** now uses `INSERT ... ON DUPLICATE KEY
  UPDATE` instead of SELECT-then-decide. Per-customer sync vs
  global cron no longer noisily 502s on dup-key (`1d94dff`).
- **`extensivTxNumber` now UNIQUE** (migration `0025_fast_magik`).
  Schema previously allowed duplicate warehouse tx numbers across
  RMAs (`1d94dff`).
- **Compose modal received-qty validation, sync-route nanoid
  jobId, warehouse-number Enter-key empty guard** — small
  hygiene wins (`ab4e3e5`).

Test repairs in the same wave fixed 4 pre-existing failures
caused by mock-chain drift (`leftJoin` mock missing, a stale
`approveRma` non-seasonal expectation, the Drive `deleteFile`
test asserting the wrong call shape, and a vacuous
`excludeRmaId` test that had been passing without actually
exercising exclusion). 14 new tests added for the new behaviours.

**Final state:** typecheck `npx tsc --noEmit` exits 0. Test
suite: **451/451 pass across 29 files** (was 437/441 with 4
pre-existing failures before this wave).

**Deferred:** I14 (extracting nested step-renderer functions in
`return-receipt-review-dialog.tsx` to fix focus-loss on parent
re-render). Moderate effort for moderate impact; the file was
already heavily modified by A2 in the same session and another
big refactor felt risky. Track for a future polish pass.

**Pre-cutover operator action:** visit `/settings → Returns` and
paste the QBO Item ids for the shipping-deduction and restocking-fee
service items. Empty values are fine while operators don't yet have
those items in QBO — the CM builder only throws when a deduction
is actually requested. Plus add admin emails to `ADMIN_EMAILS` env
var (one operator at minimum, otherwise `forceStatus` + `deleteRma`
return 403 for everyone).

---

**3-day friction polish + Returns wrap-up. 🟢 SHIPPED** (commits
`3589642` → `adf53a4`, 2026-05-04 → 2026-05-06, ~11 commits).
Three back-to-back days of operator-friction fixes after the Returns
module landed, plus a per-customer QB sync fast-path and a customer-
page KPI overhaul. Branch `feat/returns-phase-5-7`; not yet merged
to `main`.

**Day 1 — friction list (`3589642`):** Unparseable tab now shows the
full email body inline (no more flipping to Gmail to read why we
couldn't parse). Stale "Has unactioned email" badge on customer rows
fixed via cross-cache invalidation when a row is marked actioned.
Compose-modal scroll for long bodies. Outbound Gmail sends now also
mark the originating thread as read locally. Compose modal grew
multi-attachment support + reply-all (`Cc` prefilled from
`/api/email-log/:id/recipients`).

**Day 2 — back nav + manual QB sync (`3d55578`, `77ba277`):** Every
"go back" affordance is now context-aware (return-detail's "back to
customer", wizard's "continue editing", today's "back to today"
preserve query state). New `<SyncQbBadge>` in the global header
showing relative time since last QB sync + a "Sync QB" button that
fires the global cron on demand. Then the per-customer fast-path:
`<SyncCustomerButton>` on the customer-detail page calls
`POST /api/customers/:id/sync-qb` → `syncOneCustomer(qbCustomerId)`
which re-pulls just that customer + their invoices + their payments
(~3 QBO calls vs hundreds for a full sync). Designed for "I need
fresh data right before sending a statement" — doesn't disturb the
30-min global cron.

**Day 3 — customer page glance (`adf53a4`):** Customers list +
chase list both got a small uppercase "RMA" chip next to the name
when the customer has an active RMA in flight (any of `draft`,
`approved`, `awaiting_warehouse_number`, `sent_to_warehouse`,
`received`). Both pages now have all numeric/date columns sortable,
including new ones — Last contacted, Last payment, Last statement on
customers; Balance, Last payment, Last statement on chase. Chase
gained two filter chips: "No terms set" and "RMA pending". Customer
detail header picks up "Last contacted N ago" + "RMA in flight"
badge, and the KPI strip at top extended from 4 to 6 cards (Balance ·
Overdue · Open invoices · Open tasks · RMA in flight · Terms),
served by a new `kpi` rollup on `GET /api/customers/:id` computed
in one round-trip alongside `recentActivities`.

**Backfill scripts (`388d781`, `3bb69ca`):** Three idempotent
one-shots for receipt-data hygiene —
`scripts/backfill-extensiv-receipts.ts` retro-classifies historical
secure-wms.com emails that arrived before the classifier was
deployed; `rematch-extensiv-receipts.ts` re-runs the matcher on
already-classified rows, auto-confirming when the linked RMA is
already `completed` (audit-only); `reparse-extensiv-receipts.ts`
re-runs the line parser when we improve the parsing logic.

**Today page rebuild (`01cfec4`, `3bb69ca`, `18867ed`):** Renamed
`/invoicing` → `/today`, restructured into vertical Orders + Returns
sections (was a flat list mixing both), added clickable top-line
stats ("18 shipments awaiting invoice" → click to filter), and
per-row email-body preview on receipt cards. Receipts now route
through their own pipeline — backend filters return-receipt emails
out of the shipment parser, exposes `emailSubject`/`emailFrom`/
`emailBody` so the UI can render context inline.

**Receipt classifier hardening (`037835a`, `1bf3aa8`, `ff35328`):**
Bluechip's HTML-only receipt emails (no plain-text MIME part) now
parse correctly via `stripHtmlForParse` preprocessing. The receipt
↔ RMA matcher widened to also accept `approved` and `completed`
RMAs at tier 1 (exact match), so historical receipts can be linked
to RMAs that were already issued credit memos in QBO — the link
is audit-only when the RMA is already `completed`.

**Returns module — phase 0 through 7. 🟢 SHIPPED** (commits
`7f2ae99` → `2c50dc4`, 2026-05-02 → 2026-05-04, ~80 commits over
3-4 days). The entire return-management workflow from the
standalone desktop app, absorbed into finance-hub. Plan was 8
phases × ~3 weeks; multi-agent execution compressed it to ~4 days.
Plan file at `C:\Users\user\.claude\plans\returns-integration.md`.

- **Phase 0 — schema + state machine + list page**:
  `7f2ae99` `02825f2` `cdfbe29` (migration `0020`)
  scaffolds `rmas`, `rma_items`, `seasons`, `seasonal_products`
  tables. `64cbdcc` builds the transition table; `dc8ed27` +
  `34eae7a` add `validateTransition` with happy-path + invalid-
  transition test coverage. Module barrel + CRUD service:
  `497905f` `612e455` `fda7ce5` `e240cfb` `710adf3`. Fastify route
  + sidebar nav: `6c06231` `3df65cd` `6791b5e`.

- **Phase 1 — damage flow end-to-end** (the simplest workflow,
  sets schema + UI shape): `fd6cfc3` (approveRma damage),
  `46fffa2` (denyRma), `71f5012` (issueCreditMemo + builder stub),
  `daf54b3` (markReplacementSent). Item CRUD: `a649af5` `282fef8`
  `0496587` `16dc632`. Discount-aware QBO price + invoice lookup:
  `2217d6a`. Discount-aware credit-memo lines: `f68e60a`. Wired in
  `bd1c9e3`. Email templates seeded: `c5af9e0`. UIs: `34c5d42`
  (`/returns/new` + damage branch), `c50d704` `c18ba35`
  (approval/denial dialogs), `ab4f2ff` (`/returns/:id` detail w/
  state-driven action panel), `b7c6d1f` (CM editor dialog +
  preview endpoint), `37f6977` (customer profile Returns tab),
  `d5c5b67` (timeline RMA events).

- **Phase 2 — Drive photo upload**: `c2aac11` (broadened Google
  scope to drive.file, requires re-consent), `376ee02`
  (`rma_photos` schema + `drive_folder_id` on rmas), `d1c2938`
  (Drive client), `0a95652` (upload/delete/list routes), `eeccd1a`
  (rename folder on RMA-number allocation), `f60c97f` (drag-drop
  zone + gallery), plus three Drive client fixes: `2bf55d6`
  (broaden scope from drive.file → drive after permission errors),
  `0918cf6` (accept either scope), `83ba8e8` (supportsAllDrives
  flag), `5cd7fc4` (wrap Buffer in Readable for upload),
  `01642d2` (Settings UI for `drive_root_folder_id` + reads from
  Auth.js accounts), `930dfa1` (bodyLimit + script to set folder
  id), `0c1d401` (snapshot FileList before clearing input).

- **Phase 3 — seasonal flow + eligibility + Extensiv export**:
  `542490c` (cumulative-this-season eligibility), `ff0464c`
  (eligibility PDF report), `cd99902` (Extensiv 15-column export
  builder), `543bc25` (seasonal approveRma + warehouse
  transitions), `fca4eca` (wire warehouse + eligibility +
  override-approve routes), `78fa805` `4c3726d` `062520c` (seasons
  + seasonal_products CRUD + UI w/ QBO search), `651221e`
  (eligibility card + per-item classification UI), `acfc5de`
  (warehouse export + set-tx-number UI), `5676490` (override-approve
  for negotiation flow), `7d7ec58` (AI parser for return-request
  emails).

- **Phase 4 — Extensiv receipt auto-match**: `c685cfb` (classifier),
  `e8e2f5a` (matcher), `d9abdea` (`extensiv_receipts` schema +
  migration), `d778ae7` (wire into Gmail poller), `867f7b7`
  (parallel QBO item search + UI errors), `52649b3` (link customer
  replies to RMA timeline), `3c4b56c` (receipt rows on /today +
  manual match/dismiss/confirm), `ad4947e` (receipt review dialog
  with single-shot CM flow + today wiring).

- **Phase 5 — non-seasonal flow**: `8fd5794` (refinements),
  `2a88262` `369e219` `73beba1` `a64be2f` `dfcd633` `007c94c`
  `236624f` `d96a76a` `6a47e46` `9a0b68d` `ab9bfdc` `3069785`
  `8151ef6` `37cdd72` `8031b95` `d5ab8d9` `bdece7c` `2a887cf`
  `4104287` (multi-step wizard for both seasonal + non-seasonal
  with bulk price+invoice lookup, customer-scoped lookup
  endpoints, auto-pick QBO match for parsed items, drop per-row
  auto-lookup for bulk button only, customer-scoped PDF preview,
  cancel/delete actions on detail+list+customer profile, revert-
  to-draft for editing in-flight RMAs, clickable step pills).

- **Phase 6 — backend infra + receipt review polish**: `361dcea`
  (tracking, sales tax, reconciliation, drill-down PDF), `0d5b6a0`
  (UI: damage wizard, resume, Kanban, action-panel reconciliation),
  `2c50dc4` (hand off receipt review to shared
  RmaCreditMemoDialog).

- **Phase 7 — selective desktop-SQLite import**: `2d917cd`
  (one-shot import script).

**Auth refinements (during returns work)**: `e2aff8e` (sign-out
button in sidebar footer), `94a40fb` (signout redirects to
`/api/auth/signin`), `402da79` (email-based account linking for
Google sign-in — was failing on existing email collisions),
`f5a4e72` (login redirect bounces to `/` instead of 404'ing).

---

**Invoices tab + editable-compose-everywhere. 🟢 SHIPPED** (commits
`5cf12d3` → `50302d9`, 2026-05-01, ~10 commits). Two threads
landed in one session:

**(1) Customer profile Invoices tab** got a complete rebuild:
- Unified table — invoices AND credit memos in one list, with a
  type pill per row (commit `5cf12d3`). Backend GET fetches local
  invoices + live QBO credit memos in parallel, gracefully
  degrades when QBO is flaky (`creditMemoError` surfaces inline).
- Filter chips (status: All / Open / Paid / Overdue / Sent / Void;
  type: All / Invoices / Credit memos) + doc# search input +
  sortable column headers (Doc # / Issued / Total / Balance) +
  footer totals showing "Showing N of M · Total $X · Open $Y"
  that update as filters narrow.
- New Memo column showing QBO `CustomerMemo.value` — synced into
  the local invoices table via migration `0019` and the
  `customer_memo text` field. Truncates at 220px with hover for
  full text. (Commit `2126e35`.)
- Per-row PDF download icon (uses existing /api/qb-pdf), Send
  button (always visible — flips label to "Re-send" when sent
  before), and "Remind" button on open invoices.
- Action column normalised: buttons in a fixed-width slot on every
  row, "sent {date}" caption stacked underneath when applicable
  (commit `95f6ab6`). Re-send is always available regardless of
  prior send state (`4910253`).
- Multi-select + bulk PDF download: row checkboxes with tri-state
  header checkbox; selecting 1+ rows surfaces a bulk-action bar.
  Server fetches the selected PDFs in parallel (CONCURRENCY=5, well
  under QBO's ~10rps cap), zips with jszip, streams a single
  archive back. Per-doc failures surface in a `_failed.txt` ZIP
  entry instead of 500-ing the whole request. Selection survives
  filter changes. (Commit `5418a8e`, new dep `jszip`.)

**(2) Editable-compose pattern applied across every outbound send**
— the operator now sees the templated message, can edit anything
(recipients / subject / body / attachments), and confirms before
send. Uniform shape across three paths:
- **Invoice reminder** (commit `d77438a`) — per-row "Remind" button
  on open invoices opens a dedicated `<InvoiceReminderDialog>`.
  New `invoice_reminder` template context + seed (editable in
  Settings) + extended `TemplateVars` (`invoice_number`, `total`,
  `balance`, `issue_date`, `due_date`, `days_overdue`). Dialog
  auto-fetches the invoice PDF and attaches it (with detach
  toggle). Send goes via `/api/send` which now accepts optional
  `refType`/`refId` overrides so the resulting `email_out`
  activity links to the invoice (refType="invoice") instead of
  the generic email_send.
- **Statement send** (commit `2cc848e`) — `StatementSendDialog`
  gains a Subject input + Body textarea, both pre-filled from the
  rendered `statement_open_items` template. The preview endpoint
  now returns the rendered template alongside the recipient list;
  the send route + `sendStatement` module thread overrides
  through, falling back to template defaults when not provided.
  Plain-text edits get auto-wrapped to <p>-broken HTML so a
  non-HTML body still renders as paragraphs in Gmail.
- **Chase per-row send** (commit `2cc848e`) — chase page action
  menu now opens a new `<ChaseEmailSendDialog>` instead of firing
  immediately. New `GET /api/chase/preview-chase-email` returns
  recipients + rendered subject + body for the chosen level;
  `POST /api/chase/send-chase-email` accepts the same overrides
  shape as statements.

**Loose-end cleanups in the same session:**
- One-click "Dismiss (B2C paid upfront)" button on `/invoicing/today`
  rows where the matched doc is a B2C SalesReceipt that got
  filtered out — saves three clicks per row in the dominant case
  (commit `55e434d`).
- All em-dashes (U+2014) stripped from email templates — both in
  the seed file and across all 6 already-seeded DB rows via
  `scripts/strip-emdashes-from-templates.ts`. Fresh installs land
  clean; re-runnable + idempotent (commit `50302d9`).
- Bug-fix: literal control bytes in `sanitizeFilenameSegment`
  regex were making `customers.ts` look like a binary file to git
  + grep. Replaced with proper escape sequences (commit `6ebf2c2`).

**Customer ops + B2B invoicing recipient overhaul. 🟢 SHIPPED**
(commits `a6a69c6` → `fac9231`, 2026-04-30 → 2026-05-01, ~25
commits). The single biggest substantive change since week 7:
finance-hub is now the canonical source of truth for every
customer's email recipients, and every send path was rebuilt to
honour it. 207/207 tests green throughout.

- **Per-channel email model** (commits `3add00c` + `a074693`,
  migration `0018`) — each customer now carries six JSON arrays:
  `invoice_to/cc/bcc_emails`, `statement_to/cc/bcc_emails`. The
  override paradigm is gone — these arrays *are* the values used at
  send time. Tag-driven routing rules (`yiddy` → BCC `sales@`)
  layered on top via `resolveRecipientsWithRules`. Migration
  backfilled every existing customer from the legacy `primary_email`
  / `billing_emails` columns. 12 new resolver tests pin the
  contract.
- **QBO Customer-entity limit, mapped + memoised** (commits `b728e56`
  + `54349bc`, then `a074693` removed the diagnostic card) — verified
  via Intuit docs that QBO's Customer entity has only
  `PrimaryEmailAddr` (no per-customer CC/BCC). Stripped the no-op
  `BillEmail/Cc/Bcc` push from the customer-update path. Saved as a
  reference memory so we don't relearn.
- **Send invoice from customer profile** (commit `544f165`) —
  customer detail's Invoices tab is real now (was placeholder).
  Per-row Send button → `<InvoiceSendDialog>` with editable TO/CC/BCC
  chip lists pre-filled from the resolver, tag-derived auto-BCC
  reasons surfaced read-only. Backend `sendInvoiceViaQbo` module:
  PATCH `BillEmail/Cc/Bcc` → POST `/send` → update local
  `invoices.sent_at`/`sent_via` → write `qbo_invoice_sent` activity.
  Single function used everywhere now.
- **`/invoicing/today` pre-fill switched to the resolver** (commit
  `ae253f5`) — was reading `BillEmail/Cc/Bcc` straight off the QBO
  invoice (almost always empty for B2B); now pulls per-channel arrays
  + tag rules. Yiddy-tagged customers get `sales@feldart.com` in BCC
  automatically. Operator review preserved.
- **`remove` action on the reconciler** (commit `b7266df`) — for the
  "warehouse didn't ship it" case, drops the line entirely instead
  of zeroing qty (cleaner billing — no phantom $0 row). qty=0 still
  selectable for split-shipment audit. Plus Shopify price column
  switched from retail (`li.price`) to per-unit paid
  (`pre_tax_price ÷ qty`).
- **SalesReceipt support on `/invoicing/today`** (commits `39f2696`
  + `4b936df`) — Shopify-prepay orders now match alongside Invoices,
  surfaced only when `customerType=b2b` (B2C upfront stays hidden,
  Shopify already sends those). Read-only line table (receipts
  settled), shortage actions emit a "Refund needed" pill +
  **Create refund task** button (high-priority `tasks` row with
  full paid-vs-shipped breakdown linked to the customer).
- **Reassign customer** (commit `9105001`) — tiny "change" pill in
  every `/invoicing/today` row header. Inline search-and-pick on
  finance-hub's local customer mirror; on submit, sparse-PATCHes
  CustomerRef on the QBO doc + invalidates the today list so the
  recipient pre-fill re-resolves against the new customer's
  arrays. Handles the OLD2-rename / split-account scenarios the
  operator used to fix in QBO directly.
- **Phones card** (commit `a6a69c6`, migration `0017`) — Main +
  labelled extras (bookkeeper, owner, AR clerk). Main syncs to QBO
  `Customer.PrimaryPhone`; extras are local-only.
- **Customers list polish** — unactioned-email count badge per row +
  filter chip (`a6a69c6`); email column → phone column; tiny
  "yiddy" indicator beside the displayName for roster customers
  (`c029f95`). Backend list projection now includes `qb_customer_id`
  and `tags` so picker + indicators work (`4fd18d5`).
- **Yiddy's roster end-to-end** — one-shot `scripts/tag-yiddy-roster.ts`
  tagged 119 customers (commit `4f67a85`). Generalised into Settings
  → Roster import (commit `fac9231`): tag input + paste-or-CSV +
  preview (matched / already-tagged / ambiguous / not-found) +
  apply. Reusable for any future tag-by-list workflow. Audit-log row
  per write (`customer.tag.add.roster`).
- **Smaller wins** in this wave:
  - Chase page: last-payment + last-statement columns + per-row
    chase-email actions (`1ae13ce`)
  - Statement BCC operator-controllable via app_settings (`81f7617`)
  - Non-ASCII subjects RFC 2047-encoded in `gmail/send` (`ed9e9c4`)
  - Shopify ID-first customer linking (`020dcbc`, `ce63068`)
  - Shopify rate-limit fix to stay under 2 req/sec (`1274b9a`)
  - Regression test for the paymentTerms-overwrite bug (`1f40aa2`)
  - Customer detail header: payment-upfront button + recipients/
    Shopify-id row + phone display (`82615e5`)

**Loose ends + Statement PDF polish. 🟢 SHIPPED** (commits `7146c24` →
`aa7da53`, 2026-04-30). Tightened the rebuild and closed a batch of
carried-over loose ends in one pass:

- **Statement PDF polish** — Preview PDF button on the send dialog
  (`f2bd94e`), fixed QBO `SELECT Id, InvoiceLink` query that was 400'ing
  → switched to `SELECT *` with `?include=invoiceLink` (`e31ea82`),
  widened column widths so OPEN AMOUNT + PAYMENT headers stop wrapping
  (`e31ea82`), seeded statement_open_items copy for the new PDF-as-
  attachment flow (`95793c9`), smoke tests for the renderer (`7146c24`).
- **Terms → DueDate recompute** (`76f1c85`) — editing payment terms
  (e.g. Net 30 → Net 60) now actually moves the due date instead of
  silently leaving it. QBO sparse update doesn't auto-cascade DueDate
  on SalesTermRef change; the route looks up the new term's `DueDays`
  and `buildPayload` computes `TxnDate + DueDays` in the same payload.
- **`requireAuth` on `/api/invoicing/*`** (`fb18d54`) — silent W4 gap.
- **RFC 5322 Message-ID threading** (`4a61a1a`, migration `0012`) —
  poller now captures the Message-ID header from inbound mail and Reply
  uses it as `In-Reply-To` instead of the Gmail-API messageId, so
  non-Gmail recipients thread correctly. New `email_log.message_id_header`
  column (varchar 998); legacy rows fall back to the API id.
- **Statements log page** at `/statements` (`43472d4`) — cross-customer
  audit list of every `statement_sends` row, joined to customer + sender,
  date-range + sender filters, load-more pagination. Read-only — the
  Gmail thread is the source of truth for what was actually sent.
- **Home alert for unsent invoices** (`aa7da53`) — replaced the planned
  11am invoicing cron with a frontend check on `/home`: past 11am London,
  if today's shipment emails aren't all sent yet, surface a red warning
  card with a CTA to `/invoicing`. No cron / no extra infra; piggybacks
  on the existing `/api/invoicing/today` query (shared cache key).

**Statement PDF rebuild. 🟢 SHIPPED** (commits `a43a15b` → `024fe42`).
Replaced the HTML-body-with-N-invoice-PDFs pattern from Week 7 with a
proper QBO-style Statement.pdf — single document, customer-facing
billing address, sequential statement number, per-invoice rows with
clickable Pay-now hyperlinks (resolved from QBO's InvoiceLink), red
overdue due dates, inline credit memos, footer with 5-line summary
+ payment methods, logo top-right + company info top-left. Fully
customizable via /settings → Statement PDF section: company info,
payment methods text, logo upload, next statement number. Atomic
counter starts at 6013 to clear the existing QBO range.

**Week 7 — Statements + Hold + Compose. 🟢 SHIPPED.** Multi-agent
parallel build across 3 waves (commits `72d93b9` → `af80bfd`).
Settings + email templates · Shopify hold (tag-based with prominent UI
signaling + confirm dialog) · Gmail aliases enumeration · template
variables resolver · gmail/send.ts extended (CC/BCC/attachments/reply
threading) · compose modal (slide-over with template picker, alias
dropdown, attachments) · Reply button wired into compose · statement
send backend (Path B: per-invoice InvoiceLink + unapplied credit
memos + attached PDFs) · single-customer Send Statement button +
preview dialog · /chase page with overdue list + batch send (bounded
concurrency, per-row failure isolation).

**Week 6 — CRM core. 🟢 SHIPPED + extensively polished.** Beyond the
core week-6 scope, an extra batch of post-shipping enhancements landed
(commits `a58f71e` → `18a9294`): dev-auth bypass, $ + PDF + amount on
activity timeline, Email tab w/ schema + API + UI, twin balance>0 and
balance=0 sweep selectors, Shopify-tag B2B import, per-customer email
backfill button, overdue balance recompute, Memurai-backed worker
process, BUSINESS_EMAILS filter (fix for Abraham Stern over-match),
labeled "Mark as actioned" chip per email row.

**Local infrastructure now production-realistic:**
- Memurai installed as Windows service → BullMQ worker runs
  alongside server + web in single `npm run dev`
- Worker firing all 3 schedules: qb-sync (30 min), gmail-poll (15
  min), chase-digest (5pm Europe/London daily). Verified via
  `sync_runs` table.
- Initial Gmail backfill landed ~509 emails (worker's 7-day default
  lookback; the 180-day historical pull hit Gmail's per-minute quota,
  acceptable since per-customer "Pull email history" button covers
  on-demand backfill from any customer's detail page).

**Bug-check pass landed (commit `4641b1f`)** fixed mention-regex email
collision, LIKE wildcard escapes, missing SSE events on delete/update,
and N+1 counts gap.

**Week 4 — B2B Invoicing module. 🟢 ~95% COMPLETE (feature-shipped, polish-grade).**

Reconciler + sender + `/invoicing/today` end-to-end interactive UI all live.
Send action goes through to QBO with email delivery + tracking pill.
Dozens of UX polishes shipped on top in the last 24h (see "What just shipped").

Done so far (week 4):
- Shopify OAuth callback wired (HMAC-verified, real code→token exchange,
  UPSERT to `oauth_tokens`) — `67c3576`, `d23b4be`
- Dev-only token rescue path (browser textarea + stdout banner when local
  MySQL is unavailable) — `ca94a74`
- Feldart shipment email parser + 16 unit tests — `01bf027`
- Shopify integration foundation (REST client, retry, pagination, orders
  read API) + 21 unit tests — `723b2c0`
- B2B invoice reconciler (keep / add / qty_change / set_metadata diff
  algorithm + 15 tests) — `180a1ab`
- QBO send action (sender.ts: builds sparse update, posts to QBO, handles
  401 retry, 15 tests) — `5856899`
- Local MySQL wired + 1.0 token migration script — `802e5dd`
- `/invoicing/today` end-to-end (route + page + Card UI) — `5be90b0`,
  `b5f7a87`, `1662cf7`, `36ad0e7`, `0ed2dbd`, `4ddb065`, `7d3f7d5`,
  `490f441`, `63451d9`, `5531e7c`
- QBO OAuth bootstrap script (`scripts/qb-oauth-connect.ts` +
  `qb-oauth-complete.ts`) — `0891542`, `063c1b4`
- Send → email customer (POST /invoice/{id}/send, "Sent to X at Y" pill)
  — `82ffeb5`
- Batch QBO invoice lookup (1 query instead of N) — `aeb7973`
- Suffix lookup (DocNumber=18303 → 18303-SP via date-windowed bulk fetch
  + client-side prefix match; QBO QL doesn't support OR) — `1925da3`,
  `1221eaf`
- QB token refresh fixes — single-flight mutex + CAS save (`956fca9`)
  AND the real bug: `x_refresh_token_expires_in` defaulting to 0 in
  `intuit-oauth` made `validateToken()` reject every refresh client-side
  (`f30526e`)
- Gmail speedup: htmlBody extracted during search + parallel fetches
  (10.7s → 2.4s on /today) — `76393fb`

Still to do for week 4 closeout:
1. ~~Invoice reconciler~~ ✅ shipped
2. ~~QBO send action~~ ✅ shipped
3. ~~`/invoicing/today` dashboard page~~ ✅ shipped
4. **BullMQ cron `0 11 * * *` Europe/London** — code exists, not yet
   registered in `src/jobs/schedule.ts`
5. **End-to-end shadow-mode validation** — pick 1-2 real invoices, send
   via 2.0, confirm QBO state matches what 1.0 would have produced

**Week 3 — ✅ COMPLETE** (engine ports + activity ingestion + BullMQ + shadow mode).
- Phase A: `7d662cc`, `33a4492`, `fc14554`. Phase B: `5b69ea2`, `e2a1c64`, `7e143b1`.
- All 8 review dimensions verified directly (reviewer agent didn't deliver).
- Crypto roundtrip, audit log atomicity, SHADOW_MODE gate, worker shutdown,
  scoped logging, no PII leakage, Europe/London timezone all confirmed.

## Latest checkpoint

**Date**: 2026-05-06 (customer-page chase email + per-invoice chase tracking committed)
**Branch**: `feat/returns-phase-5-7` (HEAD `f5aa7c5`) — not yet merged to `main`
**Last `main` commit**: `aa7da53` (2026-04-30 home alert)
**GitHub**: https://github.com/joshezekiel554-cloud/finance-hub
**Local repo**: `C:\Users\user\Documents\finance-hub`
**Status**: `npx tsc --noEmit` exits 0 silently · **451/451 tests pass** across 29 files · server + web + worker running via `npm run dev`
**Data populated**: 2,407 customers · 3,119 invoices · 19,184 invoice_lines · ~4,842 activities · 509+ emails · 9 email templates (added `rma_approval` / `rma_denial` / `rma_credit_memo` during returns build) · app_settings extended with `drive_root_folder_id`, `statement_bcc_email`, statement-PDF copy
**Migrations**: latest is `0026_faulty_infant_terrible` (`invoice_chases` table for per-invoice chase history). `0025_fast_magik` added UNIQUE on `rmas.extensiv_tx_number`. Returns work added `0020-0024` (rmas + rma_items + seasons + seasonal_products + photos + drive_folder_id + extensiv_receipts). `0019` added `customer_memo` on invoices.
**New env vars**: `ADMIN_EMAILS` (comma-list of admin operator emails) — required before pre-cutover; empty list = nobody is admin. The RMA fee item IDs are NOT env vars — they're set via `/settings → Returns` (`rma_shipping_fee_item_id`, `rma_restocking_fee_item_id` in app_settings).
**Local infra**: MySQL local · Memurai (Windows Redis) installed as service · QBO OAuth chain healthy · Google OAuth scope expanded to `drive` (RMA photo upload + folder rename)
**Smoke**: per-customer QB sync `POST /api/customers/{id}/sync-qb` → 200 in ~3 calls; `<SyncCustomerButton>` reflects fresh data instantly via React Query cache invalidation

## Active work

**None — ready for next phase.** Pre-existing carry-overs that are
still open but non-blocking:

1. 180-day Gmail backfill still partial (~6 days populated; per-customer
   "Pull email history" button covers on-demand backfill from any
   customer's detail page).
2. `customer-detail.tsx` doesn't have a ToastProvider (only `/tasks`
   does); statement-send shows an inline pill instead. Lift
   ToastProvider into App.tsx if we want toasts globally.
3. `relatedTaskId` field on `email_log` was never added to schema; the
   linkage is via `tasks.relatedActivityId` instead. Acceptable.
4. `feat/returns-phase-5-7` not yet merged to `main` — branch carries
   the entire Returns module + Today rebuild + 3-day friction polish.
   Merge gate is operator review of the full RMA flow on real data.

Closed during the 2026-04-30 → 2026-05-06 sweep:
- ~~Returns integration (8 phases, planned 3 weeks)~~ — shipped in
  ~4 days via parallel multi-agent work (see Current phase)
- ~~Per-customer QB sync fast-path~~ — shipped (`77ba277`)
- ~~Today page rebuild + receipt classifier~~ — shipped (`01cfec4`,
  `c685cfb` + family)
- ~~Customer-page glance metrics + RMA tag~~ — shipped (`adf53a4`)
- ~~Auth: sign-out from sidebar + email-based account linking~~ —
  shipped (`e2aff8e`, `402da79`)

## What just shipped (last 24h, 25 commits)

The whole interactive `/invoicing/today` experience plus three QB token
fixes culminating in the real one. Highlights:

**B2B invoicing UX:**
- Reconciler + sender, posts sparse update to QBO with full ship metadata
- Send → email invoice to customer's BillEmail (`POST /invoice/{id}/send`),
  "Sent to X at Y" pill in card header pulled from QBO's EmailStatus +
  DeliveryInfo.DeliveryTime
- Editable QB price + Shopify price column + qty_change auto-promote
- Customer memo (renders on invoice + statement) + DocNumber suffix (-SP for
  special-offer invoices, idempotent)
- Preview-in-QBO link
- + Add line picker with QB Item search (debounced autocomplete via new
  /api/invoicing/items/search)
- Email override block (To/CC/BCC; only sends overrides when changed
  from QBO defaults)
- Dismiss + Dismissed tab + reason dropdown (b2c_paid_upfront / etsy_faire
  / other-with-note); restorable
- Bulk dismiss for unparseable WMS noise rows
- Optimistic UI on dismiss/restore (no full refetch)
- Tab split: Open / Sent / Dismissed (Sent driven by EmailStatus = "EmailSent")

**Performance:**
- Batch QBO invoice lookup: 1 query instead of N for /today's row matching
- Suffix-renamed invoice lookup (18303 → 18303-SP) via single date-windowed
  bulk fetch + client-side prefix match (QBO QL has no OR support)
- Gmail speedup: htmlBody extracted during searchEmails + fully parallel
  detail fetches → /today went 10.7s → 2.4s

**QB token refresh — three layers of fix:**
- `956fca9` — single-flight Promise mutex per realm + compare-and-swap save
  (defends against concurrent refresh races + tsx-watch process restarts)
- `1221eaf` — replaced invalid `OR DocNumber LIKE ...` query (QBO 400)
  with date-windowed bulk fetch
- `f30526e` — **the actual root cause**: `intuit-oauth`'s `setToken()`
  defaults `x_refresh_token_expires_in` to 0 if you don't pass it. That
  makes `validateToken()` (called at the top of `refresh()`) throw "The
  Refresh token is invalid" client-side, before any HTTP call to Intuit.
  Every "expired" error we'd been chasing was this — re-OAuth always
  worked briefly because the OAuth callback path got the real expiry
  (~100 days) from Intuit's response, but our refresh code didn't carry
  it forward. Verified by direct probe: same stored refresh token went
  from rejected → succeeded once `x_refresh_token_expires_in` was passed.

**Deferred to later phases (still tracked):**
- Encrypt `accounts.access_token/refresh_token/id_token` (v2.1; Auth.js adapter wrapper)
- Dual-insert orphan in oauth_tokens callback (week 3, when Arctic flows land)
- `/customers /tasks` shipped week 6; `/agent` still placeholder for week 9
- CSP tightening in helmet config (week 7+ when asset origins are known)
- Persist `x_refresh_token_expires_in` to DB so we don't hardcode 100 days
  on every refresh (low priority — every successful refresh resets the
  100-day window anyway)
- Real Google OAuth credentials (currently `dev` placeholders + the
  DEV_USER_EMAIL bypass; needed before any non-localhost exposure)
- `requireAuth` on `src/server/routes/invoicing.ts` — silently
  unauthenticated since week 4. Genuine security gap if exposed
  beyond localhost.
- 11am invoicing cron registration in `src/jobs/schedule.ts`
- Position rebalancing for tasks Kanban under heavy drag-drop
  (lazy threshold-based)
- Inline-edit error toast on task drawer field PATCH failure

## What's done

**Week 1-2 — foundation:**
- ✅ **Project scaffold** (commit 9e70130) — Fastify v5 + Vite + React 18 + Tailwind v4 + UI primitives in `src/web/components/ui/`. Strict TS, env-validated boot via zod.
- ✅ **Stack pivots applied** (commits 53c8882, 4d58e1b) — Postgres → MySQL 8 (mysql2 driver), Lucia → Auth.js v5 (@auth/core + @auth/drizzle-adapter), Caddy → nginx, Docker (prod) → pm2. Reuses VPS infra from `orders.feldart.com`.
- ✅ **Drizzle schema** (in bundle 23a2d30) — 24 tables across 8 domain modules, 28 FKs, 51 indexes. Initial migration at `migrations/0000_dashing_mikhail_rasputin.sql`. Plus `dismissed_shipments` (added week 4).
- ✅ **Auth.js v5 + crypto** (bundle + 0e54b67) — Google SSO, allow-list gate, AES-256-GCM (10/10 tests pass), OAuth callback skeleton for QB/Gmail/Shopify.
- ✅ **Observability** (bundle + 769a40f) — Pino structured JSON logger, /health (DB+Redis), error middleware (zod 400, sanitized 5xx), Sentry-ready hook.
- ✅ **Deploy infra** (in bundle) — `.github/workflows/deploy.yml` mirrors orders.feldart.com pattern, `ecosystem.config.cjs` (pm2), `deployment/nginx-finance.feldart.com.conf`, `deployment/vps-setup.md` (week-9 checklist), `CLAUDE.md`.

**Week 3 — engines lifted, shadow mode live:**
- ✅ **QB integration** (`src/integrations/qb/`) — `client.ts` (axios + intuit-oauth, query/queryAll, sync routines), `tokens.ts` (encrypted DB storage, single-flight refresh mutex, CAS save), `sync.ts` (customer/invoice/payment/credit-memo sync writing to Drizzle).
- ✅ **Gmail integration** (`src/integrations/gmail/`) — `client.ts` (OAuth wrapper, withRetry, search + message fetch, htmlBody during search), `poller.ts` (scheduled poll → activity emission).
- ✅ **Activity ingestion** — Gmail poll matches sender → inserts `activities(kind=email_in)`. QBO sync emits activities for invoice_sent / payment_received / balance_change.
- ✅ **Chase logic lifted** (`src/modules/chase/`) — severity scoring + tier filtering, AI digest function. 26 tests.
- ✅ **Anthropic SDK pattern lifted** (`src/integrations/anthropic/`) — cost tracking + tool registry foundation. 13 tests.
- ✅ **BullMQ wiring** (`src/jobs/worker.ts`) — separate pm2 process, sync-every-30-min repeatable + chase-digest 5pm daily. SHADOW_MODE gate verified.

**Week 4 — B2B Invoicing:**
- ✅ Parser + Shopify integration + reconciler + sender + interactive `/invoicing/today` UI + email delivery + tab split (Open/Sent/Dismissed) + dismiss/restore + bulk dismiss + suffix-rename support + QB token refresh fully working.

**Week 6 — CRM core (just shipped):**
- ✅ **SSE infra** — domain event bus (`src/lib/events.ts`) + Fastify
  plugin (`src/server/plugins/sse.ts`) + auth-gated `/api/events/stream`
  + `useEventStream()` hook with single-tab connection + exp-backoff
  reconnect. Events: `activity.created` / `task.{created,updated,
  completed,deleted}` / `comment.{created,updated,deleted}` / `mention`.
- ✅ **Customer schema sweep** — `customer_type` enum('b2b','b2c') NULL
  on customers, indexed. Bulk-tag UI: select-all-balance-positive
  heuristic auto-includes 124 candidates of 2,407 customers.
- ✅ **Customers list** (`/customers`) — searchable table, tab filter
  (B2B/B2C/Uncategorized/All) with live counts, uncategorized banner +
  "Review now" sweep mode, sortable columns, links to detail.
- ✅ **Customer detail** (`/customers/:id`) — header (name, email,
  terms, type badge, hold pill, hold toggle), 4 stat cards, 5 tabs.
- ✅ **Activity timeline** — kind icons + tone, click-to-expand body,
  filter chips for kinds present, relative time ("3m ago"), SSE
  invalidation on `activity.created` for current customer.
- ✅ **Tasks Kanban** (`/tasks`) — Open/In progress/Blocked/Done columns,
  HTML5 drag-drop with float-position math + optimistic UI, list view
  toggle, filter bar (assignee, status, customer, priority, tags).
- ✅ **Task detail drawer** — slide-over with inline editing (title,
  body), assignee + customer pickers, due/priority/tags, watchers
  avatar stack + watch/unwatch, comments thread.
- ✅ **Comments + @mentions** — generic comments table keyed on
  `parent_type`+`parent_id`. Mention regex `(?<![\w.])@([\w.-]+)/g`
  rejects email-domain false positives. Resolves @-fragments to users
  by name-substring + email-prefix (LIKE-escaped). Mentions table
  drives bell-badge + per-user `mention` SSE event.
- ✅ **MentionInput** — textarea with @-trigger autocomplete, arrow
  keys + Enter + Escape; companion `MentionText` renders bodies with
  bolded mentions.
- ✅ **Initial QB data populated** — `scripts/qb-sync-once.ts` boot:
  2,407 customers + 3,119 invoices + 19,184 lines + 4,842 activities.

  Multi-agent execution: parallel `tasks-api` (commit 0063313) +
  `tasks-ui` (dec1e53) in isolated worktrees, integrated by team-lead
  (4641b1f), reviewed by bug-checker pass that landed 6 fixes
  (regex tightening, LIKE escape, missing SSE events, N+1 counts).

**Post-week-6 polish batch (commits `a58f71e` → `18a9294`):**
- ✅ **Dev-only auth bypass** (`a58f71e`) — `DEV_USER_EMAIL` env var
  synthesizes a session in non-prod when set; production guards via
  boot-time throw + runtime check + loud warn-log. Lets local dev
  proceed without real Google OAuth setup.
- ✅ **Customers list limits** — backend cap 200→5000 (`0bdb30b`),
  frontend request 500→5000 (`df26c12`) so the sweep covers the full
  table in one fetch.
- ✅ **Worker process running locally** — Memurai installed as Windows
  service; `npm run dev` launches server + web + worker via
  concurrently (`fa1abec`). Repeatable jobs ticking on schedule.
- ✅ **Activity timeline polish** (`16bf467`) — amounts (Intl currency-
  formatted) + #docNumber + inline PDF link rendering for
  qbo_invoice_sent / qbo_payment / qbo_credit_memo activities.
  `/api/qb-pdf/{invoice|creditmemo}/{qbId}` proxies QBO's PDF endpoint;
  no caching, browser opens in a new tab.
- ✅ **Email tab on customer detail** (`2ed82dd`) — schema:
  `email_log.actioned_at` + `actioned_by_user_id` + composite index.
  API: `GET /api/customers/:id/emails` (filterable: direction +
  actioned), `PATCH /api/email-log/:id` (toggle actioned), `POST
  /api/email-log/:id/to-task` (promote to task with relatedActivityId
  resolution). UI: filter chips, expandable rows, per-email actions.
  Followups: per-row checkbox (`0a74da6`) → labeled chip
  (`18a9294`).
- ✅ **Bounded Gmail concurrency** (`c7e0bc8`, `623900e`) —
  `mapWithLimit` helper at 10 parallel (was unbounded → ENOBUFS on
  big backfills + per-minute Gmail quota). One-shot
  `scripts/backfill-activity-meta.ts` rewrote 4,842 pre-norm meta
  rows to `{ qbId, docNumber, amount, currency, txnDate }` shape.
- ✅ **Twin sweep selectors** (`07f3133`) — "Select all balance > 0"
  (B2B candidates) + "Select all balance = 0" (B2C candidates).
- ✅ **Shopify-tag B2B import** (`926486d`) —
  `POST /api/customers/import-shopify-preview` queries Shopify for
  customers tagged `b2b` (configurable), matches by email, returns
  ids; UI shows preview + commits via existing bulk-tag mutation.
- ✅ **Overdue balance fix** (`ae10f25`) — `customers.overdue_balance`
  was always "0.00" because QB sync never wrote it. Added
  `recomputeOverdueBalances()` at end of `syncInvoices`: single
  bulk UPDATE...JOIN derives sum of overdue invoice balances per
  customer. Verified vs QBO: Cadeaux Judaica klein now shows
  $2,880 / $3,128.50 matching exactly.
- ✅ **Per-customer email backfill** (`d09ccb4`) — "Pull email
  history" button on customer Email tab. POST
  `/api/customers/:id/sync-emails` builds a Gmail query
  `(from:e1 OR to:e1 …)` for each address in primary + billing
  emails, fetches up to 1,000 messages, dedupes via UNIQUE
  constraint. Lets users grab a customer's full historical
  correspondence on demand instead of waiting for the worker.
- ✅ **BUSINESS_EMAILS filter** (`4dbebb7`) — extracted to shared
  `src/integrations/gmail/business-emails.ts`. QB sync's
  `parseBillingEmails` now strips feldart's own addresses before
  persisting, preventing the over-match disaster (Abraham Stern had
  650 emails wrongly attributed because info@feldart.com had been
  added as a billing CC in QBO). Cleanup ran out-of-band:
  650 email_log + 650 activity rows deleted, billing_emails stripped.

**Week 7 — Statements + Hold + Compose** (multi-agent, 3 waves,
commits `72d93b9` → `af80bfd`):
- ✅ **Settings + email_templates** (`72d93b9`) — `email_templates`
  table + migration + 6 seeded templates (chase L1/L2/L3,
  statement_open_items HTML body with `{{statement_table}}`
  placeholder, payment_confirmation, generic_reply). CRUD route
  `/api/email-templates`. Settings page (`/settings`) with
  tap-to-insert merge-variable chips in the editor.
- ✅ **Wave 1 — foundation** (parallel agents `8d511b2` `e2c8dbc`):
  - Agent A: `template-vars.ts` resolver + `buildTemplateVars` + 22
    new tests; rewrote `aliases.ts` with 5-min TTL cache and locked
    `GmailAlias` shape.
  - Agent B: Shopify hold full-stack — `findCustomerByEmail`,
    `getCustomerTags`, tag mutation helpers; `/api/customers/:id/
    {shopify-tags,hold-toggle}` route; `<HoldBanner>` red full-width
    component; customer-detail.tsx tags chips + confirm dialog;
    customers.tsx red-row + `Hold` critical badge.
- ✅ **gmail/send.ts extension** (`f657574`, team-lead) — added
  CC/BCC fields, `attachments?: Array<{ filename, mimeType, data:
  Buffer }>`, `threadId` + `inReplyTo` for reply threading. Switches
  MIME envelope from `multipart/alternative` to `multipart/mixed`
  when attachments are present.
- ✅ **Wave 2 — compose + statement backend** (parallel agents
  `ef5a06f` `d8ac948`):
  - Agent C: `<ComposeModal>` slide-over (From dropdown defaults to
    accounts@feldart.com, To/CC/BCC, Subject, Template picker,
    Body); POST `/api/email/send` (now mounted as `/api/send`);
    Reply button on Email tab wired to compose with thread context.
  - Agent D: `src/modules/statements/{render,send}.ts` — pulls open
    invoices + per-invoice `Invoice.InvoiceLink` (QBO Payments
    pay-now URLs) + unapplied credit memos; renders HTML statement
    table; fetches each invoice PDF (concurrency 5); sends via
    Gmail with all PDFs attached. POST
    `/api/customers/:id/statement-send`.
- ✅ **Wave 3 — UIs** (parallel agents `ba34c27` `6389c95` `af80bfd`):
  - Agent E: `<StatementSendDialog>` confirm + preview; "Send
    statement" button on customer detail (gated on balance > 0);
    auto-fading success pill. `GET /:id/statement-preview` extension
    on customers.ts.
  - Agent F: `/chase` page (overdue customers table with sortable
    cols, last-activity rollup via correlated subquery,
    holdStatus/customerType filter chips); `POST
    /api/chase/batch-statement` with concurrency-bounded fanout
    (max 5 parallel sends, per-row failure isolation, batch-level
    audit row); per-row Sent/Skipped/Failed pills after batch
    completes.
- ✅ **Verified end-to-end**: `GET /api/aliases` returns 8 verified
  Gmail aliases including `accounts@feldart.com`. `GET
  /api/chase/customers` returns Torah Judaica $104k overdue first.
  `GET /api/customers/:id/shopify-tags` returns real Shopify tags.
  Statement send route 404s correctly on invalid customer ids.
  181/181 tests green; typecheck silent.

## In progress

**None.** Recent wave (recipient overhaul + send paths) is shipped
and stable. 207/207 tests green.

## What's next

**Phase 8 — Returns cutover.** The Returns module is fully built
and on `feat/returns-phase-5-7`. Remaining work to call it done:
1. Operator review of the full RMA flow on real customer data —
   damage, seasonal, non-seasonal, receipt auto-match.
2. Merge `feat/returns-phase-5-7` → `main`.
3. Out-of-band cleanup: deferred items from the original plan that
   stayed deferred — consignment workflow (separate module),
   Extensiv API (manual upload kept for v1), auto-completion of
   receipts (operator confirm step kept).

**Week 9 — AI agent.** Returns is shipped, so the agent's tool
registry now includes RMA tools from day one. Foundations ready:
every tool the agent will call already exists as a clean function —
`resolveRecipients`, `sendInvoiceViaQbo`, `sendInvoiceEmail`
(statements path), `sendChaseEmail`, `createTask`,
`pushCustomerTermsToQbo`, `pushCustomerPhoneToQbo`, plus the new
RMA-side: `createRma`, `addRmaItem`, `approveRma`, `denyRma`,
`issueCreditMemo`, `validateTransition`, `cumulativeEligibility`,
`buildExtensivExport`, `parseReturnRequestEmail` — all auditable +
idempotent. Agent shape:
- `/agent` chat with `@customer-name` scoping syntax
- Tool registry (read tools auto-execute; write tools require explicit
  Approve click)
- Prompt caching: customer context + recent timeline (~5-10K tokens)
  cached as the prefix
- Inline helpers: "Draft chase email" (customer page), "Summarize this
  customer" (sidebar), "What should I do next?" (action suggestion),
  "Enhance with AI" (compose modal), and now also "Draft RMA
  approval/denial reasoning" + "Classify this return-request email"

**Week 8 — Notifications (still open, unblocking):**
- Email digest BullMQ job (7am daily) — feeds team summary of what's
  due, what's overdue, what landed yesterday
- In-app notifications panel (bell badge, unread count) — SSE broker
  already in place from week 6, schema partially built

**Week 10 — Cutover:**
- Shadow-mode parity verification (`SHADOW_MODE` env still defaults
  true in dev; flip to false in prod once confidence is there)
- Switch 2.0 to live writes; freeze 1.0

**Smaller follow-ups (each 30-90 min):**
- Visible disabled state on the rest of the SalesReceipt form
  (terms/discount/customer-memo) — server already ignores those for
  receipts; UI honesty pass
- Tasks: position rebalancing under heavy drag-drop, inline-edit error
  toast on task drawer field PATCH failure, drag-drop keyboard
  accessibility (deferred from week 6 bug-check)
- Optional: a "Roster — sync from URL" mode in the Settings import
  page, so the operator can authenticate to the localhost:8765/roster
  service once and pull updates without manual CSV export

**Week 4 leftover:** Real-invoice parity check vs 1.0 — the planned
11am cron was superseded by the home-page alert (`aa7da53`).

## Open items (need human input)

These don't block current work but block specific later phases:

| Item | Needed by | Status |
|---|---|---|
| ~~Create DNS A record `finance.feldart.com → 187.77.100.23`~~ | ~~Week 9 (deploy)~~ | ✅ Added 2026-04-30 |
| Verify VPS RAM headroom (KVM1 vs KVM2) | Week 9 | User offered to upgrade if needed |
| ~~QBO custom field IDs (tracking_number, ship_via, ship_date)~~ | ~~Week 5~~ | ✅ Resolved during week 4 — IDs known + wired in `sender.ts` |
| ~~Feldart shipment email format consistency check~~ | ~~Week 4~~ | ✅ Resolved — parser handles real-world variants; bulk-dismiss covers WMS noise |
| ~~Shopify "active" tag name~~ | ~~Week 7~~ | ✅ Resolved — tag is `b2b`; remove for hold, add to release. Hardcoded as `B2B_TAG` in `holds.ts`. |
| ~~List of Gmail aliases + context mapping~~ | ~~Week 7~~ | ✅ Resolved — `listAliases()` enumerates from Gmail; default to accounts@feldart.com (verified) |
| ~~Initial email templates (chase L1/L2/L3, etc.)~~ | ~~Week 7~~ | ✅ Resolved — 6 default templates seeded; user can edit via `/settings` |
| GitHub Actions secrets (`VPS_SSH_KEY`, `VPS_HOST`) | Week 9 | Reuse from orders project |
| Auth.js Google OAuth client redirect URI for `finance.feldart.com` | Week 9 | Add to existing client |
| MySQL DB + user provisioned on VPS (`feldart_finance` / `feldart_finance_app`) | Week 9 | See `deployment/vps-setup.md` step 2 |

## Conventions established

- **All agents commit their work before going idle.** No uncommitted work left in the working tree at the end of a turn — too easy to lose if a session restarts.
- **Team-lead pushes to GitHub** after every batch of agent work completes (don't push mid-flight to avoid races).
- **PROGRESS.md updated after every checkpoint** — this file. Agents can update too if they're tracking phase boundaries.
- **Plan file (`steady-crunching-kahn.md`)** is the spec. PROGRESS.md tracks execution against it. CLAUDE.md is the developer manual.
- **CLAUDE.md** at repo root carries project context — read first in any new session.
- **Memory file** at `C:\Users\user\.claude\projects\C--Users-user-Documents-QuickBooksSync\memory\project_finance_hub_2.md` carries cross-session context.

## Recovery procedure (if session dies mid-task)

1. Read `PROGRESS.md` (this file) → know latest checkpoint commit
2. Read `CLAUDE.md` → know stack + conventions
3. Read `C:\Users\user\.claude\plans\steady-crunching-kahn.md` → know roadmap
4. Run `git log --oneline -20` in finance-hub → see commit history
5. Run `git status` in finance-hub → see if anything was uncommitted
6. Pick up from "What's next" section above

## Commit log highlights

**Week 1-2** (scaffold + auth + schema + observability + deploy infra):

- `9e70130` — Initial scaffold
- `53c8882` — Pivot deps: postgres→mysql2, +Auth.js v5
- `4d58e1b` — Document VPS deployment
- `23a2d30` — Week 1-2 foundation bundle (schema, auth, observability, deploy infra)
- `0e54b67` — Auth.js basePath fix
- `769a40f` — fastify-plugin wrap to break encapsulation for hooks
- `6707674` — TODO note on dual-insert orphan in oauth callback
- `13736a6` — oauth_tokens indexes + cleanup
- `51912ed` — PROGRESS.md added (resilience layer)
- `f0d357a` — CI workflow on push/PR
- `21f46bc` — Schema fix: oauth_tokens widening + unique constraint
- `39f83a7` — Observability fix: error handler before routes, sentry timing
- `ab601e2` — Auth fix: multi-cookie, atomic state, trustProxy, cookie order, fp wrap
- `f4aef0f` — Wave 2: tsc-alias build + security plugins + smoke path + cleanups

**Week 3** (engine ports + activity + BullMQ + shadow mode):
- Phase A: `7d662cc`, `33a4492`, `fc14554`
- Phase B: `5b69ea2`, `e2a1c64`, `7e143b1`

**Week 4 — B2B Invoicing** (the big one — ~30 commits):

- `01bf027` — Feldart shipment email parser + 16 tests
- `723b2c0` — Shopify integration foundation (REST + retry + pagination)
- `180a1ab` — B2B invoice reconciler + 15 tests
- `5856899` — QBO send action (sender.ts) + 15 tests
- `802e5dd` — Local MySQL + token migration script
- `5be90b0` — `/invoicing/today` end-to-end (route + page)
- `ec937c1` — Fix LIVE banner false positive
- `b5f7a87` — Make page interactive (live send, edits, discount, notes)
- `1662cf7` — Final qty editable on every line (keep ⇄ qty_change auto-promote)
- `36ad0e7` — Always blank CustomerMemo on send + SalesTermRef override
- `0891542` — Real QBO OAuth exchange + connect script
- `063c1b4` — `qb-oauth-complete.ts` playground-redirect fallback
- `b0ee2ad` — Clear PrivateNote on send (kill auto-sync junk)
- `82ffeb5` — Email invoice to customer after update (Sent to X at Y pill)
- `aeb7973` — Batch QBO invoice lookup (1 query not N)
- `0ed2dbd` — Editable QB price + Shopify price col + customer memo + DocNumber suffix + preview link
- `1925da3` — Backend foundation: suffix lookup + email/history/tracking exposure
- `4ddb065` — + Add line picker with QB Item search
- `7d3f7d5` — Email override To/CC/BCC
- `490f441` — Dismiss + Dismissed tab + reason dropdown
- `63451d9` — Bulk dismiss + optimistic dismiss/restore
- `76393fb` — Speed up Gmail fetch (htmlBody during search + parallel get)
- `956fca9` — Single-flight refresh mutex + CAS save (concurrency defense)
- `1221eaf` — Suffix-lookup uses bulk fetch (QBO QL has no OR)
- `5531e7c` — Split Active tab into Open + Sent
- `f30526e` — **Real fix for "Refresh token is invalid"**: pass
  `x_refresh_token_expires_in` to `intuit-oauth.setToken` so its
  client-side `validateToken()` doesn't reject every refresh

**Week 6 — CRM core** (parallel multi-agent build):
- `5964f01` — Foundation: SSE broker + customer_type schema + initial sync
- `2e5cf95` — Customers list + detail shell
- `149de91` — Activity timeline + domain event bus
- `28d4ebf` — Tasks v2 schema (comments, mentions, watchers)
- `0063313` — `tasks-api` agent: routes/tasks.ts + comments + users + mentions
- `dec1e53` — `tasks-ui` agent: Kanban + list + detail drawer + comments + @mentions
- `4641b1f` — Bug-check pass: regex tightening, LIKE escape, missing SSE events, N+1
- `28f4e28` — PROGRESS catch-up

**3-day friction polish** (2026-05-04 → 2026-05-06, commits `3589642` → `adf53a4`):
- `3589642` — Day 1: unparseable-tab body preview + stale badges + dialog scroll + Gmail mark-read + multi-attachment + reply-all
- `01cfec4` — Today rebuild: rename `/invoicing` → `/today`, split into Orders + Returns
- `3bb69ca` — Today: clickable top-line stats + extensiv-receipt backfill script
- `ff35328` — Returns: matcher widened to also accept `approved` RMAs
- `1bf3aa8` — Returns: matcher accepts `completed` RMAs (audit trail) + auto-confirm
- `18867ed` — Today: inline email-body preview on receipt cards
- `037835a` — Returns: receipt classifier handles HTML-only Bluechip emails
- `3d55578` — Day 2: context-aware back nav + manual `<SyncQbBadge>` w/ relative time + global "Sync QB" button
- `77ba277` — Per-customer fast-path "Refresh from QB" — `syncOneCustomer(qbCustomerId)` + `<SyncCustomerButton>`
- `adf53a4` — Day 3: RMA-pending tag, sortable columns + filters on customers/chase, customer-page KPI strip + last-contacted

**Returns module — phase 0-7 + auth refinements** (2026-05-02 → 2026-05-04, commits `7f2ae99` → `2c50dc4`, ~80 commits):
- `7f2ae99` — Scaffold rmas Drizzle schema
- `02825f2` — `rma_items` + `seasons` + `seasonal_products` schemas
- `cdfbe29` — Apply migration `0020`
- `64cbdcc` — RMA state-machine transition table
- `dc8ed27` `34eae7a` — `validateTransition` + tests (incl. invalid-transition coverage)
- `7b9ae07` `bfb5162` `1bb29e5` — Extend ACTIVITY_KINDS + EMAIL_TEMPLATE_CONTEXTS for RMAs
- `497905f` `612e455` `fda7ce5` `e240cfb` `710adf3` — RMA CRUD service (createRma, getById, listRmas with filters, updateRma w/ status gating)
- `6c06231` — Wire `/api/rmas` Fastify route plugin
- `6791b5e` `3df65cd` — RMA list page + sidebar nav link
- `fd6cfc3` `46fffa2` `71f5012` `daf54b3` — approveRma damage / denyRma / issueCreditMemo + builder / markReplacementSent
- `a649af5` `282fef8` `0496587` `16dc632` — addRmaItem / updateRmaItem / removeRmaItem + Drizzle date-column fix
- `2217d6a` `f68e60a` — Discount-aware QBO price + invoice lookup; discount-aware credit-memo lines
- `bd1c9e3` `c5af9e0` — Wire state-transition + items + QBO routes; seed `rma_approval`/`denial`/`credit_memo` templates
- `34c5d42` — `/returns/new` create form with damage branch
- `c50d704` `c18ba35` — Approval + denial email dialogs (with preview)
- `ab4f2ff` — `/returns/:id` detail page with state-driven action panel
- `b7c6d1f` — CM editor dialog + preview endpoint
- `37f6977` — Customer profile Returns tab
- `d5c5b67` — RMA activity events on timeline
- **Phase 2 (Drive photos)**: `c2aac11` (drive.file scope), `376ee02` (rma_photos schema + drive_folder_id), `d1c2938` (Drive client), `0a95652` (upload/delete/list), `eeccd1a` (rename folder on RMA-number allocation), `f60c97f` (drag-drop zone + gallery), plus fixes: `2bf55d6` `0918cf6` `83ba8e8` `5cd7fc4` `01642d2` `930dfa1` `0c1d401`
- **Phase 3 (seasonal + eligibility + Extensiv)**: `542490c` (cumulative-this-season eligibility), `ff0464c` (eligibility PDF report), `cd99902` (Extensiv 15-column export), `543bc25` (seasonal approveRma + warehouse), `fca4eca` (warehouse + eligibility + override-approve routes), `78fa805` `4c3726d` `062520c` (seasons + seasonal_products CRUD + UI), `651221e` (eligibility card UI), `acfc5de` (warehouse export + set-tx-number), `5676490` (override-approve), `7d7ec58` (AI parser for return-request emails)
- **Phase 4 (Extensiv receipts auto-match)**: `c685cfb` (classifier), `e8e2f5a` (matcher), `d9abdea` (`extensiv_receipts` schema), `d778ae7` (wire into Gmail poller), `867f7b7` (parallel QBO item search), `52649b3` (link customer replies to RMA timeline), `3c4b56c` (receipt rows on /today + manual match/dismiss/confirm), `ad4947e` (receipt review dialog with single-shot CM flow)
- **Phase 5 (non-seasonal flow)**: `8fd5794` `2a88262` `369e219` `73beba1` `a64be2f` `dfcd633` `007c94c` `236624f` `d96a76a` `6a47e46` `9a0b68d` `ab9bfdc` `3069785` `8151ef6` `37cdd72` `8031b95` `d5ab8d9` — multi-step wizard, customer-scoped lookups, bulk price+invoice lookup, auto-pick QBO match, customer-scoped PDF preview
- **Phase 6 (UI polish + reconciliation)**: `bdece7c` (clickable step pills + cancel/delete in wizard), `2a887cf` (cancel + delete on detail/list/customer-profile), `4104287` (revert-to-draft for in-flight RMAs), `361dcea` (tracking + sales tax + reconciliation + drill-down PDF), `0d5b6a0` (damage wizard + resume + Kanban + action-panel reconciliation), `2c50dc4` (hand off receipt review to shared dialog)
- **Phase 7 (desktop SQLite import)**: `2d917cd` — selective import script
- **Auth refinements (during returns)**: `e2aff8e` (sidebar sign-out button), `94a40fb` (signout redirects to `/api/auth/signin`), `402da79` (email-based account linking for Google), `f5a4e72` (login → `/` instead of 404)

**Invoices tab + editable-compose-everywhere** (2026-05-01, commits `5cf12d3` → `50302d9`):
- `5cf12d3` — Unified Documents view (invoices + credit memos) with filters / search / sort / PDF / Send
- `4910253` — Always show Send + Re-send, beef up PDF button
- `95f6ab6` — Align action buttons + show sent caption for invoices
- `2126e35` — Memo column (migration 0019)
- `5418a8e` — Multi-select + bulk PDF download (new dep: jszip)
- `d77438a` — Per-row Send reminder — editable compose with PDF attached
- `6ebf2c2` — Bug fix: escape literal control bytes in regex (customers.ts no longer detected as binary)
- `2cc848e` — Phase 2: editable subject/body on statement + chase sends
- `55e434d` — One-click "Dismiss B2C" on hidden SalesReceipt rows
- `50302d9` — Strip em-dashes from email templates

**Customer ops + B2B invoicing recipient overhaul** (2026-04-30 → 2026-05-01, commits `a6a69c6` → `fac9231`):
- `a6a69c6` — Phones card (Main + labelled extras) + unactioned-email indicators
- `3add00c` — Per-channel customer recipients + tag-driven routing rules
- `1ae13ce` — Chase: last-payment + last-statement columns + per-row chase-email actions
- `1f40aa2` — QB sync: regression test for paymentTerms-overwrite bug
- `81f7617` — Statements: BCC is now operator-controllable
- `ed9e9c4` — Gmail/send: RFC 2047 encode subject when non-ASCII
- `82615e5` — Customer detail: payment-upfront button + recipients/Shopify-id row + phone
- `ce63068` — Shopify-link: search accepts id / email / name
- `020dcbc` — Shopify: ID-first customer linking
- `1274b9a` — Shopify: stay under the 2 req/sec leaky-bucket cap
- `b728e56` — QB sync: stop sending no-op BillEmail/Cc/Bcc + surface QBO state on profile
- `54349bc` — QBO recipients card: spell out the customer-level CC/BCC limit
- `a074693` — Customer emails: TO/CC/BCC arrays per channel, drop overrides + remove QBO state card
- `544f165` — Invoices: send via QBO from customer profile
- `ae253f5` — /invoicing/today: pre-fill BillEmail/Cc/Bcc from resolver, not QBO
- `b7266df` — /invoicing/today: remove action + paid Shopify price column
- `39f2696` — /invoicing/today: SalesReceipt support for B2B prepay orders
- `4b936df` — Salesreceipt: read-only line table + create-refund-task button
- `9105001` — /invoicing/today: reassign QBO doc to a different customer
- `4fd18d5` — Customers list: include qb_customer_id in row projection
- `4f67a85` — Scripts: tag-yiddy-roster — bulk-apply yiddy tag to 119 customers
- `c8e5457` — Customer detail: tiny Yiddy badge on the header row
- `bb99680` / `c029f95` — Customers list: tiny "yiddy" indicator next to roster customers
- `fac9231` — Settings: roster-tag import — bulk-apply a tag from CSV / paste

**Statement PDF polish + loose-ends pass** (2026-04-30, commits `7146c24` → `aa7da53`):
- `7146c24` — Statement PDF renderer smoke tests
- `95793c9` — Reseed `statement_open_items` body for the new PDF-as-attachment flow
- `f2bd94e` — Preview PDF button on the send dialog + post-rebuild copy fixes
- `e31ea82` — InvoiceLink query fix (`SELECT *` not `SELECT Id, InvoiceLink`) + widen PDF column widths
- `76f1c85` — Recompute `DueDate` when payment terms change (Net 30 → Net 60 actually moves the date)
- `fb18d54` — `requireAuth` on every `/api/invoicing/*` handler
- `4a61a1a` — Capture RFC 5322 `Message-ID` for proper non-Gmail reply threading + migration `0012`
- `43472d4` — Cross-customer statements audit page at `/statements`
- `aa7da53` — Home-page alert for unsent invoices past 11am London (replaces the planned 11am cron)

**Post-week-6 polish** (commits `a58f71e` → `18a9294`):
- `a58f71e` — Dev-only auth bypass (DEV_USER_EMAIL)
- `0bdb30b`, `df26c12` — Customers list limits 200→5000 / 500→5000
- `fa1abec` — Worker dev script + Gmail backfill one-shot
- `16bf467` — Activity timeline: amounts, currencies, inline PDF links
- `2ed82dd` — Email tab on customer detail (schema + API + UI)
- `c7e0bc8`, `623900e` — Bounded Gmail concurrency 20→10 + activity meta backfill
- `07f3133` — B2C sweep selector
- `926486d` — Shopify-tag B2B import
- `ae10f25` — overdue_balance recompute via UPDATE...JOIN
- `d09ccb4` — Per-customer email backfill button
- `4dbebb7` — BUSINESS_EMAILS filter (Abraham Stern over-match fix)
- `0a74da6`, `18a9294` — Email row 'Mark as actioned' chip

## Team status snapshot

The `finance-hub-init` multi-agent team idled after week 1-2 closed.
Week 3-5 work was done conversationally. Week 6 used a fresh parallel
team (`tasks-api` + `tasks-ui` in isolated worktrees) for the big task
system; remaining work proceeded conversationally. Same pattern is
available again for any week-7 module that wants pair-implementation.
