# Vocatech Integration — Design Spec

**Date:** 2026-05-11
**Status:** Approved, ready for implementation plan
**Branch context:** new branch off `main` (after current `feat/returns-phase-5-7` lands)

---

## Problem

Operator wants customer phone interactions (calls + SMS) to flow automatically into finance-hub. Currently nothing's wired up — calls happen on Vocatech's cloud PBX, summaries live in Vocatech's portal, the customer's activity timeline in finance-hub has no record. Operator has to remember to manually log calls or accept that calls become invisible.

Goal: turn finance-hub into the single source of truth for customer interaction by piping Vocatech's call events, AI summaries, and SMS into the customer's timeline automatically.

## Goal

End state from the operator's perspective:

1. **Activity tab** on the customer page shows calls and SMS inline with emails/tasks/RMAs — full picture of the relationship, chronological.
2. **New "Calls and SMS" tab** on the customer page — combined chronological feed of calls + SMS with audio playback, AI summary as headline, full transcript on click, SMS compose box pinned at bottom.
3. **Unmatched inbox** on the Today tab — calls and SMS we couldn't match to a customer (cold calls, prospects, B2C noise). Operator can match-to-customer or ignore.
4. **Settings → Vocatech** — backfill controls (30d default + extended options), B2B roster push button, webhook health.
5. **Callpop on the desktop side** shows customer name on inbound calls (after first roster push).

## Out of scope

- **Click-to-call from finance-hub** (operator opted out; Vocatech's public API doesn't expose outbound origination anyway)
- **Voicemail transcription** (separate Vocatech feature, not requested)
- **Multi-tenancy** (single Vocatech account, single API key)
- **International phone matching** (US-only — `phone_communications.remote_number` is normalized to last-10-digits)
- **Per-user attribution** (we show Vocatech's `extension_name` raw; no mapping to finance-hub users in v1)

## Approach

Webhook-driven integration. Vocatech posts events to us; we don't poll. One public HTTPS endpoint accepts every event, verifies HMAC signature, dedupes by event id, stores raw payload, and dispatches to per-event handlers. Per-event handlers normalize into a unified `phone_communications` table that drives both Activity tab entries and the dedicated Calls and SMS tab.

Outbound API calls (recording fetch, SMS send, contact roster push) use the same Vocatech client module with the configured API key.

Backfill of historical data piggybacks on the same per-event handler logic — calling `GET /calls` and `GET /messages` paginated, feeding each item through the matcher and inserting into `phone_communications`.

## Architecture

### Webhook subscriptions

| Event | Trigger | Handler action |
|---|---|---|
| `call.ended` | Call wraps up | Insert `phone_communications` row (`kind: call_in` or `call_out`), match customer, populate duration/extension_name/timestamps |
| `call.transcription` | 5-30 min after call ends | Update existing row's `body` (AI summary) + `transcription` + fetch recording media id via `GET /calls/{id}` |
| `message.received` | Inbound SMS | Insert `phone_communications` row (`kind: sms_in`), match by `from` number |
| `message.status_updated` | Outbound SMS delivery state changes | Update existing row's status (sent → delivered → read) |

We do NOT subscribe to `call.started` / `call.answered` — those are "currently ringing" events with no terminal data.

### Webhook security

- Endpoint: `POST /api/vocatech/webhook` (public, no auth middleware — verified by HMAC instead)
- Signature header: `X-Vocatech-Signature: t=<unix>,v1=<HMAC-SHA256>`
- HMAC payload: `t={timestamp}.{raw_body}` using `VOCATECH_WEBHOOK_SECRET` env var
- Replay protection: reject if `|now - t| > 300s`
- Timing-safe comparison via `crypto.timingSafeEqual`
- Idempotency: PK on `vocatech_events.id` (= `evt_*`) silently no-ops duplicates

### Schema

**New table: `vocatech_events`**
```
id              varchar(64) PK     -- evt_* from Vocatech
event_type      varchar(64) NOT NULL
received_at     timestamp NOT NULL DEFAULT NOW()
processed_at    timestamp NULL     -- null until handler runs
raw_payload     json NOT NULL
processing_error text NULL         -- last error if handler failed
```
Raw audit log of every event ever received. Source of truth for replays.

**New table: `phone_communications`**
```
id                    varchar(24) PK
kind                  enum('call_in','call_out','sms_in','sms_out') NOT NULL
customer_id           varchar(24) NULL                                -- null = unmatched
phone_label_matched   varchar(64) NULL                                -- e.g., "Owner's mobile"
remote_number         varchar(32) NOT NULL                            -- normalized digits
extension_number      varchar(32) NULL                                -- Vocatech extension
extension_name        varchar(128) NULL                               -- Vocatech display name
direction             enum('inbound','outbound') NOT NULL
started_at            timestamp NOT NULL
duration_seconds      int NULL                                        -- calls only
body                  text NULL                                       -- SMS text or AI summary
transcription         mediumtext NULL                                 -- full transcript (calls only)
recording_media_id    varchar(64) NULL                                -- rec_* for fetching audio
sms_status            enum('sent','delivered','read','failed') NULL   -- SMS only
group_number          varchar(32) NULL                                -- which DID was called
source_event_id       varchar(64) NULL                                -- evt_* link back
dismissed_at          timestamp NULL                                  -- for unmatched-inbox "ignore"
dismissed_by_user_id  varchar(255) NULL
created_at            timestamp NOT NULL DEFAULT NOW()
updated_at            timestamp NOT NULL DEFAULT NOW() ON UPDATE NOW()

INDEX idx_customer (customer_id, started_at DESC)
INDEX idx_unmatched (customer_id, dismissed_at, started_at DESC)
INDEX idx_remote_number (remote_number)
```

**Customer phones — verify shape:**
- If finance-hub already stores labeled phones (`{label, number}` JSON column), use that
- If only flat phone columns exist, add a `customer_phones` table: `(customer_id, label, number, sort_order)`

(Implementer verifies via grep before deciding.)

**Customer roster push tracking:**
- Add `vocatech_last_pushed_at timestamp NULL` column to `customers` so the delta sync can identify changed records

### Configuration

- `VOCATECH_API_KEY` — for outbound API calls (recording fetch, SMS send, roster push)
- `VOCATECH_WEBHOOK_SECRET` — for HMAC verification

Both in `.env`. The Settings → Vocatech health card surfaces whether they're configured.

### Phone matching

1. Normalize incoming number: strip non-digits → take last 10 digits → `lookup`
2. Build customer-phone index in memory (rebuild every hour): `Map<normalized_10digits, Array<{customerId, label}>>`
3. Look up `lookup`:
   - 0 hits → unmatched (`customer_id = null`)
   - 1 hit → set `customer_id` + `phone_label_matched`
   - 2+ hits (same number on two customers) → pick most recently active customer (by `last_contacted_at`), log warning

For ~2400 customers × ~3 phones = ~7200 entries, ~500KB heap. Acceptable.

### Recording fetch (on-demand)

When operator clicks "play recording" on a call:
1. Frontend `GET /api/calls/:phoneCommId/recording-url`
2. Backend reads `recording_media_id` from the row
3. Backend calls Vocatech `GET /v1/media/{media_id}` → returns signed Google Cloud Storage URL (30 min validity)
4. Backend returns signed URL to frontend
5. Frontend uses it as `<audio src>`

We don't cache locally — fresh signed URL per click is cheap.

### SSE notifications

When the per-event handler completes successfully, fire an SSE event:
- `phone-communication.received` → `{ customerId, kind, communicationId }` so the UI can refresh the relevant customer's Activity / Calls and SMS tab in real time

## UI

### A. Customer detail page — new "Calls and SMS" tab

8th tab alongside Activity / Emails / Invoices / Orders / Tasks / Notes / Returns.

**Header strip:** count summary + date-range chip (default last 90 days, expandable)

**Chronological combined feed** (newest first), each item a card:
- **Inbound call card:** ☎️↓ icon, extension_name, "called X ago", duration, phone label matched. Expand → AI summary inline + "View full transcript" link (opens modal) + "Play recording" (embedded audio player). While transcription pending: "Summary processing…"
- **Outbound call card:** ☎️↑ icon, same shape
- **Inbound SMS card:** 💬↓ icon, body text inline, phone label
- **Outbound SMS card:** 💬↑ right-aligned bubble, delivery status pill (sent/delivered/read/failed)

**SMS compose box pinned at bottom:**
- `<textarea>` + "Send SMS" button
- Defaults `to-number` = customer's most-recent inbound number (else primary)
- Click any phone label on the customer profile to switch the to-number
- Character counter (1600 limit)
- Rate-limit aware: throttle / show "queued, retry in Ns" on 429

### B. Activity tab — phone communications surface here too

In the existing Activity timeline, phone communications get inline entries:
- "📞 Inbound call from Owner's mobile · 4m 32s · summary" — click jumps to Calls and SMS tab, scrolled to that call
- "💬 SMS from Sarah's mobile: 'tracking number is 1Z...'" — click same

### C. Today tab — Unmatched inbox

Small new section showing the last 7 days of unmatched (`customer_id IS NULL AND dismissed_at IS NULL`) communications. Each row:
- Caller number + extension_name (calls) OR sender + message body preview (SMS)
- Timestamp
- **"Match to customer"** action — opens a customer-search picker → links the row
- **"Ignore"** action — sets `dismissed_at` + `dismissed_by_user_id`, row falls off

Empty state: "All recent calls and SMS matched to customers."

### D. Settings → Vocatech section

- **Status badge:** green/red dot + "Connected · last webhook X minutes ago" or "No events in 24h — check webhook config"
- **One-shot backfill controls:**
  - "Backfill last 30 days" button (also auto-runs on first install)
  - "Backfill last 90 days" / "Last 1 year" / "All available" — admin-gated buttons → BullMQ jobs with progress
- **Roster push controls:**
  - **Primary button: "Push all B2B customers to Vocatech now"** (admin-gated, one-click)
  - Secondary: "Push everyone (incl B2C)" — admin-gated, separate button for completeness
  - Status line: "Last synced X hours ago — N customers pushed"
  - Toggle: "Auto-sync new/updated B2B customers" (default on) → nightly cron pushes deltas
- **Webhook health:**
  - Lists configured webhook subscriptions Vocatech has on file
  - "Test webhook" button — calls Vocatech `POST /webhooks/{id}/test`, confirms receipt

## Backfill mechanics

Single BullMQ job `vocatech-backfill` parameterized by date range. Behavior:
1. Paginate through `GET /calls` for the range (follow Vocatech's `next` cursor)
2. Same for `GET /messages`
3. For each item, run through the same matcher + storage code as the live webhook handler
4. Skip rows that already exist (dedupe by Vocatech call_id / message_id stored in `source_event_id`)
5. SSE progress events: "Backfilled 247 / ~3,000 calls"
6. Final completion event when done

Idempotent + resumable. Cancellable via the queue UI.

## Roster push mechanics

BullMQ job `vocatech-roster-sync`. Two modes:
- **Full push** (one-shot button): pulls all customers (or B2B-only based on button), batches into 500-row `POST /contacts` upserts
- **Delta sync** (nightly cron): pulls customers where `updated_at > vocatech_last_pushed_at`, pushes only those

Match fields on Vocatech side: phone numbers (primary + extras). Vocatech dedupes server-side.

After each successful batch, update `vocatech_last_pushed_at = now()` on those customers.

## Outbound SMS

When operator hits "Send SMS":
1. Frontend `POST /api/customers/:id/sms` with `{ toNumber, body }`
2. Backend calls Vocatech `POST /v1/messages`
3. On success, immediately write `phone_communications` row (`kind: sms_out`, `sms_status: sent`)
4. `message.status_updated` webhook later updates the row's status (delivered → read)

## Edge cases

- **Webhook URL must be public HTTPS.** Dev is localhost. Configure Vocatech with prod URL only OR use ngrok in dev.
- **Recording URLs expire after 30 min.** Don't cache, re-mint per click.
- **AI summary delay (5-30 min).** Card shows "Summary processing…" until `call.transcription` arrives.
- **SMS rate limit: 5 / 10 min.** Frontend throttles and shows queue state on 429.
- **`extension_name` empty** for some calls (auto-attendant, queue routing). Fall back to `extension_number`.
- **`group_number`** is the DID called (which Feldart number). Useful context — display when multiple lines exist.
- **Same phone on two customers:** match to most-recently-active, log warning, surface in admin diagnostics.
- **First-install auto-backfill:** runs ONCE on Settings save when `phone_communications` is empty + API key just configured.

## Open decisions locked in

- US-only phone matching (last-10-digits normalization)
- All customer phones matched (not just primary), `phone_label_matched` stored
- Show Vocatech's `extension_name` raw (no user mapping)
- 30-day default backfill, extended via Settings button
- B2B-scoped one-shot roster push as the primary action
- Chronological interleaved calls + SMS feed (not separate sub-tabs)
- Freeform SMS compose (no templates in v1)
- AI summary as headline, transcript via "View full transcript" link, recording via "Play recording" embedded player

## File structure

**New files:**
- `src/db/schema/vocatech.ts` — `vocatechEvents` + `phoneCommunications` tables (+ `customerPhones` if missing)
- `migrations/<next>_vocatech_phone_communications.sql` — Drizzle migration
- `src/integrations/vocatech/client.ts` — API client + HMAC verifier helper
- `src/integrations/vocatech/matcher.ts` — phone normalization + customer lookup
- `src/server/routes/vocatech.ts` — webhook endpoint, recording-url proxy, SMS send, settings actions
- `src/jobs/definitions/vocatech-backfill.ts` — BullMQ backfill handler
- `src/jobs/definitions/vocatech-roster-sync.ts` — BullMQ roster sync handler
- `src/web/components/calls-sms-tab.tsx` — customer detail tab content
- `src/web/components/unmatched-phone-comm-inbox.tsx` — Today tab section
- `src/web/components/sms-compose-box.tsx`
- `src/web/components/call-recording-player.tsx`
- `src/web/components/call-transcript-modal.tsx`

**Modified files:**
- `src/web/pages/customer-detail.tsx` — add "Calls and SMS" tab + Activity timeline entries for phone comms
- `src/web/pages/invoicing-today.tsx` (or Today host) — add unmatched inbox section
- `src/web/pages/settings.tsx` — add Vocatech section
- `src/server/routes/index.ts` — register `/api/vocatech/*` routes
- `src/jobs/schedule.ts` — register nightly `vocatech-roster-sync-delta` cron
- `src/jobs/worker.ts` — wire the two new job workers
- `src/db/schema/customers.ts` — add `vocatechLastPushedAt` column

## Implementation handoff

Next: invoke `superpowers:writing-plans` to break this into a task-by-task implementation plan. Estimated ~10 tasks across:
1. Schema + migration
2. Vocatech API client + HMAC verifier
3. Phone matcher
4. Webhook router + per-event handlers
5. Recording-url proxy endpoint
6. Outbound SMS endpoint
7. Backfill BullMQ job
8. Roster sync BullMQ job + nightly cron
9. Customer-detail "Calls and SMS" tab UI
10. Activity tab integration + Today unmatched inbox + Settings UI

Phase 1+2 from the research report ≈ 3-5 days of work; the additions (SMS, roster push, backfill UI, unmatched inbox) bring it to ~7-10 days realistic with subagent-driven execution.
