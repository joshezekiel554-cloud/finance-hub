// Vocatech webhook + outbound API surface.
//
// One file holds:
//   1. POST /webhook   — public; HMAC-verified entry point for every
//      Vocatech event we subscribe to (call.ended, call.transcription,
//      message.received, message.status_updated). Persists the raw event
//      to `vocatech_events` (idempotent on PK) then dispatches to a
//      per-event-type handler. Handler errors are recorded on the event
//      row but never bubble — we always return 200 if signature + parse
//      passed, otherwise Vocatech will hammer us with retries.
//   2. POST /replay-event — admin-only dev/debug tool. Accepts a raw
//      payload and runs it through the same dispatcher, bypassing HMAC.
//      Useful for testing parser/matcher/storage logic against captured
//      payloads without needing a public webhook tunnel.
//   3. GET /recording-url/:phoneCommId — authenticated; mints a fresh
//      30-minute signed media URL for a stored call recording. Vocatech
//      doesn't return permanent URLs, so the player calls this each time.
//   4. POST /customers/:id/sms — authenticated; sends an outbound SMS via
//      Vocatech and records the message as a `phone_communications` row
//      immediately (status=sent, will be updated by message.status_updated
//      webhooks as the carrier ACKs).
//
// HMAC raw-body capture: Fastify natively parses JSON before handlers run,
// which destroys the byte-exact body we need for HMAC. There's no
// `@fastify/raw-body` plugin in this codebase, but the standard pattern
// (used by auth.ts, logo-upload.ts, returns-photos.ts) is per-plugin
// `addContentTypeParser`. We register a `parseAs: "string"` JSON parser
// scoped to THIS plugin so `req.body` is the raw JSON string. We then
// HMAC-verify and JSON.parse it ourselves. Confined-scope means the rest
// of the app keeps its normal parsed-object body.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  vocatechEvents,
  phoneCommunications,
} from "../../db/schema/vocatech.js";
import { customers } from "../../db/schema/customers.js";
import { verifyVocatechSignature } from "../../integrations/vocatech/webhook-verifier.js";
import {
  getMediaUrl,
  listCalls,
  mapDirection,
  sendMessage,
  testWebhook,
  listWebhooks,
  getContactFields,
  VocatechApiError,
} from "../../integrations/vocatech/client.js";
import { matchPhoneToCustomer } from "../../integrations/vocatech/matcher.js";
import { env } from "../../lib/env.js";
import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";
import { requireAuth, isAdmin } from "../lib/auth.js";
import {
  getQueues,
  VOCATECH_BACKFILL_JOB,
  VOCATECH_ROSTER_JOB,
} from "../../jobs/queues.js";
import type { VocatechBackfillJobData } from "../../jobs/definitions/vocatech-backfill.js";
import type { VocatechRosterSyncJobData } from "../../jobs/definitions/vocatech-roster-sync.js";

const log = createLogger({ component: "routes.vocatech" });

// --- Zod schemas for endpoint bodies ----------------------------------------

const replayEventBodySchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  data: z.unknown(),
});

const sendSmsBodySchema = z.object({
  toNumber: z.string().min(7).max(32),
  body: z.string().min(1).max(1600),
});

// --- Payload shapes (defined locally; the webhook is an external contract) --

type CallEndedPayload = {
  id: string;
  event_type: "call.ended";
  data: {
    call_id: string;
    // Webhook direction may be either the REST-API spelling ("incoming"/
    // "outgoing"/"internal") or the older spec spelling ("inbound"/
    // "outbound"/"internal"). mapDirection() handles both.
    direction: string;
    extension?: string;
    extension_name?: string;
    remote_number: string;
    group_number?: string;
    start_time: string;
    end_time: string;
    duration: number;
  };
};

type CallTranscriptionPayload = {
  id: string;
  event_type: "call.transcription";
  data: {
    call_id: string;
    summary?: string;
    transcription?: string;
  };
};

type MessageReceivedPayload = {
  id: string;
  event_type: "message.received";
  data: {
    message_id: string;
    direction?: string;
    channel?: "text" | "whatsapp";
    from: string;
    to: string;
    body: string;
    status?: "sent" | "delivered" | "read" | "failed";
    // Per OpenAPI spec, the field is `sent_at` (NOT `created_at`).
    sent_at: string;
    attachments?: Array<{
      url: string;
      content_type: string;
      filename?: string;
      size?: number;
    }>;
  };
};

type MessageStatusUpdatedPayload = {
  id: string;
  event_type: "message.status_updated";
  data: {
    message_id: string;
    status: "sent" | "delivered" | "read" | "failed";
  };
};

type AnyVocatechPayload =
  | CallEndedPayload
  | CallTranscriptionPayload
  | MessageReceivedPayload
  | MessageStatusUpdatedPayload
  | { id: string; event_type: string; data: unknown };

// --- Plugin -----------------------------------------------------------------

const vocatechRoute: FastifyPluginAsync = async (app) => {
  // Scoped JSON-as-string parser. ONLY active inside this plugin (Fastify
  // content-type parsers are encapsulated to the registering scope). The
  // rest of the app keeps the default parsed-object body. We need the raw
  // string for HMAC verification on /webhook; the other routes in this
  // plugin re-parse it inline (one JSON.parse — cost is negligible).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // -------------------------------------------------------------------------
  // POST /webhook — public, HMAC-verified.
  // -------------------------------------------------------------------------
  app.post("/webhook", async (req, reply) => {
    const secret = env.VOCATECH_WEBHOOK_SECRET;
    if (!secret) {
      log.error("VOCATECH_WEBHOOK_SECRET not configured — refusing webhook");
      reply.code(500);
      return { error: "VOCATECH_WEBHOOK_SECRET not configured" };
    }

    // `req.body` is the raw JSON string thanks to the scoped parser above.
    const rawBody = typeof req.body === "string" ? req.body : "";
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
      log.warn(
        { reason: verification.reason },
        "webhook signature verification failed",
      );
      reply.code(401);
      return { error: `bad signature: ${verification.reason}` };
    }

    let payload: AnyVocatechPayload;
    try {
      payload = JSON.parse(rawBody) as AnyVocatechPayload;
    } catch (err) {
      log.warn({ err }, "webhook payload was not valid JSON");
      reply.code(400);
      return { error: "invalid JSON" };
    }
    if (!payload.id || !payload.event_type) {
      reply.code(400);
      return { error: "payload missing id or event_type" };
    }

    // Persist idempotently — Vocatech delivers at-least-once. Duplicate
    // events silently no-op via the primary key. We keep the raw payload
    // forever so we can replay against new handler logic later.
    await db
      .insert(vocatechEvents)
      .values({
        id: payload.id,
        eventType: payload.event_type,
        rawPayload: payload,
      })
      .onDuplicateKeyUpdate({
        // No-op-ish: re-write the same event_type. MySQL needs a SET
        // clause, and this column is constant for a given id.
        set: { eventType: payload.event_type },
      });

    // Dispatch synchronously. Handlers are quick (a few DB hits + an
    // optional API call) and Vocatech tolerates ~30s response times. If
    // throughput becomes an issue we can drop in a BullMQ worker here.
    try {
      await dispatchEvent(payload);
      await db
        .update(vocatechEvents)
        .set({ processedAt: new Date(), processingError: null })
        .where(eq(vocatechEvents.id, payload.id));
    } catch (err) {
      log.error(
        { err, eventId: payload.id, eventType: payload.event_type },
        "event handler failed",
      );
      await db
        .update(vocatechEvents)
        .set({
          processingError:
            err instanceof Error ? err.message : String(err),
        })
        .where(eq(vocatechEvents.id, payload.id));
      // Still return 200 — we've persisted the event, so we can replay it
      // later. Returning 5xx would trigger Vocatech retry storms.
    }

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // POST /replay-event — admin-only dev/debug tool.
  // -------------------------------------------------------------------------
  // Bypasses HMAC. Accepts a raw payload (typically copied from
  // `vocatech_events.raw_payload`) and runs it through the same dispatcher
  // as a real webhook. Useful for testing matcher/storage logic against
  // captured production payloads without exposing a public tunnel.
  app.post("/replay-event", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) {
      reply.code(403);
      return { error: "admin only" };
    }

    // Scoped parser hands us a string; parse it here.
    let body: unknown;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      reply.code(400);
      return { error: "invalid JSON" };
    }

    const parse = replayEventBodySchema.safeParse(body);
    if (!parse.success) {
      reply.code(400);
      return { error: "invalid body", details: parse.error.flatten() };
    }

    try {
      await dispatchEvent(parse.data as AnyVocatechPayload);
      return { ok: true };
    } catch (err) {
      log.error({ err }, "replay-event dispatch failed");
      reply.code(500);
      return {
        error: err instanceof Error ? err.message : "dispatch failed",
      };
    }
  });

  // -------------------------------------------------------------------------
  // GET /recording-url/:phoneCommId — authenticated.
  // -------------------------------------------------------------------------
  // Returns a fresh 30-minute signed media URL for a stored call recording.
  // Vocatech URLs aren't permanent; the audio player on the frontend calls
  // this every time it loads. 404 if the row has no `recordingMediaId`
  // (call_ended without transcription, or non-recorded call).
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
      const row = rows[0];
      if (!row || !row.mediaId) {
        reply.code(404);
        return { error: "recording not found" };
      }
      try {
        const result = await getMediaUrl(row.mediaId);
        return { url: result.url, expiresAt: result.expires_at };
      } catch (err) {
        log.warn(
          { err, phoneCommId: req.params.phoneCommId, mediaId: row.mediaId },
          "media url fetch failed",
        );
        reply.code(502);
        return { error: "could not fetch media url" };
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /customers/:id/sms — authenticated; send outbound SMS.
  // -------------------------------------------------------------------------
  // Sends via Vocatech, then immediately persists a `phone_communications`
  // row so the customer's timeline reflects the message before the carrier
  // ACK round-trips through `message.status_updated`. Status starts as
  // "sent"; later webhooks bump it to delivered/read/failed.
  app.post<{ Params: { id: string } }>(
    "/customers/:id/sms",
    async (req, reply) => {
      await requireAuth(req);

      // Scoped parser hands us a string; parse it here.
      let body: unknown;
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      } catch {
        reply.code(400);
        return { error: "invalid JSON" };
      }

      const parse = sendSmsBodySchema.safeParse(body);
      if (!parse.success) {
        reply.code(400);
        return { error: "invalid body", details: parse.error.flatten() };
      }

      const fromNumber = env.VOCATECH_FROM_NUMBER;
      if (!fromNumber) {
        reply.code(500);
        return { error: "VOCATECH_FROM_NUMBER not configured — set it in .env to a phone number registered with your Vocatech tenant" };
      }

      const cust = await db
        .select({ id: customers.id, displayName: customers.displayName })
        .from(customers)
        .where(eq(customers.id, req.params.id))
        .limit(1);
      if (cust.length === 0) {
        reply.code(404);
        return { error: "customer not found" };
      }

      try {
        await sendMessage({
          platform: "text",
          from: fromNumber,
          to: parse.data.toNumber,
          message: parse.data.body,
          name: cust[0]!.displayName,
        });
      } catch (err) {
        log.warn(
          { err, customerId: req.params.id },
          "outbound SMS send failed",
        );
        if (err instanceof VocatechApiError && err.status === 429) {
          reply.code(429);
          if (err.retryAfter) reply.header("Retry-After", String(err.retryAfter));
          return { error: "Vocatech rate limit — try again shortly", retryAfter: err.retryAfter };
        }
        reply.code(502);
        return { error: err instanceof Error ? err.message : "SMS send failed" };
      }

      // Vocatech's send response doesn't return a message_id — that arrives
      // later via message.sent / message.status_updated webhook. We persist
      // our row with sourceEventId=null so the webhook handler can attach
      // the upstream id when it arrives. The unique constraint allows
      // multiple NULL values, so this doesn't conflict with the dedupe.
      const id = nanoid();
      await db.insert(phoneCommunications).values({
        id,
        kind: "sms_out",
        customerId: req.params.id,
        // No phoneLabelMatched — outbound is operator-typed; we don't try
        // to label which of the customer's phones we hit.
        phoneLabelMatched: null,
        remoteNumber: parse.data.toNumber,
        direction: "outbound",
        startedAt: new Date(),
        body: parse.data.body,
        smsStatus: "sent",
        sourceEventId: null,
      });

      events.emit("phone-communication.received", {
        customerId: req.params.id,
        communicationId: id,
        kind: "sms_out",
      });

      return { ok: true, id };
    },
  );

  // -------------------------------------------------------------------------
  // POST /backfill — admin-only; enqueue a history backfill job.
  // -------------------------------------------------------------------------
  // Paginates /calls and /messages over a date range and inserts any rows
  // not already in phone_communications. Useful on first install and after
  // extended downtime. Returns the BullMQ job ID so the caller can poll
  // job status if needed.
  app.post("/backfill", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) {
      reply.code(403);
      return { error: "admin only" };
    }

    // Scoped parser hands us a string; parse it here.
    let body: unknown;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      reply.code(400);
      return { error: "invalid JSON" };
    }

    const isoDateSchema = z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd")
      .refine((s) => {
        const d = new Date(s + "T00:00:00Z");
        return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
      }, "invalid calendar date");

    const parse = z
      .object({
        startDate: isoDateSchema,
        endDate: isoDateSchema,
      })
      .refine((b) => b.startDate <= b.endDate, {
        message: "endDate must be on or after startDate",
      })
      .refine((b) => {
        const start = new Date(b.startDate + "T00:00:00Z").getTime();
        const end = new Date(b.endDate + "T00:00:00Z").getTime();
        const days = (end - start) / (24 * 60 * 60 * 1000);
        return days <= 365;
      }, { message: "range must be 365 days or less" })
      .safeParse(body);
    if (!parse.success) {
      reply.code(400);
      return { error: "invalid body", details: parse.error.flatten() };
    }

    const queues = getQueues();
    const jobId = `backfill:${parse.data.startDate}:${parse.data.endDate}`;
    const job = await queues.vocatechBackfill.add(
      VOCATECH_BACKFILL_JOB,
      parse.data as VocatechBackfillJobData,
      { jobId },
    );
    return { jobId: job.id };
  });

  // -------------------------------------------------------------------------
  // GET /health — authenticated (any user); integration status for Settings.
  // -------------------------------------------------------------------------
  app.get("/health", async (req, reply) => {
    await requireAuth(req);

    const apiKeyConfigured = !!env.VOCATECH_API_KEY;
    const webhookSecretConfigured = !!env.VOCATECH_WEBHOOK_SECRET;
    const fromNumberConfigured = !!env.VOCATECH_FROM_NUMBER;

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [lastRows, countRows] = await Promise.all([
      db
        .select({ lastAt: sql<string | null>`MAX(${vocatechEvents.receivedAt})` })
        .from(vocatechEvents),
      db
        .select({ n: sql<number>`COUNT(*)` })
        .from(vocatechEvents)
        .where(gt(vocatechEvents.receivedAt, cutoff)),
    ]);

    const lastWebhookAt = lastRows[0]?.lastAt ?? null;
    const recentEventCount24h = Number(countRows[0]?.n ?? 0);

    // API calls — degrade gracefully if unconfigured or unreachable.
    let webhooks: Awaited<ReturnType<typeof listWebhooks>> = [];
    let contactFieldsResult: Awaited<ReturnType<typeof getContactFields>> = { fields: [] };
    try {
      webhooks = await listWebhooks();
    } catch {
      // VOCATECH_API_KEY unset or API unreachable — return empty list
    }
    try {
      contactFieldsResult = await getContactFields();
    } catch {
      // same — return zero so UI can show the warning
    }

    const contactFields = contactFieldsResult.fields.map((f) => ({
      name: f.name,
      is_phone: f.is_phone,
      is_match: f.is_match,
      is_integration: f.is_integration,
    }));

    reply.code(200);
    return {
      apiKeyConfigured,
      webhookSecretConfigured,
      fromNumberConfigured,
      lastWebhookAt,
      recentEventCount24h,
      webhooks,
      contactFieldsCount: contactFields.length,
      contactFields,
    };
  });

  // -------------------------------------------------------------------------
  // POST /webhooks/:webhookId/test — admin-only; trigger a test delivery.
  // -------------------------------------------------------------------------
  app.post<{ Params: { webhookId: string } }>(
    "/webhooks/:webhookId/test",
    async (req, reply) => {
      const user = await requireAuth(req);
      if (!isAdmin(user)) {
        reply.code(403);
        return { error: "admin only" };
      }
      try {
        await testWebhook(req.params.webhookId);
        return { ok: true };
      } catch (err) {
        reply.code(502);
        return { error: err instanceof Error ? err.message : "test failed" };
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /roster-sync — admin-only; enqueue a full roster push to Vocatech.
  // -------------------------------------------------------------------------
  // Pushes all customers (scope "b2b" by default, or "all") into Vocatech's
  // contact directory. The nightly delta cron handles incremental updates;
  // this endpoint is for operator-triggered full refreshes (e.g. after a
  // data migration or first install). Uses the cached vocatechRoster queue
  // from getQueues() — no ephemeral Queue() construction needed.
  app.post("/roster-sync", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) {
      reply.code(403);
      return { error: "admin only" };
    }

    // Scoped parser hands us a string; parse it here.
    let body: unknown;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      reply.code(400);
      return { error: "invalid JSON" };
    }

    const parse = z
      .object({ scope: z.enum(["b2b", "all"]).default("b2b") })
      .safeParse(body);
    if (!parse.success) {
      reply.code(400);
      return { error: "invalid body", details: parse.error.flatten() };
    }

    const queues = getQueues();
    const job = await queues.vocatechRoster.add(
      VOCATECH_ROSTER_JOB,
      { mode: "full", scope: parse.data.scope } as VocatechRosterSyncJobData,
    );
    return { jobId: job.id };
  });

  // -------------------------------------------------------------------------
  // GET /unmatched?days=7 — authenticated; list unmatched phone comms.
  // -------------------------------------------------------------------------
  // Powers the Today-tab inbox: phone_communications rows whose
  // customer_id is NULL and dismissed_at is NULL, filtered to the last N
  // days. Caps at 200 rows — beyond that and the operator should be
  // running a phone-roster cleanup, not paging through the inbox.
  app.get("/unmatched", async (req, reply) => {
    await requireAuth(req);

    const parsed = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(7),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid query", details: parsed.error.flatten() };
    }

    const cutoff = new Date(Date.now() - parsed.data.days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(phoneCommunications)
      .where(
        and(
          isNull(phoneCommunications.customerId),
          isNull(phoneCommunications.dismissedAt),
          gte(phoneCommunications.startedAt, cutoff),
        ),
      )
      .orderBy(desc(phoneCommunications.startedAt))
      .limit(200);

    return { rows };
  });

  // -------------------------------------------------------------------------
  // POST /communications/:id/match  body: { customerId }
  // -------------------------------------------------------------------------
  // Operator-driven match for an unmatched call/SMS. Validates the
  // customer exists, re-runs the phone matcher to populate
  // phone_label_matched (only if the picked customer actually owns the
  // remote number — operator authority always wins, but we keep the
  // label honest: null when the operator overrides the matcher).
  app.post<{ Params: { id: string } }>(
    "/communications/:id/match",
    async (req, reply) => {
      await requireAuth(req);

      let body: unknown;
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      } catch {
        reply.code(400);
        return { error: "invalid JSON" };
      }

      const parse = z
        .object({ customerId: z.string().min(1).max(24) })
        .safeParse(body);
      if (!parse.success) {
        reply.code(400);
        return { error: "invalid body", details: parse.error.flatten() };
      }

      // Load the row + verify the customer exists in parallel.
      const [commRows, custRows] = await Promise.all([
        db
          .select()
          .from(phoneCommunications)
          .where(eq(phoneCommunications.id, req.params.id))
          .limit(1),
        db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, parse.data.customerId))
          .limit(1),
      ]);
      const comm = commRows[0];
      if (!comm) {
        reply.code(404);
        return { error: "communication not found" };
      }
      if (custRows.length === 0) {
        reply.code(404);
        return { error: "customer not found" };
      }

      // Re-run the matcher. If the matcher resolves to the same customer
      // we picked, keep its phoneLabel — otherwise the operator overrode
      // the matcher's opinion and we store the link with phoneLabel=null
      // (we don't know which of their phones we hit).
      const matcherResult = await matchPhoneToCustomer(comm.remoteNumber);
      const phoneLabelMatched =
        matcherResult && matcherResult.customerId === parse.data.customerId
          ? matcherResult.phoneLabel
          : null;

      await db
        .update(phoneCommunications)
        .set({
          customerId: parse.data.customerId,
          phoneLabelMatched,
        })
        .where(eq(phoneCommunications.id, req.params.id));

      // Emit a phone-communication.received event so the now-matched
      // customer's Calls & SMS tab refreshes if it's open.
      events.emit("phone-communication.received", {
        customerId: parse.data.customerId,
        communicationId: comm.id,
        kind: comm.kind,
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // POST /communications/:id/dismiss
  // -------------------------------------------------------------------------
  // Operator decided this unmatched call/SMS isn't worth chasing (wrong
  // number, spam, unrelated). Stamps dismissed_at + dismissed_by_user_id
  // so the row drops off the inbox query but is preserved for audit.
  app.post<{ Params: { id: string } }>(
    "/communications/:id/dismiss",
    async (req, reply) => {
      const user = await requireAuth(req);

      const rows = await db
        .select({ id: phoneCommunications.id })
        .from(phoneCommunications)
        .where(eq(phoneCommunications.id, req.params.id))
        .limit(1);
      if (rows.length === 0) {
        reply.code(404);
        return { error: "communication not found" };
      }

      await db
        .update(phoneCommunications)
        .set({
          dismissedAt: new Date(),
          dismissedByUserId: user.id,
        })
        .where(eq(phoneCommunications.id, req.params.id));

      return { ok: true };
    },
  );
};

// --- Event dispatcher + handlers --------------------------------------------

async function dispatchEvent(payload: AnyVocatechPayload): Promise<void> {
  switch (payload.event_type) {
    case "call.ended":
      await handleCallEnded(payload as CallEndedPayload);
      break;
    case "call.transcription":
      await handleCallTranscription(payload as CallTranscriptionPayload);
      break;
    case "message.received":
      await handleMessageReceived(payload as MessageReceivedPayload);
      break;
    case "message.status_updated":
      await handleMessageStatusUpdated(
        payload as MessageStatusUpdatedPayload,
      );
      break;
    default:
      log.debug(
        { event_type: payload.event_type, id: payload.id },
        "unhandled event type — stored only",
      );
  }
}

async function handleCallEnded(payload: CallEndedPayload): Promise<void> {
  const d = payload.data;

  const match = await matchPhoneToCustomer(d.remote_number);
  const dbDirection = mapDirection(d.direction);
  const kind = dbDirection === "outbound" ? "call_out" : "call_in";
  const id = nanoid();

  // INSERT IGNORE on source_event_id unique key — safe against concurrent
  // webhook retries and backfill runs without a SELECT-then-INSERT race.
  // (ODKU with no-op SET would also work, but mysql2's CLIENT_FOUND_ROWS
  // makes its affectedRows ambiguous for "row exists vs new"; IGNORE
  // gives a clean 1-vs-0 signal.)
  const result = await db.insert(phoneCommunications).ignore().values({
    id,
    kind,
    customerId: match?.customerId ?? null,
    phoneLabelMatched: match?.phoneLabel ?? null,
    remoteNumber: d.remote_number,
    extensionNumber: d.extension ?? null,
    extensionName: d.extension_name ?? null,
    direction: dbDirection,
    startedAt: new Date(d.start_time),
    durationSeconds: d.duration,
    groupNumber: d.group_number ?? null,
    sourceEventId: d.call_id,
  });

  const wasInserted = result[0].affectedRows === 1;
  if (!wasInserted) {
    log.debug({ callId: d.call_id }, "call already recorded; skipping");
    return;
  }

  if (match) {
    events.emit("phone-communication.received", {
      customerId: match.customerId,
      communicationId: id,
      kind,
    });
  }
}

async function handleCallTranscription(
  payload: CallTranscriptionPayload,
): Promise<void> {
  const d = payload.data;

  // Locate the row created by the prior `call.ended` event. If we haven't
  // seen call.ended yet (ordering anomaly) we log + bail; the row will
  // never get the summary/transcription/recording. Acceptable for v1 —
  // Vocatech orders these in practice.
  const rows = await db
    .select({
      id: phoneCommunications.id,
      customerId: phoneCommunications.customerId,
      startedAt: phoneCommunications.startedAt,
    })
    .from(phoneCommunications)
    .where(eq(phoneCommunications.sourceEventId, d.call_id))
    .limit(1);
  if (rows.length === 0) {
    log.warn(
      { callId: d.call_id },
      "transcription for unknown call; out-of-order webhooks?",
    );
    return;
  }
  const row = rows[0]!;

  // The per-segment recording_url isn't in the transcription webhook
  // payload, and Vocatech's OpenAPI spec doesn't expose GET /calls/{id}
  // (it returns 404). Look up the recording_media_id by paginating the
  // /calls list filtered to the day of the call. Bracket ±1 day so a
  // call that straddled the ET midnight boundary still resolves.
  // We store the rec_* id (not the URL) because Vocatech's media URLs
  // expire in 30 min; the /recording-url proxy mints a fresh one on
  // demand.
  let recordingMediaId: string | null = null;
  try {
    const oneDay = 24 * 60 * 60 * 1000;
    const callTs = row.startedAt.getTime();
    const startDate = new Date(callTs - oneDay).toISOString().slice(0, 10);
    const endDate = new Date(callTs + oneDay).toISOString().slice(0, 10);
    let page = 1;
    const MAX_PAGES = 100;
    outer: while (page <= MAX_PAGES) {
      const res = await listCalls({ startDate, endDate, direction: "any", page });
      for (const c of res.calls) {
        if (c.call_id !== d.call_id) continue;
        for (const seg of c.journey ?? []) {
          if (seg.recording_url) {
            const m = seg.recording_url.match(/\/media\/(rec_[A-Za-z0-9_-]+)/);
            if (m) {
              recordingMediaId = m[1] ?? null;
              break;
            }
          }
        }
        break outer;
      }
      if (page >= res.meta.total_pages) break;
      page++;
    }
  } catch (err) {
    // Swallow — transcription text is more important than the recording
    // id. A separate job can backfill the id later if needed.
    log.warn(
      { err, callId: d.call_id },
      "could not load call journey for recording id",
    );
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
    events.emit("phone-communication.updated", {
      customerId: row.customerId,
      communicationId: row.id,
    });
  }
}

async function handleMessageReceived(
  payload: MessageReceivedPayload,
): Promise<void> {
  const d = payload.data;

  const match = await matchPhoneToCustomer(d.from);
  const id = nanoid();

  // INSERT IGNORE on source_event_id unique key — see /webhook call.ended.
  // Attachments arrive as `data.attachments[]` per the spec, but
  // `phone_communications` doesn't have a column for them yet — we capture
  // the body text only. Adding attachment storage is a follow-up
  // (likely a new `phone_communication_attachments` table once a real
  // payload arrives so we can confirm field shapes).
  const result = await db.insert(phoneCommunications).ignore().values({
    id,
    kind: "sms_in",
    customerId: match?.customerId ?? null,
    phoneLabelMatched: match?.phoneLabel ?? null,
    remoteNumber: d.from,
    direction: "inbound",
    startedAt: new Date(d.sent_at),
    body: d.body,
    smsStatus: d.status ?? null,
    sourceEventId: d.message_id,
  });

  const wasInserted = result[0].affectedRows === 1;
  if (!wasInserted) {
    log.debug({ messageId: d.message_id }, "message already recorded; skipping");
    return;
  }

  if (match) {
    events.emit("phone-communication.received", {
      customerId: match.customerId,
      communicationId: id,
      kind: "sms_in",
    });
  }
}

async function handleMessageStatusUpdated(
  payload: MessageStatusUpdatedPayload,
): Promise<void> {
  const d = payload.data;

  // Locate the row by message_id. We update across both inbound and
  // outbound rows (Vocatech delivers status updates for outbound SMS in
  // particular). No SSE emit — status transitions (sent → delivered →
  // read) are too chatty to be worth a live push; the customer page will
  // pick them up on next fetch.
  await db
    .update(phoneCommunications)
    .set({ smsStatus: d.status })
    .where(eq(phoneCommunications.sourceEventId, d.message_id));
}

export default vocatechRoute;
