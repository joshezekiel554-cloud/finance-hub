# Order Hold Lifecycle — spec + phase tracker

Operator-driven follow-on to the Shopify Orders feature (2026-06-17). Turns the
hold/overdue ALERTS into an actionable per-order hold workflow. Designed over
radio with the operator + the Inbox agent, 2026-06-18.

## Locked decisions (operator)

- **Per-ORDER holdState** (separate from customer.holdStatus): `none → on_hold →
  released → cancelled`. Reason, timestamps, who, audit. Drives every surface.
- **Auto-clear**: on_hold auto-clears to `released` the moment the reason
  resolves (prepay order → paid; customer → off-hold / overdue settled). Stops
  the email ladder. Manual "Good to send" also releases.
- **Who enters the ladder**: `payment_upfront_unpaid` + `customer_on_hold` auto-
  enter on detection. `overdue_non_communicating` does NOT — it stays internal
  review (the Phase-4 widget/email), with a dashboard **"Place on hold"** button
  that manually starts the ladder. (D1)
- **Email ladder** (runs only while on_hold; resolving stops it):
  - Day 0: (a) WAREHOUSE hold instruction → bluechip+info+sales "HOLD order X"
    (existing `hold-alert`, → inbox To-Do). (b) Email 1 → CUSTOMER (statement+
    chase recipients) + sales@ if Yiddy-tagged: "on hold pending payment" (prepay)
    / "pending overdue balance settled" (hold/overdue). (D2: warehouse email stays)
  - Day 7: Email 2 → CUSTOMER: "resolve within 3 days or order cancelled + items
    returned to stock."
  - Day 10: Email 3 → INTERNAL (bluechip+info+sales): "cancel order, return to
    stock." (D3)
- **Cancel** (D3): Day-10 email is just the internal instruction. The actual
  cancel is an OPERATOR BUTTON on the order that (a) cancels in Shopify and (b)
  voids the QBO invoice. NOT auto. ✅ MAPPING RESOLVED (operator): the QBO
  invoice DocNumber == the Shopify order number, so the void finds the invoice by
  `docNumber == orderNumber` (strip Shopify's leading "#"). Prepay orders paid in
  Shopify with no QBO invoice → just the Shopify cancel, skip the void.
- **Manual "Chase customer" button** kept alongside the auto-ladder (D4).
- **Release** = reply on the original warehouse hold-alert Gmail thread
  (In-Reply-To its message-id) stamped `hold-release` → inbox flips that thread
  to Done. So capture the alert's threadId + message-id at send time.

## Inbox contract (their slice, mostly inert until finance emits)

- Send-types (proposed, pending inbox 👍): `hold-alert` (warehouse Day0 → To-Do,
  DONE/live), `hold-chase` (customer emails 1&2 → Waiting), `hold-cancel`
  (internal email 3 → Done), `hold-release` (→ Done). All carry
  `X-Feldart-Finance-Customer-Id` (live).
- Routing (operator-final): hold-alert → To-Do; hold-chase → Waiting;
  hold-cancel → Waiting (+ distinct neutral "Cancelled" chip); hold-release →
  Done (drops ⚠). All customer-linked.
- Active-hold red banner INSIDE inbox = YES (operator) → finance exposes holdState
  on /api/ext for it.
- "Yiddy" sales@ cc is finance-side (customer tag).

## Phases (commit + deploy each)

- [x] **P1 — holdState backbone** (migration 0049): schema cols, detection sets
  on_hold + reason + startedAt + captures alert threadId, `releaseResolvedHolds`
  auto-clear pass (wired into orders-sync), `holdReasonStillApplies` +
  `recordHoldTransition` (audit). 916 tests. DONE.
- [x] **P2 — email ladder** (migration 0050): `hold-ladder.ts` runHoldLadder
  (Day-0 customer notice → Day-7 warning → Day-10 internal cancel notice),
  sent-markers holdNoticeAt/holdWarnedAt/holdCancelNotifiedAt, reason-aware copy,
  statement recipients + Yiddy sales@ cc, send-types hold-chase/hold-cancel/
  hold-release added to enum. Wired into orders-sync after auto-release. ALSO
  fixed currency £→$ across ALL orders surfaces (operator: system is USD). DONE.
- [x] **P3 — surfaces + actions**: orders route (`/api/orders/:id/good-to-send`
  · `/place-on-hold` · `/hold-history`) + hold-actions.ts (releaseHold replies
  in-thread w/ hold-release; placeOnHold for overdue; getHoldHistory).
  listHoldableHoldOrders rewritten to query holdState='on_hold' (source of
  truth, covers manual overdue holds). Dashboard widget: Good-to-send / Chase
  (link) / History (inline) + Place-on-hold; customer-detail HoldOrdersBanner +
  Release; customer-list + mobile "Order hold" tag; Orders-tab HOLD badge. DONE.
  Note: Chase is a link to the customer page (the auto-ladder does the real
  chasing); prefilled-compose is a possible refinement.
- [x] **P4 — AI context + 7-day flag**: customer-card prompt gets an "Orders ON
  HOLD" block (flags >7d as STALE), agent get_customer adds `ordersOnHold=…`,
  dashboard hold rows show "held Nd" + an amber badge at ≥7d. DONE.
- [x] **P5 — cancel button**: ShopifyClient.cancelOrder (REST, restock:true) +
  cancelHoldOrder (Shopify cancel must succeed → then best-effort QBO void via
  getInvoiceByDocNumber(orderNumber − "#")→voidInvoice → holdState=cancelled,
  audited). Route POST /api/orders/:id/cancel. Cancel button (two-step confirm)
  on the dashboard hold rows + the customer-detail banner. `holds:[{orderNumber,
  reason:'prepay'|'overdue'|'on_hold',heldSince}]` exposed on /api/ext for the
  inbox banner. DONE.
  NOTE for operator: Shopify cancel uses restock:true (returns items to Shopify
  inventory). Flag if you'd rather restock:false (warehouse-only physical).

## Status
Plan locked 2026-06-18. P1 shipped. Building P2 next.
