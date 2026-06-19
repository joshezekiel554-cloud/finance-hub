# Order email templates + recipient split + cancellation email

Operator-requested 2026-06-19 over the radio, on top of the order-hold-lifecycle
feature. Make the order/hold emails operator-editable in Settings, split the
internal recipients into warehouse + accounts-team, add a customer cancellation
email, and fix a latent "no recipient = no hold" bug.

## Requirements (operator, confirmed)

1. **Edit all order email templates in Settings** — subject + body, with
   placeholders, defaulting to today's hardcoded text. Five templates:
   - `hold_alert` — internal "⚠ HOLD ORDER" (detection + manual place-on-hold)
   - `hold_notice` — Day-0 customer "your order is on hold"
   - `hold_warning` — Day-7 customer final warning
   - `hold_cancel` — Day-10 internal "cancel + return to stock"
   - `order_cancelled` — **NEW** customer "your order has been cancelled"
2. **Two internal recipient fields**: Warehouse + Accounts-team. The `hold_alert`
   AND the Day-10 `hold_cancel` email both go to **warehouse + accounts-team
   combined** (dedup addresses). Keep overdue-review recipients unchanged.
3. Customer-facing emails (`hold_notice`, `hold_warning`, `order_cancelled`) go
   to the customer; **Yiddy-tagged customers auto-CC `sales@feldart.com`** on
   these (Day-0/7 already do; add it to `order_cancelled`). No other email types.
4. **Cancellation email** fires from the operator Cancel button
   (`cancelHoldOrder`), **best-effort AFTER** Shopify cancel + QBO void + state
   flip succeed — a failed email never reverts the cancel.
5. **Decouple hold state from email config (bug fix)**: detection must flip an
   order to `on_hold` REGARDLESS of whether alert recipients are set; the email
   is sent only if recipients exist. Today `runOrderHoldAlerts` bails before the
   state flip when recipients are empty — wrong.
6. **Safe template editing**: (a) Reset-to-default per template, (b) unknown /
   empty placeholders render BLANK (never crash, never leave literal `{{x}}`),
   (c) "Send me a test" button per template (renders with sample vars, emails the
   current user). Templates are plain-text, auto-wrapped to HTML (blank line =
   paragraph, single newline = `<br/>`), same as today. Field help notes "don't
   paste raw HTML".

## Settings keys (add to APP_SETTING_KEYS in src/db/schema/app-settings.ts)

Recipients:
- `order_hold_warehouse_recipients` — NEW (warehouse / Bluechip)
- `order_hold_team_recipients` — NEW (accounts team)
- MIGRATE the existing `order_hold_alert_recipients` value into
  `order_hold_warehouse_recipients` (data migration in the new SQL migration:
  `INSERT ... SELECT` / `UPDATE`). Keep the old key registered but mark it
  deprecated in a comment; new code must not read it.

Templates (10 keys — subject + body each):
- `order_tpl_hold_alert_subject` / `order_tpl_hold_alert_body`
- `order_tpl_hold_notice_subject` / `order_tpl_hold_notice_body`
- `order_tpl_hold_warning_subject` / `order_tpl_hold_warning_body`
- `order_tpl_hold_cancel_subject` / `order_tpl_hold_cancel_body`
- `order_tpl_order_cancelled_subject` / `order_tpl_order_cancelled_body`

Empty stored value = use the default. The effective template = stored value if
non-empty, else the default constant.

## New module: src/modules/orders/templates.ts

- Export `ORDER_EMAIL_DEFAULTS`: a typed record of the 5 templates ×
  {subject, body}, lifted verbatim from the current constants in
  `hold-alerts.ts` (SUBJECT_TPL/BODY_TPL), `hold-ladder.ts` (NOTICE/WARNING/
  CANCEL), and a NEW `order_cancelled` default (write a sensible customer
  cancellation message).
- Export `loadOrderTemplate(settings, key): {subject, body}` — returns the
  effective (override-or-default) template.
- Export `renderOrderTemplate(tpl, vars): {subject, html, text}` — wraps the
  existing `renderTemplate` then STRIPS any unrendered `{{...}}` tokens to blank,
  and produces html via the existing paragraph-wrap (`toHtml`). Pure; unit-test
  it (unknown placeholder → blank; blank line → paragraph; newline → <br/>).
- Export `SAMPLE_VARS` for the test-send preview.

Placeholder set (document in UI help): `{{order_number}} {{customer_name}}
{{order_total}} {{age_days}} {{customer_url}} {{payment_status}}`.

## Shared recipient helper

Extract the current `resolveCustomerTo` (in hold-ladder.ts — statement
recipients + Yiddy `sales@feldart.com` CC) into a shared, exported helper
(e.g. src/modules/orders/recipients.ts: `resolveHoldCustomerRecipients`) and use
it from hold-ladder.ts AND the new cancellation send. Also add
`loadInternalHoldRecipients(settings)` → dedup-merged warehouse + team list (as a
comma string), used by hold_alert + hold_cancel sends.

## Send-site changes

- `src/modules/orders/hold-alerts.ts` `runOrderHoldAlerts`:
  - Restructure so the **state flip (holdState=on_hold, reason, holdStartedAt,
    holdAlertedAt, thread ids) happens for every qualifying order regardless of
    recipients**. Send the `hold_alert` email (editable template, internal
    recipients = warehouse+team) only when recipients are non-empty; capture the
    thread id when it sends. Keep at-most-once via holdAlertedAt. Preserve the
    audit `order.hold_started` row.
- `src/modules/orders/hold-ladder.ts`: Day-0 uses `hold_notice` template, Day-7
  uses `hold_warning`, Day-10 uses `hold_cancel` with internal recipients
  (warehouse+team). Customer sends keep Yiddy CC via the shared helper.
- `src/modules/orders/hold-actions.ts`:
  - `placeOnHold` warehouse alert → use `hold_alert` template + internal
    (warehouse+team) recipients.
  - `cancelHoldOrder` → after success, best-effort send `order_cancelled` to the
    customer (shared customer recipient helper incl. Yiddy CC), financeSendType
    `hold-cancel`? NO — it's customer-facing; use a customer send type. Reuse
    `hold-chase` (customer-facing, → Inbox Waiting) OR add a new
    `order-cancelled` FinanceSendType. DECISION: add `order-cancelled` to
    `FinanceSendType` (src/integrations/gmail/types.ts) and note it for Inbox.
    Log + swallow failures.

## Settings UI (src/web/pages/settings.tsx)

- "Order alerts" section: rename existing field to **Warehouse recipients**
  (bound to `order_hold_warehouse_recipients`), add **Accounts-team recipients**
  (`order_hold_team_recipients`). Keep overdue fields.
- NEW "Order email templates" section: for each of the 5 templates, a subject
  `Input` + body `Textarea` (multi-line), a **Reset to default** button (sets the
  field to the default text — server must expose defaults), and a **Send test**
  button (calls the test endpoint, toasts success/failure). Show the placeholder
  list + the "plain text, blank line = paragraph, no raw HTML" help.
- The settings GET response must include `orderTemplateDefaults` (the 5
  defaults) so Reset works and the textareas can pre-fill with the effective
  value.

## Settings backend

- Register all new keys; ensure the settings GET returns them + the defaults
  object; PATCH persists them (audit as today).
- NEW route `POST /api/settings/order-templates/:key/test` (requireAuth) —
  renders the effective template for `:key` with SAMPLE_VARS and emails the
  current user (`req` user email). 400 on unknown key.

## Tests (TDD where pure)

- `templates.test.ts`: renderOrderTemplate — unknown placeholder → blank;
  paragraph/line-break HTML; override-vs-default selection; all 5 defaults render
  without leftover `{{`.
- Recipient helper: internal merge dedups; Yiddy CC added once.
- Keep the full suite green; `tsc --noEmit` clean (use
  NODE_OPTIONS=--max-old-space-size=8192).

## Migration

One new drizzle migration: no schema change needed (app_settings is K/V), but
include a **data migration** copying `order_hold_alert_recipients` →
`order_hold_warehouse_recipients` if the latter is unset. Generate via
`npm run db:generate` then hand-add the data-migration SQL, OR write the copy as
an idempotent INSERT…ON DUPLICATE in the migration. Deploy auto-runs migrations.

## Out of scope / notes

- Don't touch non-hold customer emails (chase/statements) for Yiddy CC.
- Don't change the overdue-review email.
- `zz-hold-smoke` test customer + `smoke-hold.mjs` exist on prod for the post-
  deploy smoke; do not delete them yet.
