# Vocatech Integration Implementation Plan

> **STATUS (2026-05-14): ✅ COMPLETE — all 8 waves shipped + live on https://finance.feldart.com**. Live progress + deviations + cutover notes captured in `2026-05-11-vocatech-integration-progress.md` (sibling file). This document is now a historical reference.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Vocatech's cloud PBX into finance-hub — inbound calls + AI summaries + transcripts + recordings flow into a new "Calls and SMS" tab on the customer detail page. SMS send/receive too. B2B customer roster pushes to Vocatech for Callpop name-matching.

**Architecture:** Webhook-driven. One HMAC-verified public endpoint accepts every event, dedupes by id, dispatches to per-event handlers that match the caller to a customer (by normalized last-10-digits across all their labeled phones) and write to a unified `phone_communications` table. Outbound API for recording fetch / SMS send / roster push. Local dev via fake-event replay tool + ngrok/Cloudflare tunnel.

**Tech Stack:** Drizzle migration, Fastify webhook route, BullMQ jobs (backfill + roster sync), TanStack Router page tab, React Query for the UI. HMAC-SHA256 verification (node:crypto). Existing SSE broker for live-refresh notifications.

**Reference spec:** `docs/superpowers/specs/2026-05-11-vocatech-integration.md`

---

## File Structure

**New files:**
- `src/db/schema/vocatech.ts`
- `migrations/<next>_vocatech.sql`
- `src/integrations/vocatech/client.ts`
- `src/integrations/vocatech/webhook-verifier.ts`
- `src/integrations/vocatech/matcher.ts`
- `src/server/routes/vocatech.ts`
- `src/jobs/definitions/vocatech-backfill.ts`
- `src/jobs/definitions/vocatech-roster-sync.ts`
- `src/web/components/calls-sms-tab.tsx`
- `src/web/components/unmatched-phone-comm-inbox.tsx`
- `src/web/components/sms-compose-box.tsx`
- `src/web/components/call-recording-player.tsx`
- `src/web/components/call-transcript-modal.tsx`

**Modified files:**
- `src/web/pages/customer-detail.tsx` — add "Calls and SMS" tab + Activity inline entries
- `src/web/pages/invoicing-today.tsx` — add unmatched inbox section
- `src/web/pages/settings.tsx` — add Vocatech section
- `src/server/routes/index.ts` — register `/api/vocatech/*`
- `src/jobs/schedule.ts` — register nightly delta roster sync cron
- `src/jobs/worker.ts` — wire two new job workers
- `src/db/schema/customers.ts` — add `vocatech_last_pushed_at` column

---

## Phase 0: Foundation

### Task 0.1: Schema migration

**Files:**
- Create: `src/db/schema/vocatech.ts`
- Modify: `src/db/schema/customers.ts`
- Generate: `migrations/<NNNN>_vocatech.sql`

- [ ] **Step 1: Inventory the customer phone shape**

Find how customer phone numbers are stored today:
```bash
cd /c/Users/user/Documents/finance-hub
grep -n "phone\|Phone" src/db/schema/customers.ts | head -20
```

There's almost certainly a primary `phone` column and likely a `phonesExtra` JSON column (`{label, number}[]`). Confirm both names. The matcher (Task 2) will read these.

- [ ] **Step 2: Write the new schema file**

`src/db/schema/vocatech.ts`:

```ts
import {
  mysqlTable,
  varchar,
  text,
  mediumtext,
  json,
  int,
  timestamp,
  mysqlEnum,
  index,
} from "drizzle-orm/mysql-core";

// Raw audit log of every Vocatech webhook event we receive. Source of
// truth for replay/debug. PK on evt_* id makes inserts idempotent —
// duplicate deliveries from Vocatech's at-least-once retries silently
// no-op via INSERT IGNORE / onDuplicateKeyUpdate-style upsert.
export const vocatechEvents = mysqlTable("vocatech_events", {
  id: varchar("id", { length: 64 }).primaryKey(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  rawPayload: json("raw_payload").notNull(),
  processingError: text("processing_error"),
});

// Normalized record of every phone interaction (calls AND SMS). One
// table with a `kind` discriminator keeps the customer-page timeline
// query trivial. Per-row link back to the source Vocatech event via
// source_event_id (for replays / debugging).
export const phoneCommunications = mysqlTable(
  "phone_communications",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    kind: mysqlEnum("kind", ["call_in", "call_out", "sms_in", "sms_out"]).notNull(),
    customerId: varchar("customer_id", { length: 24 }),
    phoneLabelMatched: varchar("phone_label_matched", { length: 64 }),
    remoteNumber: varchar("remote_number", { length: 32 }).notNull(),
    extensionNumber: varchar("extension_number", { length: 32 }),
    extensionName: varchar("extension_name", { length: 128 }),
    direction: mysqlEnum("direction", ["inbound", "outbound"]).notNull(),
    startedAt: timestamp("started_at").notNull(),
    durationSeconds: int("duration_seconds"),
    body: text("body"),
    transcription: mediumtext("transcription"),
    recordingMediaId: varchar("recording_media_id", { length: 64 }),
    smsStatus: mysqlEnum("sms_status", ["sent", "delivered", "read", "failed"]),
    groupNumber: varchar("group_number", { length: 32 }),
    sourceEventId: varchar("source_event_id", { length: 64 }),
    dismissedAt: timestamp("dismissed_at"),
    dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    customerIdx: index("phone_comm_customer_idx").on(t.customerId, t.startedAt),
    unmatchedIdx: index("phone_comm_unmatched_idx").on(t.customerId, t.dismissedAt, t.startedAt),
    remoteIdx: index("phone_comm_remote_idx").on(t.remoteNumber),
  }),
);

export type VocatechEvent = typeof vocatechEvents.$inferSelect;
export type PhoneCommunication = typeof phoneCommunications.$inferSelect;
```

- [ ] **Step 3: Add `vocatech_last_pushed_at` to customers**

In `src/db/schema/customers.ts`, find the customers table definition. Add:

```ts
vocatechLastPushedAt: timestamp("vocatech_last_pushed_at"),
```

Place it near the other "last X" timestamp columns to follow convention.

- [ ] **Step 4: Generate + apply migration**

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

Verify the generated SQL: CREATE TABLE for `vocatech_events`, CREATE TABLE for `phone_communications` (with 3 indexes), ALTER TABLE for `customers` adding `vocatech_last_pushed_at`. NO drops.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/db/schema/ migrations/
git commit -m "feat(vocatech): schema for events + phone_communications + customer last-pushed timestamp"
```

---

### Task 0.2: Vocatech API client + HMAC verifier

**Files:**
- Create: `src/integrations/vocatech/client.ts`
- Create: `src/integrations/vocatech/webhook-verifier.ts`

- [ ] **Step 1: Write the HMAC verifier**

`src/integrations/vocatech/webhook-verifier.ts`:

```ts
// Vocatech signs webhook payloads with HMAC-SHA256.
// Header: X-Vocatech-Signature: t=<unix>,v1=<HMAC over "t={timestamp}.{raw_body}">
// Replay protection: reject if |now - t| > 300s.

import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SECONDS = 300;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "malformed_header" | "expired" | "bad_signature" };

export function verifyVocatechSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing_header" };
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k!.trim(), v?.trim() ?? ""];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "malformed_header" };

  const tsUnix = parseInt(t, 10);
  if (!Number.isFinite(tsUnix)) return { ok: false, reason: "malformed_header" };
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsUnix);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "expired" };

  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(v1);
  if (expectedBuf.length !== providedBuf.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(expectedBuf, providedBuf)) return { ok: false, reason: "bad_signature" };

  return { ok: true };
}
```

- [ ] **Step 2: Write the API client**

`src/integrations/vocatech/client.ts`:

```ts
// Vocatech REST API client. Wraps the endpoints we use:
//   GET /v1/calls?start_date=...&end_date=...&page=... (backfill)
//   GET /v1/calls/{call_id} (per-call detail for recording_media_id lookup)
//   GET /v1/media/{media_id} (returns signed Google Cloud Storage URL valid 30 min)
//   GET /v1/messages?start_date=...&end_date=... (SMS backfill)
//   POST /v1/messages (send SMS)
//   POST /v1/contacts (upsert customer roster, batch up to 500)
//   POST /v1/webhooks/{id}/test (settings health check)

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "vocatech.client" });
const BASE = "https://api.vocatech.com/v1";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = env.VOCATECH_API_KEY;
  if (!apiKey) throw new Error("VOCATECH_API_KEY not configured");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn({ status: res.status, path, body }, "vocatech api error");
    throw new Error(`Vocatech ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// --- Read endpoints ----------------------------------------------------------

export type VocatechCallJourneySegment = {
  order: number;
  type: string;
  name?: string;
  start_time: string;
  end_time: string;
  duration: number;
  transcription?: string;
  recording_url?: string | null;
};

export type VocatechCall = {
  call_id: string;
  direction: "inbound" | "outbound" | "internal";
  extension?: string;
  extension_name?: string;
  remote_name?: string;
  remote_number: string;
  group_number?: string;
  start_time: string;
  end_time: string;
  duration: number;
  journey: VocatechCallJourneySegment[];
};

export type VocatechCallsList = {
  data: VocatechCall[];
  next?: string;
};

export async function listCalls(params: {
  startDate?: string;
  endDate?: string;
  direction?: "inbound" | "outbound" | "any";
  page?: string;
  timezone?: string;
}): Promise<VocatechCallsList> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set("start_date", params.startDate);
  if (params.endDate) qs.set("end_date", params.endDate);
  if (params.direction) qs.set("direction", params.direction);
  if (params.page) qs.set("page", params.page);
  qs.set("timezone", params.timezone ?? "UTC");
  return call<VocatechCallsList>(`/calls?${qs}`);
}

export async function getCall(callId: string): Promise<VocatechCall> {
  return call<VocatechCall>(`/calls/${encodeURIComponent(callId)}`);
}

export async function getMediaUrl(mediaId: string): Promise<{ url: string; expires_at: string }> {
  return call(`/media/${encodeURIComponent(mediaId)}`);
}

// --- Messages ----------------------------------------------------------------

export type VocatechMessage = {
  message_id: string;
  from: string;
  to: string;
  channel: "text" | "whatsapp";
  direction: "inbound" | "outbound";
  body: string;
  status: "sent" | "delivered" | "read" | "failed";
  attachments?: Array<{ media_id: string; content_type: string }>;
  created_at: string;
};

export type VocatechMessagesList = { data: VocatechMessage[]; next?: string };

export async function listMessages(params: {
  startDate?: string;
  endDate?: string;
  direction?: "inbound" | "outbound" | "any";
  page?: string;
}): Promise<VocatechMessagesList> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set("start_date", params.startDate);
  if (params.endDate) qs.set("end_date", params.endDate);
  if (params.direction) qs.set("direction", params.direction);
  if (params.page) qs.set("page", params.page);
  return call<VocatechMessagesList>(`/messages?${qs}`);
}

export async function sendMessage(input: {
  to: string;
  body: string;
  channel?: "text" | "whatsapp";
}): Promise<VocatechMessage> {
  return call<VocatechMessage>("/messages", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// --- Contacts (roster push) --------------------------------------------------

export type VocatechContactUpsert = {
  external_id: string;
  name: string;
  phone_numbers: string[];
};

export async function upsertContacts(
  contacts: VocatechContactUpsert[],
): Promise<{ inserted: number; updated: number }> {
  // API accepts batches up to 500.
  if (contacts.length > 500) {
    throw new Error("upsertContacts batch exceeds 500 — chunk caller-side");
  }
  return call("/contacts", {
    method: "POST",
    body: JSON.stringify({ contacts }),
  });
}

// --- Webhook health ----------------------------------------------------------

export async function listWebhooks(): Promise<{ data: Array<{ id: string; name: string; url: string; event_filters: string[] }> }> {
  return call("/webhooks");
}

export async function testWebhook(webhookId: string): Promise<{ ok: true }> {
  return call(`/webhooks/${encodeURIComponent(webhookId)}/test`, { method: "POST" });
}
```

- [ ] **Step 3: Add `VOCATECH_API_KEY` + `VOCATECH_WEBHOOK_SECRET` to env**

In `src/lib/env.ts`, find the Zod env schema. Add:

```ts
VOCATECH_API_KEY: z.string().min(1).optional(),
VOCATECH_WEBHOOK_SECRET: z.string().min(1).optional(),
```

(Optional so the app boots without them; routes guard on presence at call time.)

In `.env.example`, add:

```
# Vocatech phone/SMS integration. Provision via Vocatech support.
VOCATECH_API_KEY=
VOCATECH_WEBHOOK_SECRET=
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/integrations/vocatech/ src/lib/env.ts .env.example
git commit -m "feat(vocatech): API client + HMAC webhook verifier + env config"
```

---

### Task 0.3: Phone matcher

**Files:**
- Create: `src/integrations/vocatech/matcher.ts`

- [ ] **Step 1: Inventory the customer phone schema (again, for the matcher)**

Confirm via grep how phones are stored:
```bash
grep -n "phonesExtra\|phones_extra\|phone:" src/db/schema/customers.ts | head
```

Two possibilities:
- (a) Primary `phone` varchar + `phonesExtra` json column of `{label, number}[]`
- (b) Just a flat `phone` column

If (b), the matcher only checks one phone per customer. Document in the report.

- [ ] **Step 2: Write the module**

`src/integrations/vocatech/matcher.ts`:

```ts
// Phone-number matcher: takes a raw phone number from a Vocatech webhook
// and resolves it to a finance-hub customer + the label of the phone that
// matched (e.g. "Owner's mobile"). US-only — we normalize to last-10-digits
// for comparison.
//
// Index is built in-memory and refreshed every hour. ~2400 customers ×
// ~3 phones each = ~7200 entries, well under 1MB heap.

import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "vocatech.matcher" });

export type MatchResult = {
  customerId: string;
  phoneLabel: string | null;
};

type IndexEntry = { customerId: string; phoneLabel: string | null };
type Index = Map<string, IndexEntry[]>;

let cachedIndex: Index | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Normalize: strip non-digits, take last 10. Returns null if too short.
export function normalize(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

async function buildIndex(): Promise<Index> {
  const rows = await db
    .select({
      id: customers.id,
      phone: customers.phone,
      phonesExtra: customers.phonesExtra, // adjust to actual column name
      lastContactedAt: customers.lastContactedAt, // adjust to actual column name
    })
    .from(customers);

  const map: Index = new Map();

  function addEntry(num: string | null, customerId: string, label: string | null) {
    const normalized = normalize(num);
    if (!normalized) return;
    const bucket = map.get(normalized) ?? [];
    bucket.push({ customerId, phoneLabel: label });
    map.set(normalized, bucket);
  }

  for (const row of rows) {
    addEntry(row.phone, row.id, "Primary");
    if (Array.isArray(row.phonesExtra)) {
      for (const extra of row.phonesExtra as Array<{ label?: string; number?: string }>) {
        addEntry(extra.number ?? null, row.id, extra.label ?? null);
      }
    }
  }

  log.debug({ buckets: map.size }, "matcher index built");
  return map;
}

async function getIndex(): Promise<Index> {
  if (!cachedIndex || Date.now() - cachedAt > CACHE_TTL_MS) {
    cachedIndex = await buildIndex();
    cachedAt = Date.now();
  }
  return cachedIndex;
}

// Returns the best customer match for the given number, or null when no
// match. When the same number matches multiple customers, picks the most
// recently active (by `lastContactedAt`) — rare but possible (B2C with
// the same household number, for instance). Logs a warning.
export async function matchPhoneToCustomer(phone: string): Promise<MatchResult | null> {
  const normalized = normalize(phone);
  if (!normalized) return null;

  const index = await getIndex();
  const matches = index.get(normalized);
  if (!matches || matches.length === 0) return null;
  if (matches.length === 1) {
    return { customerId: matches[0]!.customerId, phoneLabel: matches[0]!.phoneLabel };
  }

  // Multi-match — pick most recently active. We need to refetch the
  // candidates to compare their lastContactedAt; the index doesn't carry it.
  log.warn({ phone: normalized, candidates: matches.length }, "phone matched multiple customers");

  // For simplicity, take the first. A future optimization could read
  // last_contacted_at from a follow-up SELECT and pick max. The warning
  // surfaces the case for manual cleanup.
  return { customerId: matches[0]!.customerId, phoneLabel: matches[0]!.phoneLabel };
}

// Test helper — call from a Settings admin tool to invalidate the cache
// after a customer phone is edited.
export function invalidateMatcherCache(): void {
  cachedIndex = null;
  cachedAt = 0;
}
```

> **Implementer note:** column names `phone`, `phonesExtra`, `lastContactedAt` are best-guesses. Replace with actual schema field names found in Step 1.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/integrations/vocatech/matcher.ts
git commit -m "feat(vocatech): phone matcher with in-memory index + 1h cache"
```

---

## Phase 1: Webhook router + per-event handlers

### Task 1.1: Webhook route + signature verification

**Files:**
- Create: `src/server/routes/vocatech.ts`
- Modify: `src/server/routes/index.ts`

- [ ] **Step 1: Write the webhook route**

`src/server/routes/vocatech.ts` (skeleton — handlers added in Task 1.2-1.4):

```ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { vocatechEvents } from "../../db/schema/vocatech.js";
import { verifyVocatechSignature } from "../../integrations/vocatech/webhook-verifier.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { requireAuth, isAdmin } from "../lib/auth.js";

const log = createLogger({ component: "routes.vocatech" });

const vocatechRoute: FastifyPluginAsync = async (app) => {
  // ---- POST /api/vocatech/webhook -----------------------------------------
  // Public endpoint, HMAC-verified. Vocatech posts every subscribed event
  // here. We respond 200 quickly after persisting the raw event; handlers
  // run async via a queue or in-process worker.
  app.post(
    "/webhook",
    {
      config: {
        // Capture raw body so we can HMAC-verify before parse.
        rawBody: true,
      },
    },
    async (req, reply) => {
      const secret = env.VOCATECH_WEBHOOK_SECRET;
      if (!secret) {
        reply.code(500);
        return { error: "VOCATECH_WEBHOOK_SECRET not configured" };
      }

      const rawBody = (req as any).rawBody as string | undefined;
      if (!rawBody) {
        reply.code(400);
        return { error: "missing raw body" };
      }

      const signature = req.headers["x-vocatech-signature"];
      const verification = verifyVocatechSignature(
        rawBody,
        Array.isArray(signature) ? signature[0] : signature,
        secret,
      );
      if (!verification.ok) {
        log.warn({ reason: verification.reason }, "webhook signature verification failed");
        reply.code(401);
        return { error: `bad signature: ${verification.reason}` };
      }

      const payload = JSON.parse(rawBody) as { id?: string; event_type?: string; data?: unknown };
      if (!payload.id || !payload.event_type) {
        reply.code(400);
        return { error: "payload missing id or event_type" };
      }

      // Insert idempotently — duplicate deliveries silently no-op.
      await db
        .insert(vocatechEvents)
        .values({
          id: payload.id,
          eventType: payload.event_type,
          rawPayload: payload,
        })
        .onDuplicateKeyUpdate({
          set: { eventType: payload.event_type }, // no-op-ish
        });

      // Dispatch handler (synchronous for v1 simplicity — can move to a
      // queue if it becomes a perf concern).
      try {
        await dispatchEvent(payload);
        await db
          .update(vocatechEvents)
          .set({ processedAt: new Date(), processingError: null })
          .where(eq(vocatechEvents.id, payload.id));
      } catch (err) {
        log.error({ err, eventId: payload.id }, "event handler failed");
        await db
          .update(vocatechEvents)
          .set({ processingError: err instanceof Error ? err.message : String(err) })
          .where(eq(vocatechEvents.id, payload.id));
      }

      return { ok: true };
    },
  );

  // ---- POST /api/vocatech/replay-event ------------------------------------
  // Admin-only local-dev tool. Accepts a raw Vocatech event payload and
  // runs it through the same dispatcher as a real webhook — bypasses HMAC
  // verification. Useful for testing parser/matcher/storage logic without
  // needing an actual incoming call OR a public webhook tunnel.
  app.post("/replay-event", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) {
      reply.code(403);
      return { error: "admin only" };
    }
    const payload = req.body as { id?: string; event_type?: string };
    if (!payload?.id || !payload.event_type) {
      reply.code(400);
      return { error: "payload missing id or event_type" };
    }
    await dispatchEvent(payload as any);
    return { ok: true };
  });
};

async function dispatchEvent(payload: { id: string; event_type: string; data: unknown }) {
  // Handlers added in Tasks 1.2 / 1.3 / 1.4
  switch (payload.event_type) {
    case "call.ended":
      // await handleCallEnded(payload);
      break;
    case "call.transcription":
      // await handleCallTranscription(payload);
      break;
    case "message.received":
      // await handleMessageReceived(payload);
      break;
    case "message.status_updated":
      // await handleMessageStatusUpdated(payload);
      break;
    default:
      log.debug({ event_type: payload.event_type }, "unhandled event type — stored only");
  }
}

export default vocatechRoute;
```

Notes:
- `rawBody: true` may need a Fastify plugin (`@fastify/raw-body`) — verify what the codebase already uses. Search for how `customer-emails` or any other signature-verified webhook does it.
- The handler imports `eq` from drizzle-orm but the import is omitted above — add it.

- [ ] **Step 2: Register the route**

In `src/server/routes/index.ts`, mount the route at `/api/vocatech`:

```ts
import vocatechRoute from "./vocatech.js";
// ...
app.register(vocatechRoute, { prefix: "/api/vocatech" });
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/server/routes/vocatech.ts src/server/routes/index.ts
git commit -m "feat(vocatech): webhook route with HMAC verification + admin replay endpoint"
```

---

### Task 1.2: `call.ended` handler

**Files:**
- Modify: `src/server/routes/vocatech.ts`

- [ ] **Step 1: Implement `handleCallEnded`**

Add to `vocatech.ts`:

```ts
import { nanoid } from "nanoid";
import { phoneCommunications } from "../../db/schema/vocatech.js";
import { matchPhoneToCustomer } from "../../integrations/vocatech/matcher.js";
import { events } from "../../lib/events.js";

async function handleCallEnded(payload: {
  id: string;
  data: {
    call_id: string;
    direction: "inbound" | "outbound" | "internal";
    extension?: string;
    extension_name?: string;
    remote_number: string;
    group_number?: string;
    start_time: string;
    end_time: string;
    duration: number;
  };
}) {
  const d = payload.data;

  // Dedupe: if we already have a row for this call_id, skip.
  const existing = await db
    .select({ id: phoneCommunications.id })
    .from(phoneCommunications)
    .where(eq(phoneCommunications.sourceEventId, d.call_id))
    .limit(1);
  if (existing.length > 0) {
    log.debug({ callId: d.call_id }, "call already recorded");
    return;
  }

  const match = await matchPhoneToCustomer(d.remote_number);
  const kind = d.direction === "outbound" ? "call_out" : "call_in";
  const id = nanoid();

  await db.insert(phoneCommunications).values({
    id,
    kind,
    customerId: match?.customerId ?? null,
    phoneLabelMatched: match?.phoneLabel ?? null,
    remoteNumber: d.remote_number,
    extensionNumber: d.extension ?? null,
    extensionName: d.extension_name ?? null,
    direction: d.direction === "outbound" ? "outbound" : "inbound",
    startedAt: new Date(d.start_time),
    durationSeconds: d.duration,
    groupNumber: d.group_number ?? null,
    sourceEventId: d.call_id,
  });

  // SSE notify the matched customer's page to refresh.
  if (match) {
    events.emit({
      type: "phone-communication.received",
      customerId: match.customerId,
      communicationId: id,
      kind,
    });
  }
}
```

- [ ] **Step 2: Wire into the dispatcher**

In the `switch` block in `dispatchEvent`, uncomment / add:
```ts
case "call.ended":
  await handleCallEnded(payload as any);
  break;
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/server/routes/vocatech.ts
git commit -m "feat(vocatech): call.ended handler — match customer + insert phone_communications row"
```

---

### Task 1.3: `call.transcription` handler + recording-url proxy endpoint

**Files:**
- Modify: `src/server/routes/vocatech.ts`

- [ ] **Step 1: Implement `handleCallTranscription`**

Vocatech's `call.transcription` payload contains `summary` + `transcription` text. But the per-segment `recording_url` lives on the journey, which is only available via `GET /calls/{call_id}`. So this handler:
1. Loads the matching row by `sourceEventId = call_id`
2. Sets `body = data.summary`, `transcription = data.transcription`
3. Calls `getCall(call_id)` and extracts the first segment with a `recording_url`, parses out the `rec_*` id, stores in `recordingMediaId`

```ts
import { getCall } from "../../integrations/vocatech/client.js";

async function handleCallTranscription(payload: {
  id: string;
  data: { call_id: string; summary?: string; transcription?: string };
}) {
  const d = payload.data;

  const rows = await db
    .select({ id: phoneCommunications.id, customerId: phoneCommunications.customerId })
    .from(phoneCommunications)
    .where(eq(phoneCommunications.sourceEventId, d.call_id))
    .limit(1);
  if (rows.length === 0) {
    log.warn({ callId: d.call_id }, "transcription for unknown call; ordering issue");
    return;
  }
  const row = rows[0]!;

  // Fetch journey to get recording media id (URL like /v1/media/rec_xyz).
  let recordingMediaId: string | null = null;
  try {
    const call = await getCall(d.call_id);
    for (const seg of call.journey ?? []) {
      if (seg.recording_url) {
        const match = seg.recording_url.match(/\/media\/(rec_[A-Za-z0-9_-]+)/);
        if (match) {
          recordingMediaId = match[1] ?? null;
          break;
        }
      }
    }
  } catch (err) {
    log.warn({ err, callId: d.call_id }, "could not load call journey for recording id");
  }

  await db
    .update(phoneCommunications)
    .set({
      body: d.summary ?? null,
      transcription: d.transcription ?? null,
      recordingMediaId,
    })
    .where(eq(phoneCommunications.id, row.id));

  if (row.customerId) {
    events.emit({
      type: "phone-communication.updated",
      customerId: row.customerId,
      communicationId: row.id,
    });
  }
}
```

- [ ] **Step 2: Add `GET /api/vocatech/recording-url/:phoneCommId`**

In `vocatechRoute`, alongside the webhook handler:

```ts
import { getMediaUrl } from "../../integrations/vocatech/client.js";

app.get<{ Params: { phoneCommId: string } }>(
  "/recording-url/:phoneCommId",
  async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select({
        id: phoneCommunications.id,
        mediaId: phoneCommunications.recordingMediaId,
      })
      .from(phoneCommunications)
      .where(eq(phoneCommunications.id, req.params.phoneCommId))
      .limit(1);
    if (rows.length === 0 || !rows[0]!.mediaId) {
      reply.code(404);
      return { error: "recording not found" };
    }
    const result = await getMediaUrl(rows[0]!.mediaId);
    return { url: result.url, expiresAt: result.expires_at };
  },
);
```

- [ ] **Step 3: Wire into dispatcher**

```ts
case "call.transcription":
  await handleCallTranscription(payload as any);
  break;
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/server/routes/vocatech.ts
git commit -m "feat(vocatech): call.transcription handler + recording-url proxy endpoint"
```

---

### Task 1.4: SMS handlers + outbound SMS endpoint

**Files:**
- Modify: `src/server/routes/vocatech.ts`

- [ ] **Step 1: Implement `handleMessageReceived` and `handleMessageStatusUpdated`**

```ts
async function handleMessageReceived(payload: {
  id: string;
  data: { message_id: string; from: string; to: string; body: string; created_at: string };
}) {
  const d = payload.data;

  const existing = await db
    .select({ id: phoneCommunications.id })
    .from(phoneCommunications)
    .where(eq(phoneCommunications.sourceEventId, d.message_id))
    .limit(1);
  if (existing.length > 0) return;

  const match = await matchPhoneToCustomer(d.from);
  const id = nanoid();

  await db.insert(phoneCommunications).values({
    id,
    kind: "sms_in",
    customerId: match?.customerId ?? null,
    phoneLabelMatched: match?.phoneLabel ?? null,
    remoteNumber: d.from,
    direction: "inbound",
    startedAt: new Date(d.created_at),
    body: d.body,
    sourceEventId: d.message_id,
  });

  if (match) {
    events.emit({
      type: "phone-communication.received",
      customerId: match.customerId,
      communicationId: id,
      kind: "sms_in",
    });
  }
}

async function handleMessageStatusUpdated(payload: {
  id: string;
  data: { message_id: string; status: "sent" | "delivered" | "read" | "failed" };
}) {
  const d = payload.data;
  await db
    .update(phoneCommunications)
    .set({ smsStatus: d.status })
    .where(eq(phoneCommunications.sourceEventId, d.message_id));
}
```

- [ ] **Step 2: Wire into dispatcher**

```ts
case "message.received":
  await handleMessageReceived(payload as any);
  break;
case "message.status_updated":
  await handleMessageStatusUpdated(payload as any);
  break;
```

- [ ] **Step 3: Add `POST /api/vocatech/customers/:id/sms`**

```ts
import { sendMessage } from "../../integrations/vocatech/client.js";

const sendSmsBodySchema = z.object({
  toNumber: z.string().min(7).max(32),
  body: z.string().min(1).max(1600),
});

app.post<{ Params: { id: string } }>(
  "/customers/:id/sms",
  async (req, reply) => {
    await requireAuth(req);
    const parse = sendSmsBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "invalid body", details: parse.error.flatten() };
    }
    try {
      const sent = await sendMessage({ to: parse.data.toNumber, body: parse.data.body });
      const id = nanoid();
      await db.insert(phoneCommunications).values({
        id,
        kind: "sms_out",
        customerId: req.params.id,
        phoneLabelMatched: null, // operator-typed; we don't auto-label outbound
        remoteNumber: parse.data.toNumber,
        direction: "outbound",
        startedAt: new Date(),
        body: parse.data.body,
        smsStatus: "sent",
        sourceEventId: sent.message_id,
      });
      events.emit({
        type: "phone-communication.received",
        customerId: req.params.id,
        communicationId: id,
        kind: "sms_out",
      });
      return { ok: true, id };
    } catch (err) {
      reply.code(502);
      return { error: err instanceof Error ? err.message : "SMS send failed" };
    }
  },
);
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/server/routes/vocatech.ts
git commit -m "feat(vocatech): SMS handlers (inbound/status) + outbound SMS endpoint"
```

---

## Phase 2: Background jobs

### Task 2.1: Backfill BullMQ job

**Files:**
- Create: `src/jobs/definitions/vocatech-backfill.ts`
- Modify: `src/jobs/queues.ts`, `src/jobs/worker.ts`, `src/jobs/index.ts`
- Modify: `src/server/routes/vocatech.ts` (add trigger endpoint)

- [ ] **Step 1: Write the job**

`src/jobs/definitions/vocatech-backfill.ts`:

```ts
import type { Job } from "bullmq";
import { listCalls, listMessages } from "../../integrations/vocatech/client.js";
import { db } from "../../db/index.js";
import { phoneCommunications } from "../../db/schema/vocatech.js";
import { matchPhoneToCustomer } from "../../integrations/vocatech/matcher.js";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.vocatech-backfill" });

export type VocatechBackfillJobData = {
  startDate: string; // ISO yyyy-mm-dd
  endDate: string;
};

export async function vocatechBackfillHandler(
  job: Job<VocatechBackfillJobData>,
): Promise<{ calls: number; messages: number }> {
  const { startDate, endDate } = job.data;
  log.info({ startDate, endDate }, "backfill starting");

  let callsTotal = 0;
  let messagesTotal = 0;

  // ---- Calls ----------------------------------------------------------------
  let page: string | undefined;
  while (true) {
    const res = await listCalls({ startDate, endDate, direction: "any", page });
    for (const c of res.data) {
      const existing = await db
        .select({ id: phoneCommunications.id })
        .from(phoneCommunications)
        .where(eq(phoneCommunications.sourceEventId, c.call_id))
        .limit(1);
      if (existing.length > 0) continue;

      const match = await matchPhoneToCustomer(c.remote_number);
      const kind = c.direction === "outbound" ? "call_out" : "call_in";

      // Pull summary/transcript from journey if present.
      let body: string | null = null;
      let transcription: string | null = null;
      let recordingMediaId: string | null = null;
      const segWithTranscription = c.journey?.find((s) => s.transcription);
      if (segWithTranscription) {
        transcription = segWithTranscription.transcription ?? null;
      }
      const segWithRecording = c.journey?.find((s) => s.recording_url);
      if (segWithRecording?.recording_url) {
        const m = segWithRecording.recording_url.match(/\/media\/(rec_[A-Za-z0-9_-]+)/);
        recordingMediaId = m?.[1] ?? null;
      }

      await db.insert(phoneCommunications).values({
        id: nanoid(),
        kind,
        customerId: match?.customerId ?? null,
        phoneLabelMatched: match?.phoneLabel ?? null,
        remoteNumber: c.remote_number,
        extensionNumber: c.extension ?? null,
        extensionName: c.extension_name ?? null,
        direction: c.direction === "outbound" ? "outbound" : "inbound",
        startedAt: new Date(c.start_time),
        durationSeconds: c.duration,
        body,
        transcription,
        recordingMediaId,
        groupNumber: c.group_number ?? null,
        sourceEventId: c.call_id,
      });
      callsTotal++;
    }

    await job.updateProgress({ calls: callsTotal, messages: messagesTotal });

    if (!res.next) break;
    page = res.next;
  }

  // ---- Messages -------------------------------------------------------------
  let msgPage: string | undefined;
  while (true) {
    const res = await listMessages({ startDate, endDate, direction: "any", page: msgPage });
    for (const m of res.data) {
      const existing = await db
        .select({ id: phoneCommunications.id })
        .from(phoneCommunications)
        .where(eq(phoneCommunications.sourceEventId, m.message_id))
        .limit(1);
      if (existing.length > 0) continue;

      const kind = m.direction === "outbound" ? "sms_out" : "sms_in";
      const remoteNumber = m.direction === "outbound" ? m.to : m.from;
      const match = await matchPhoneToCustomer(remoteNumber);

      await db.insert(phoneCommunications).values({
        id: nanoid(),
        kind,
        customerId: match?.customerId ?? null,
        phoneLabelMatched: match?.phoneLabel ?? null,
        remoteNumber,
        direction: m.direction === "outbound" ? "outbound" : "inbound",
        startedAt: new Date(m.created_at),
        body: m.body,
        smsStatus: m.status,
        sourceEventId: m.message_id,
      });
      messagesTotal++;
    }

    await job.updateProgress({ calls: callsTotal, messages: messagesTotal });
    if (!res.next) break;
    msgPage = res.next;
  }

  log.info({ callsTotal, messagesTotal }, "backfill complete");
  return { calls: callsTotal, messages: messagesTotal };
}
```

- [ ] **Step 2: Register queue + worker + job constants**

In `src/jobs/queues.ts`, `src/jobs/worker.ts`, `src/jobs/index.ts` — follow the pattern of the existing `TAG_EMAIL_QUEUE` / `tagEmailWorker` you just shipped. Add `VOCATECH_BACKFILL_QUEUE` + `VOCATECH_BACKFILL_JOB` + `vocatechBackfillWorker`.

- [ ] **Step 3: Add trigger endpoint**

In `src/server/routes/vocatech.ts`:

```ts
import { Queue } from "bullmq";
import { VOCATECH_BACKFILL_QUEUE, VOCATECH_BACKFILL_JOB } from "../../jobs/queues.js";

const backfillBodySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

app.post("/backfill", async (req, reply) => {
  const user = await requireAuth(req);
  if (!isAdmin(user)) {
    reply.code(403);
    return { error: "admin only" };
  }
  const parse = backfillBodySchema.safeParse(req.body);
  if (!parse.success) {
    reply.code(400);
    return { error: "invalid body", details: parse.error.flatten() };
  }
  // Reuse existing queue infrastructure
  const queue = new Queue(VOCATECH_BACKFILL_QUEUE, { connection: getRedisConnection() });
  const job = await queue.add(VOCATECH_BACKFILL_JOB, parse.data);
  return { jobId: job.id };
});
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/jobs/ src/server/routes/vocatech.ts
git commit -m "feat(vocatech): backfill job for calls+SMS over date range + admin trigger endpoint"
```

---

### Task 2.2: Roster sync BullMQ job + nightly delta cron

**Files:**
- Create: `src/jobs/definitions/vocatech-roster-sync.ts`
- Modify: `src/jobs/queues.ts`, `src/jobs/schedule.ts`, `src/jobs/worker.ts`, `src/jobs/index.ts`
- Modify: `src/server/routes/vocatech.ts` (trigger endpoints)

- [ ] **Step 1: Write the job**

Handles both full-push (B2B-only or all) and delta sync (where `updated_at > vocatech_last_pushed_at`). Job data discriminates:

```ts
export type VocatechRosterSyncJobData =
  | { mode: "full"; scope: "b2b" | "all" }
  | { mode: "delta" };
```

Body:
- Query customers based on mode/scope
- Build `VocatechContactUpsert[]`: external_id = customer.id, name = displayName, phone_numbers = [primary, ...extras].filter(non-empty)
- Batch into chunks of 500, call `upsertContacts(chunk)`
- After each successful batch, UPDATE `customers SET vocatech_last_pushed_at = NOW() WHERE id IN (...)`
- Report progress via job.updateProgress
- Return `{ pushed: number }`

- [ ] **Step 2: Register the cron**

In `src/jobs/schedule.ts`, add a nightly registration:

```ts
await queue.add(
  VOCATECH_ROSTER_DELTA_JOB,
  { mode: "delta" } as VocatechRosterSyncJobData,
  {
    jobId: "repeat:vocatech-roster-delta",
    repeat: { pattern: "0 2 * * *", tz: "Europe/London" }, // every night 2am
  },
);
```

- [ ] **Step 3: Add trigger endpoints**

```ts
app.post("/roster-sync", async (req, reply) => {
  const user = await requireAuth(req);
  if (!isAdmin(user)) {
    reply.code(403);
    return { error: "admin only" };
  }
  const parse = z
    .object({ scope: z.enum(["b2b", "all"]).default("b2b") })
    .safeParse(req.body);
  if (!parse.success) {
    reply.code(400);
    return { error: "invalid body", details: parse.error.flatten() };
  }
  const queue = new Queue(VOCATECH_ROSTER_QUEUE, { connection: getRedisConnection() });
  const job = await queue.add(VOCATECH_ROSTER_JOB, { mode: "full", scope: parse.data.scope });
  return { jobId: job.id };
});
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/jobs/ src/server/routes/vocatech.ts
git commit -m "feat(vocatech): roster sync job (B2B-default + nightly delta cron) + admin trigger"
```

---

## Phase 3: UI

### Task 3.1: "Calls and SMS" tab on customer detail

**Files:**
- Create: `src/web/components/calls-sms-tab.tsx`
- Create: `src/web/components/sms-compose-box.tsx`
- Create: `src/web/components/call-recording-player.tsx`
- Create: `src/web/components/call-transcript-modal.tsx`
- Modify: `src/web/pages/customer-detail.tsx`
- Modify: `src/web/lib/search-schemas/customer-detail.ts` (add `"calls_sms"` to tab enum)

- [ ] **Step 1: Add `calls_sms` to the customer-detail tab enum**

In `src/web/lib/search-schemas/customer-detail.ts`, add `"calls_sms"` to the tab enum.

- [ ] **Step 2: Build the tab component**

`src/web/components/calls-sms-tab.tsx`: fetches `GET /api/customers/:id/phone-communications`, renders chronological feed of cards (call_in / call_out / sms_in / sms_out variants), pinned compose box at bottom. Use SSE event `phone-communication.received` / `phone-communication.updated` to live-refresh.

(Sub-components `CallRecordingPlayer`, `CallTranscriptModal`, `SmsComposeBox` per file list above.)

- [ ] **Step 3: Add the GET endpoint**

Add `GET /api/customers/:id/phone-communications` to `src/server/routes/customers.ts` or `src/server/routes/vocatech.ts` (your call — customers.ts probably has more relevant pattern).

Returns `{ rows: PhoneCommunication[] }`, ordered by `started_at DESC`, capped at 200, optionally with a `dateRange` query param.

- [ ] **Step 4: Mount the tab in customer-detail.tsx**

Add the tab to the TABS array, render `{tab === "calls_sms" && <CallsSmsTab ... />}` block.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/ src/server/routes/
git commit -m "feat(vocatech): Calls and SMS tab on customer detail with playback + compose"
```

---

### Task 3.2: Activity tab integration + Today unmatched inbox

**Files:**
- Create: `src/web/components/unmatched-phone-comm-inbox.tsx`
- Modify: `src/web/pages/customer-detail.tsx` (Activity tab inline entries)
- Modify: `src/web/pages/invoicing-today.tsx` (unmatched inbox section)

- [ ] **Step 1: Activity tab inline entries**

When the customer-detail Activity tab loads, also include phone_communications for that customer in the unified timeline (`api/customers/:id/activity` already returns mixed events — extend to include phone comms, OR fetch separately and merge client-side).

- [ ] **Step 2: Today tab unmatched inbox**

`src/web/components/unmatched-phone-comm-inbox.tsx`: query `GET /api/vocatech/unmatched?days=7`, render compact card list with `Match to customer` (opens customer picker) + `Ignore` (sets `dismissed_at`) actions.

- [ ] **Step 3: Add unmatched endpoints**

```
GET /api/vocatech/unmatched?days=7
POST /api/vocatech/communications/:id/match { customerId }
POST /api/vocatech/communications/:id/dismiss
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/ src/server/routes/
git commit -m "feat(vocatech): Activity-tab inline entries + Today unmatched inbox"
```

---

### Task 3.3: Settings page section

**Files:**
- Modify: `src/web/pages/settings.tsx`
- Modify: `src/server/routes/vocatech.ts` (add health endpoint)

- [ ] **Step 1: Add `GET /api/vocatech/health`**

Returns:
```
{
  apiKeyConfigured: boolean,
  webhookSecretConfigured: boolean,
  lastWebhookAt: timestamp | null,  // max(received_at) from vocatech_events
  recentEventCount24h: number,
  webhooks: WebhookSubscription[],  // from Vocatech listWebhooks()
}
```

- [ ] **Step 2: Add the section UI**

In `src/web/pages/settings.tsx`, append a `VocatechSection` component with:
- Status badge (green/red dot)
- Backfill controls (4 buttons: 30d / 90d / 1y / all)
- Roster push: primary "Push all B2B" + secondary "Push everyone" + auto-sync toggle
- Webhook health: list configured webhooks + "Test webhook" button

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/pages/settings.tsx src/server/routes/vocatech.ts
git commit -m "feat(vocatech): Settings section with health check, backfill, roster push"
```

---

## Final review checklist

- [ ] Schema migration applied cleanly (event log + phone_communications + customer column)
- [ ] HMAC verification tested with a real Vocatech webhook + a known-bad signature
- [ ] Phone matcher correctly identifies single-match, returns null for unmatched, picks one on multi-match
- [ ] Each event type (call.ended / call.transcription / message.received / message.status_updated) produces the expected row update via the replay-event admin tool
- [ ] Recording URL proxy returns a working signed URL playable in `<audio>`
- [ ] Outbound SMS succeeds + appears in feed immediately + updates status via webhook
- [ ] 30-day backfill on first install completes without errors
- [ ] "Push all B2B" pushes the right set, updates `vocatech_last_pushed_at`
- [ ] Nightly delta sync cron only pushes changed customers
- [ ] Activity timeline shows phone communications inline
- [ ] Unmatched inbox surfaces correctly + match-to-customer + ignore both work
- [ ] Settings status badge accurately reflects connection state
- [ ] Live SSE event refreshes the customer-detail tab when a new call/SMS arrives

## Implementation handoff

Next: choose execution mode.

**Subagent-Driven (recommended)** — same workflow as returns redesign. Fresh subagent per task, two-stage review (spec + code quality, opus for code reviewers). Worktree fan-out where tasks are file-disjoint.

**Inline execution** — sequential in this session.

Estimated effort: 10 tasks, ~7-10 days realistic with reviews + polish loop.
