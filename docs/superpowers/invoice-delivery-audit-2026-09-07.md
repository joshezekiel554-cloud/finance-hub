# Invoice delivery audit — 2026-09-07

Operator report: "quite a few reports of people not receiving invoices
recently". Question was (a) are shipments reaching the hub to be sent at all,
and (b) do sends that claim success actually go out.

## Method

- Hub code path: `POST /api/invoicing/send` → sparse-update the QBO invoice →
  `POST /invoice/{id}/send` (QBO emails it from Intuit's infrastructure).
  A failure on the email step is logged as `invoice update committed but
  email send failed` and surfaced in the UI as `emailError`.
- Prod logs (`~/.pm2/logs/finance-hub-out.log`) grepped Jul–Sep for every
  send/emailed/failed line.
- QBO queried directly (read-only) for every `Invoice` and `SalesReceipt`
  with `TxnDate >= 2026-07-01`, reading `EmailStatus` and
  `DeliveryInfo.DeliveryErrorType`. Probe script kept in the session
  scratchpad (`qbo-emailstatus.mjs`).
- Prod DB: `invoices`, `activities`, `invoice_bcc_forwards`,
  `dismissed_shipments`, `customers` email arrays.

## Headline

| | Count |
|---|---|
| Hub invoice sends logged since 1 Jul | 215 distinct invoices |
| Hub sales-receipt sends logged | 27 |
| Hub-side email-step failures (all time) | 0 |
| QBO `EmailStatus=EmailSent` for hub-sent docs | 215 / 215 |
| QBO `DeliveryErrorType` set (bounced / undeliverable) | 15 invoices + 1 sales receipt |
| QBO invoices since 1 Jul with `EmailStatus=NotSet` and no hub send | 56 (≈40 real after excluding placeholders) |

**(b) is not the problem in the way suspected.** Every send the hub reports
as sent was accepted by QBO and QBO stamped a `DeliveryTime`. But QBO
records bounces *asynchronously*, after it has already returned success, and
nothing in the hub ever re-reads `DeliveryInfo`. So bounces are invisible.

**(a) is a real gap.** Invoicing Today is driven by shipment emails from
Gmail, not by QBO invoices. An invoice whose shipment email never arrived,
was unparseable, or was dismissed never gets offered for sending, and
nothing reconciles QBO's `NotSet` invoices back against that.

## Bucket 1 — bounced / undeliverable (QBO DeliveryInfo)

QBO sends a single email to the comma-joined TO+CC list; one bad address
flags the whole delivery. Three of the five customers have an obvious typo in
`customers.invoice_cc_emails` / `billing_emails`.

| Customer | Docs | Recipients (as sent) | Likely cause |
|---|---|---|---|
| Elegant Linen Monsey (qb 134) | 18969, 18970, 19212, 19314, 19344, 19350, 19375 | lf@elegantlinen.com, office.monsey@elegantlinen.com, pteitelbaum@elegantlinen.com, **fak423@verizon.ne** | **hub bug, not a typo**: the comma-joined list is exactly 100 chars, QBO's `BillEmail.Address` limit. QBO truncated `.net` → `.ne`, and the QB sync then wrote the truncated list back into `customers.billing_emails` (credit: inbox agent). Fix: cap the TO join and spill the rest to `BillEmailCc`. |
| Keter Judaica - Williamsburg (qb 31) | 18939, 18988, 19447 | williamsburg@keterjudaica.com, **jfischh@keterjudaica.com**, williamsburg@yefenofbooks.com | double `h`; every other Keter store uses `jfisch@` |
| Compliments Gift (qb 327) | 18944, 18945, 19141, SR 18963 | thecompliments@gmail.com, complimentsbilling@gmail.com | one of the two Gmail addresses is bouncing (both look valid; QBO says Bounced/Undeliverable) |
| Alef Judaica (qb 7) | 19510-SP (2 Sep) | sales@alefjudaicagifts.com | single address, bounced |
| Elegant Home & Gifts (qb 14) | 19489 (1 Sep) | eleganthomebath@yahoo.com, sales@eleganthomegifts.com, billing.elegant@gmail.com | one of three bounced; 19633 (4 Sep) to the same list is still NotSet (not sent yet) |

Dates span 3 Aug → 2 Sep. Totals on the bounced docs: ~$11.8k.

## Bucket 2 — never emailed by anyone (QBO `NotSet`, no hub send)

56 rows. Excluded as noise: 8 `2030-01-01` placeholder invoices, 3 `…RI`
Bais Hasforim invoices with no email, a handful of $0 ones, and one
`PLEASE CHECK ITEMS 111` test row.

Recent (1–6 Sep) — probably still in the Invoicing Today queue awaiting a
shipment email; re-check in a few days:
19662 Creative Elements $789 · 19635 Judaica Square South $240 · 19633 Elegant
Home $106 · 19630 Creative Elements $312 · 19595 Mimi's Linen $544 · 195341
Bracha Peikes $888 · 19577 Shefa $96 · 19466 Keter Lakewood $350 · D8626
Monica Kellerman $325 · 19545 Judaica Plaza $1,081 · 19562 Merkaz Monsey $195 ·
19558 Lideale $281 · 19557 Judaica Corner $1,276 · 19540 Leah Ziskind $68 ·
19515 Z. Berman Squankum $145 · 19509 Shane Vorhand $1,016 · 19502 Yosef
Sandweiss $85 · 19498 Gobek $57.

Older (Jul 8 → Aug 31) — these have had time and no one sent them:

| Doc | Customer | Total | Created |
|---|---|---|---|
| 19284 | esther friedman | 4,062.50 | 21 Aug |
| 19424 | Mrs R Bakst | 3,037.50 | 28 Aug |
| 19472 | The Seforim Nook | 2,634.50 | 31 Aug |
| 19380 | Scharf's Judaica | 2,445.00 | 26 Aug |
| 19490 | Igal Meirov | 1,949.90 | 31 Aug |
| 19057 | Amanda - Yeshivat Noam | 1,870.00 | 10 Aug |
| 18968 | The Hamaspik School | 1,650.00 | 30 Jul |
| 192941 | Mindee Younger | 1,610.00 | 27 Aug |
| 19311 | Brenda Katina | 1,382.50 | 24 Aug |
| 18840 | Joseph Pollack | 1,280.00 | 8 Jul |
| 19276 | Sholem Rosenfeld | 1,190.00 | 20 Aug |
| 19492 | PEARL LAUFER | 830.00 | 31 Aug |
| 19479 | Shane Vorhand | 792.00 | 31 Aug |
| 18966 | Nosson Katzenstein | 715.00 | 30 Jul |
| 19488 | Eliyahu Zaghi | 645.00 | 31 Aug |
| 19364 | Mimi's Linen and Gifts | 355.05 | 25 Aug |
| 184024 | Judy Kennard | 352.75 | 13 Jul |
| 19206 | Shefa Appliances & Gifts | 234.00 | 18 Aug |
| 192591111 | Malchut Judaica - BP | 201.50 | 20 Aug |
| 19468 | Keter Judaica - BP | 124.00 | 31 Aug |
| 19240 | Fraidy Deutsch | 76.21 | 19 Aug |
| 18990 | Oitzer Judaica | 64.00 | 3 Aug |
| 19140-2 | Z. Berman Books - Squankum | 39.20 | 17 Aug |

Many of the older ones are schools / individuals rather than B2B stores, so
some may have been invoiced another way (Shopify draft order, manual PDF).
`dismissed_shipments` in the last 30 days: 389 `b2c_paid_upfront`, 19
`etsy_faire`, 29 `other` — the `other` notes are mostly "sent manually in
QBO" / "sent manually", which is consistent with some of these being meant
for manual handling and then missed.

## Operator-named cases (checked 2026-09-07 13:30)

- **Merkaz Monsey 19562** ($195, created 2 Sep 16:41 PT): `NotSet`, no hub
  send, no QBO send. Customer replied to the *Shopify order confirmation*
  on 7 Sep asking for the invoice. All 11 other Merkaz invoices since July
  were hub-sent and delivered.
- **Eichlers BP**: 14 invoices since 5 Aug; 12 hub-sent, all delivered, no
  bounces. **19552 + 19555** (2 Sep, $2,020) never went through the hub;
  first QBO email Sun 6 Sep 17:43 ET, when someone manually sent them and
  re-sent 8 other Eichlers BP invoices in the same minute (all share
  `DeliveryTime 2026-09-06T14:43:23-07:00`; note a re-send overwrites the
  earlier DeliveryInfo). Customer replied within the hour, so delivery works.
- **Common cause**: Thu 3 Sep 12:32–12:35, four 2-Sep shipment emails were
  dismissed from Invoicing Today (two "sent manually in QBO", two blank).
  Timing matches the Eichlers + Merkaz shipments. Manual send happened late
  (Eichlers) or never (Merkaz). The "sent manually" dismissal should verify
  QBO `EmailStatus` before hiding the row.

## ROOT CAUSE of bucket 2 (found 2026-09-07 18:20 UK, via Judaica Corner 19557)

`GET /api/invoicing/today` calls `searchEmails(sinceQuery, 50)` — a 7-day
Gmail search capped at the **50 newest** warehouse emails. Warehouse volume
is 581 emails / 7 days (388 on 1 Sep alone), so every shipment email older
than the newest 50 silently disappears from Open / Sent / Unparseable. At
the time of discovery everything before Wed 3 Sep 20:56 UTC was invisible;
19557's shipment email (3 Sep 18:30, confidence 0.86, not dismissed) was one
of 410 undismissed emails beyond the cap. 10 of the 27 never-emailed
invoices map to hidden shipment emails (19466, 19468, 19472, 19490, 19492,
19502, 19509, 19515, 19557, 19558). Options put to the operator: (A) raise
the cap + "N older shipments not loaded" banner; (B) source shipment rows
from `email_log` (the Gmail poller already stores every warehouse email with
body) and auto-hide B2C paid-upfront rows; (C) both.

**Operator chose B (17:32 UK). Shipped the same evening in two commits:**
1. `/today` reads the full 7-day window from `email_log` (≥ 2026-05-06 all
   rows carry `body_html`), unions it with the live 50-newest Gmail search
   (dedupe by id, Gmail copy wins), parses everything with the pure parser,
   then `selectTodayCandidates` (`src/modules/b2b-invoicing/today-candidates.ts`)
   keeps EVERY undismissed row that has an order number, caps only
   unparseable noise (newest 100) and dismissed history (newest 50), and
   returns `truncated` counts that the page shows as a red badge. Only the
   kept set goes through QBO/Shopify enrichment. Seam check on 241 real
   stored emails: all parsed; 108 had an order number; the old cap hid 64
   of them.
2. Rows that hit the existing "SalesReceipt but customer is not B2B" gate
   get `autoHidden: "b2c_paid_upfront"` and file under Dismissed
   automatically (label "auto-hidden: B2C paid upfront", no Restore), via a
   pure `classifyTodayRow` extracted to
   `src/web/pages/invoicing-today-classify.ts` with tests. This replaces the
   ~390 manual "Dismiss (B2C paid upfront)" clicks a month.

## Why the hub can't see any of this today

- `sendInvoiceUpdate` treats a 200 from `/invoice/{id}/send` as delivered.
  QBO populates `DeliveryInfo.DeliveryErrorType` minutes later.
- The 30-min QB sync (`src/integrations/qb/sync.ts`) reads `EmailStatus`
  only to emit a `qbo_invoice_sent` activity on the *create* path; it never
  reads `DeliveryInfo`, never updates `sent_at`, and never flags
  `NotSet`-and-old.
- `invoices.sent_at` is only written by the customer-page "send via QBO"
  path (4 rows since Aug), not by the Invoicing Today send, so the local DB
  can't answer "which invoices were emailed" either.

## Suggested fixes

1. **Now (data):** correct `fak423@verizon.ne` → `.net` on Elegant Linen
   Monsey and `jfischh@` → `jfisch@` on Keter Williamsburg; confirm the
   Compliments / Alef / Elegant Home addresses with the customers; resend
   the 16 bounced docs.
2. **Sync-side bounce detection:** in the QB sync upsert, persist
   `EmailStatus`, `DeliveryInfo.DeliveryTime`, `DeliveryErrorType` onto
   `invoices` (new columns) and, on a new error, write an activity + open a
   task ("Invoice 19350 bounced: fak423@verizon.ne"). Show a red badge in
   Invoicing Today / customer Invoices tab.
3. **"Never emailed" reconciliation:** nightly job (or a tab on Invoicing
   Today) listing QBO invoices older than N days with `EmailStatus=NotSet`,
   non-zero total, not in `dismissed_shipments`, so the queue is driven by
   *invoices that exist* rather than only by shipment emails that arrived.
4. **Guard the 100-char QBO `BillEmail` limit** in `send-via-qbo.ts` and the
   Invoicing Today send route: never join more than fits into
   `BillEmail.Address`; overflow goes to `BillEmailCc` (also 100 chars) and
   beyond that fail loudly. Also validate recipient syntax on the send
   dialog (TLD sanity, duplicate/whitespace) before hitting QBO.
5. Cross-check by the inbox agent (same session, independent pass) reached
   the same 15 + 26/40 numbers; they also found Keter Lakewood 19466's
   customer literally emailed on 2 Sep asking for the invoice, and Breaking
   Vending D8626 ("not received the link") is in the never-sent bucket.
