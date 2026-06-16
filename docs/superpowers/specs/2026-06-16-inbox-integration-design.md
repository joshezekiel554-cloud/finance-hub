# Finance ↔ Inbox Integration — Finance-side v1 Spec

**Date:** 2026-06-16
**Status:** Design agreed (operator + finance + inbox), pre-implementation
**Counterpart:** the Inbox app (`inbox.feldart.com`) writes a mirrored spec for its side.

---

## 1. Goal

Stop the two apps duplicating work for B2B customers and make customer money +
correspondence available in one place. Two improvements, shipped as independent
pieces:

- **Improvement 1 — Finance data inside Inbox.** While replying to a customer in
  Inbox, the operator sees the customer's balance/open invoices and can attach
  their invoice/statement PDF to the reply, without leaving Inbox. *(Inbox pulls
  from Finance.)*
- **Improvement 2 — the real Inbox board, embedded in Finance.** On a Finance
  customer page, the operator sees the **real Inbox kanban** (Unassigned / To do
  / In progress / Waiting / Done) scoped to **that customer's** emails + linked
  tasks, signed in as themselves, with full reply tools. *(Finance frames Inbox.)*

The design boundary that keeps v1 shippable: **v1 = READ + a header tag, with
zero Inbox→Finance writes.** All the cross-system "stop stepping on each other"
write-signals are a named **Phase 2**.

---

## 2. Architecture facts that shaped this (verified)

- Finance binds **`0.0.0.0:3001`** (`src/server/server.ts:129`), fronted by nginx
  whose `location / { proxy_pass http://127.0.0.1:3001; }` proxies **everything**
  — so a naive `/api/ext` would be **publicly reachable** at
  `finance.feldart.com/api/ext`. Must be walled (see §4).
- Both apps live under **`feldart.com`** (finance.* + inbox.*) → **same-site**.
  This is why the embedded board's login carries into the frame, and why a
  service token over loopback is sufficient.
- Customer primary key `customers.id` = **`nanoid(24)`, minted once on first
  insert**; `upsertCustomer` keys on `qb_customer_id` and never regenerates `id`
  (`src/integrations/qb/sync.ts`). So **`id` is stable** — safe to persist/sync
  into Inbox. `qb_customer_id` is the QBO id (separate, also stable).
- Statement PDFs are generated **locally, in-process** via
  `renderStatementPdf()` (`src/modules/statements/pdf.tsx`) → returns a `Buffer`.
  Origin-aware. Invoice/credit-memo PDFs are **proxied live from QBO** via
  `QboClient.getPdf('invoice'|'creditmemo', qbId)` (`src/server/routes/qb-pdf.ts`).
- Balances are stored columns on `customers` (`balance`, `overdue_balance`,
  `unapplied_credit_balance`, `payment_terms`), synced from QBO ~every 30 min →
  **data attached can be up to ~30 min stale** (acceptable; state it in the UI).
- A customer can have invoices in **both books** (`invoices.origin` =
  `feldart|tj`); balances/statements must be origin-aware.

---

## 3. Finance-side scope (what Finance builds)

### 3.1 Service-to-service read API (`/api/ext`)

New bearer-gated route group, **read-only**, mounted under `/api/ext`. Sits
*beside* `requireAuth()` — the cookie-gated app is untouched.

**Auth:** a `preHandler` checks `Authorization: Bearer <FINANCE_SERVICE_TOKEN>`
(new env var, set on both VPS apps; **operator-generated** via
`openssl rand -hex 32`, never sent over any chat channel). Auth failures →
`401 { error: "unauthorized" }`, rate-limited on a dedicated bucket
(~120 req/min/token) so the token can't be brute-forced.

**Endpoints:**

| Method | Path | Returns |
|---|---|---|
| GET | `/api/ext/customers` | identity-sync feed: `[{ id, displayName, emails[], openOrigins }]` (emails = primary + billing + statement/invoice addrs, deduped) |
| GET | `/api/ext/customers/:id` | `{ id, displayName, emails[], balance, overdueBalance, unappliedCredit, paymentTerms, openOrigins, perBookBalances }` |
| GET | `/api/ext/customers/:id/invoices?openOnly=1` | `[{ id, qbInvoiceId, docNumber, issueDate, dueDate, total, balance, status, origin, disputeState }]` |
| GET | `/api/ext/invoices/:qbInvoiceId/pdf` | `application/pdf` bytes (proxies QBO via `QboClient.getPdf`) |
| GET | `/api/ext/customers/:id/statement.pdf?origin=feldart\|tj` | `application/pdf` bytes (renders via `renderStatementPdf`) |

> **Tightening (synced-Customer model):** no runtime `GET /customers?email=`
> lookup is needed — Inbox resolves email→customer **locally** from the synced
> list, so there's no per-thread round-trip to Finance just to identify the
> customer. Finance's surface is exactly the 5 endpoints above.

**Error-shape convention (consistent JSON `{ error: string }`):**
- `/customers` (list) → `200` + array, `[]` if empty (never 404).
- `/customers/:id` → `404` if unknown id.
- `/customers/:id/invoices` → `200 []` if none open.
- `/invoices/:qbId/pdf` → `404` unknown, `502 { error:"qb pdf fetch failed" }` on QBO upstream error (matches existing `qb-pdf` behavior).
- `/customers/:id/statement.pdf` → `400` if `origin` required (both books open) and missing/invalid; `404` unknown customer.
- Auth → `401 { error:"unauthorized" }`.

**`displayName` + `openOrigins` on the lookup** are what let Inbox render the
**named-match safety guard** ("Statement for: Acme Ltd (Feldart)") and resolve
origin without its own origin logic.

### 3.2 Network wall (critical)

`/api/ext` must **not** be publicly routable. Inbox calls Finance **server-side
at `http://127.0.0.1:3001/api/ext`** (loopback, bypassing nginx). So:

- Add nginx `location /api/ext { return 404; }` (or `deny all;`) to the public
  `finance.feldart.com` vhost → internet gets 404, loopback still works.
- Confirm VPS firewall only exposes 80/443/22/2222 externally (port 3001 not
  public).
- Net: **firewall + nginx deny + bearer + read-only + rate-limited auth fails.**
  The bearer is defense-in-depth, not the sole wall.

### 3.3 Outbound header stamping

Finance stamps **every email it originates** — cron-automated **and**
operator-triggered chase-page batch sends — with:

```
X-Feldart-Finance-Send: <type>
```

- `<type>` ∈ `{ chase, statement, check-in, dispute-bookkeeper, … }`.
- Single change point: Finance's Gmail send helper (all finance sends funnel
  through it) → no send route can miss it.
- Presence = "Sent from Finance" (drives Inbox's tag + hide filter + routing);
  absence = a human Inbox send.
- Inbox routing keys on the value: `chase → Waiting`, `statement → Done`,
  unknown/new type → `Waiting` default + tagged. This lets future Finance
  automations "just work" with no Inbox change. **Replaces Inbox's fragile
  subject-denylist.**

### 3.4 Customer-detail board embed

On the Finance customer page, **replace the inbound emails view** with an
embedded iframe of the **real Inbox board**, scoped to the customer:

- Finance frames the Inbox board URL passing **just the Finance customer `id`**
  (Inbox already holds that customer's address set from the identity sync — so
  **no emails in the URL**, killing the PII-in-URL concern).
- Login carries because finance.* + inbox.* are same-site; **Inbox** sets
  `Content-Security-Policy: frame-ancestors https://finance.feldart.com` and
  drops conflicting `X-Frame-Options`. (Finance's own `X-Frame-Options` governs
  Finance being framed — irrelevant here; Finance is the parent.)
- Finance SPA (React + TanStack Router) hosts the frame as a panel/tab on the
  customer page — small.
- If Finance ever passes data into the frame, it uses `postMessage` **targeting
  the exact inbox origin** (never `*`); Inbox verifies `event.origin`.

### 3.5 Decommission (Improvement 2 cleanup)

**GOES** (retired from Finance — now duplicates of Inbox):
- The per-customer **inbound correspondence reading view**.
- **Free-form "reply to this inbound" compose.**
- The one AI feature that's a true duplicate: **"AI draft a reply to an inbound
  email."**

**STAYS** (finance-workflow / document-driven — *not* duplicates):
- Send-statement (with edit-before-send), chase page + chase-email edit, RMA
  replies (edit), dispute/bookkeeper emails.
- The AI agent / autopilot **drafting + sending its own OUTBOUND** domain emails.
- All of these get the §3.3 header stamp and surface on the embedded board as
  "Sent from Finance."

By-job line: **AI-authors-a-chase → Finance; AI-replies-to-an-inbound → Inbox.**
These are separable in the codebase (the inbound emails view is distinct from
the statement/chase/RMA/dispute send actions).

### 3.6 Engineering must (not a feature, but required)

**Finance's chaser must respect recent human contact** — do not auto-chase a
customer a colleague just hand-replied to. ⚠ This may be **new suppression
logic**: Finance ingests the mail (email_log) but it is **not yet verified** that
the chaser suppresses on recent human contact. Verify; add the rule if absent.
(Phase 2 can replace the Gmail-derived heuristic with an explicit Inbox
"last-human-contact" signal if the heuristic proves unreliable.)

---

## 4. Decisions locked (operator)

1. Everyone with Inbox access also has Finance access → **no balance permission
   gate** needed.
2. **Named-match guard** on PDF attach (Inbox-side; Finance supplies displayName
   + book) — highest-stakes correctness item. Build it.
3. Paid-but-no-reply: chase stays in Waiting until reply or **manual drag to
   Done** in v1.
4. Decommission per §3.5 (retire inbound view + AI-reply-to-inbound only; keep
   document/AI outbound + edit-before-send).
5. Statement → **Done**, chase → **Waiting** (a reply reopens either via Inbox's
   existing reopen-on-reply).
6. Identity: Inbox holds a **synced Customer model** (id + name + email-set +
   openOrigins) pulled from `GET /api/ext/customers` on a schedule; **identity
   only, not financial data** (money stays live-pull). Low-hundreds of customers
   → pull-full-list-and-replace, no diffing.
7. Tasks stay **separate** in v1 (board shows Inbox tasks; per-customer tasks
   visible/creatable via the embed). One-global-task-system deferred.

---

## 5. Phase 2 (named, not v1) — the write-signals

The set of **Inbox↔Finance writes** that stop the systems stepping on each other:

- **paid → close:** Finance owns the payment event (QBO sync flips invoice to
  paid) → signal Inbox to close the customer's Waiting chase thread.
- **statement-delivered → don't double-send:** when Inbox sends a Finance-sourced
  statement, tell Finance so its cadence/chase-page doesn't re-send.
- **last-human-contact → don't re-chase:** explicit Inbox signal if the
  Gmail-derived heuristic (§3.6) is unreliable.
- **global Inbox-task view** surfaced across all customers in Finance.
- **finance-driven board search/sort** (e.g. "threads from customers who owe us")
  — enabled by the resident synced-Customer identity; needs finance figures
  indexed in Inbox.

---

## 5a. Frozen wire contract (Finance-produced)

Byte-exact contract for everything **Finance emits** (Finance is the producer for
all 5 endpoints + the header + auth; Inbox owns the embed URL contract on its
side). This is the single source of truth — Inbox consumes exactly this.

**Conventions:**
- JSON keys are **camelCase** (routes serialize from snake_case DB columns).
- **Money is returned as decimal STRINGS** (e.g. `"1234.56"`), never floats —
  avoids rounding drift. Inbox parses.
- **Dates are `YYYY-MM-DD` strings** (or `null`).

**Auth (every `/api/ext` request):** `Authorization: Bearer <token>`. Finance
reads the value from env **`FINANCE_SERVICE_TOKEN`**; Inbox sends the **same
value** (Inbox's own env var name is its choice).

**Outbound header (every Finance-originated send):**
`X-Feldart-Finance-Send: <type>` — `<type>` is **lowercase, hyphenated**, one of:
`chase` | `statement` | `check-in` | `dispute-bookkeeper`.

**Endpoints:**

```
GET /api/ext/customers
200 → [ { id: string,                      // finance customer id (nanoid 24) — THE shared key
          displayName: string,
          emails: string[],                 // deduped: primary + billing + statement/invoice addrs
          openOrigins: ("feldart"|"tj")[] } ]

GET /api/ext/customers/:id
200 → { id: string,
        displayName: string,
        emails: string[],
        balance: string,                    // decimal string
        overdueBalance: string,
        unappliedCredit: string,
        paymentTerms: string | null,
        openOrigins: ("feldart"|"tj")[],
        perBook: { feldart: { balance: string, overdueBalance: string },
                   tj:      { balance: string, overdueBalance: string } } }
404 → { error: "customer not found" }
// FROZEN field name: `perBook` (final — do not rename again).

GET /api/ext/customers/:id/invoices?openOnly=1
200 → [ { id: string,
          qbInvoiceId: string,
          docNumber: string | null,
          issueDate: string | null,         // YYYY-MM-DD
          dueDate: string | null,
          total: string,                     // decimal string
          balance: string,
          status: "draft"|"sent"|"partial"|"paid"|"void"|"overdue"|null,
          origin: "feldart"|"tj",
          disputeState: "verifying"|"confirmed_paid"|"confirmed_unpaid"|null } ]
200 → [] if none open

GET /api/ext/invoices/:qbInvoiceId/pdf
200 → application/pdf (bytes);  404 unknown;  502 { error: "qb pdf fetch failed" }

GET /api/ext/customers/:id/statement.pdf?origin=feldart|tj
200 → application/pdf (bytes)
400 → { error: "origin required" }          // when both books open & origin omitted/invalid
404 → { error: "customer not found" }
```

**Embed (Inbox-produced — Inbox freezes the exact spelling, Finance consumes):**
Finance frames `https://inbox.feldart.com/board?customer=<financeCustomerId>&embed=1`
(`embed=1` = chrome-free mode); the param value is the **Finance customer id**
above (not an Inbox id) — Inbox resolves its own Customer by the stored
`financeCustomerId`.

## 6. Open / risks

- **Chaser suppression** (§3.6) may be new work — verify before assuming.
- **Deploy pipeline** has been flaky (Hostinger edge dropping the GH runner);
  plan Finance changes knowing deploys aren't reliably one-click right now.
- **Exact customer count** TBD (estimate: low hundreds) — `SELECT COUNT(*) FROM
  customers` if needed for Inbox sync sizing.
- **Data freshness:** balances ~30 min stale by design — surface in UI.
- **Mobile:** the embedded board inside Finance's (already-mobile) layout needs a
  look.
