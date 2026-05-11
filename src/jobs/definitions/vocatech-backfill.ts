// Vocatech backfill job.
//
// Paginates the Vocatech REST API over a caller-supplied date range and
// inserts any calls/messages we don't already have in `phone_communications`.
// This is how we hydrate history on first install and after extended
// downtime — the webhook only fires forward-going events.
//
// Progress is reported via job.updateProgress so BullMQ Bull-Board (or any
// monitor) can show live counts while the job pages through a large range.
//
// SSE events: none emitted. The UI polls the phone-communications endpoint
// directly; spamming the event bus with potentially thousands of historic
// rows would be noise. The next page load naturally picks up the new rows.
//
// 429 handling: we let VocatechApiError propagate and rely on BullMQ's
// 3-attempt exponential backoff (5s → 10s → 20s). Fine-grained per-page
// sleep-and-retry would complicate the loop significantly, and backfill is
// not time-critical. If the caller triggers it during off-hours this is
// rarely an issue in practice.

import type { Job } from "bullmq";
import { listCalls, listMessages } from "../../integrations/vocatech/client.js";
import { db } from "../../db/index.js";
import { phoneCommunications } from "../../db/schema/vocatech.js";
import { matchPhoneToCustomer } from "../../integrations/vocatech/matcher.js";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.vocatech-backfill" });

export type VocatechBackfillJobData = {
  startDate: string; // ISO yyyy-mm-dd
  endDate: string;
};

export type VocatechBackfillJobResult = {
  calls: number;
  messages: number;
};

const MAX_PAGES = 10_000;

export async function vocatechBackfillHandler(
  job: Job<VocatechBackfillJobData>,
): Promise<VocatechBackfillJobResult> {
  const { startDate, endDate } = job.data;
  log.info({ startDate, endDate }, "backfill starting");

  let callsTotal = 0;
  let messagesTotal = 0;

  // ---- Calls ----------------------------------------------------------------
  let page: string | undefined;
  let pageCount = 0;
  while (true) {
    const res = await listCalls({ startDate, endDate, direction: "any", page });
    for (const c of res.data) {
      const match = await matchPhoneToCustomer(c.remote_number);
      const kind = c.direction === "outbound" ? "call_out" : "call_in";

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

      const result = await db.insert(phoneCommunications).values({
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
        body: null,
        transcription,
        recordingMediaId,
        groupNumber: c.group_number ?? null,
        sourceEventId: c.call_id,
      }).onDuplicateKeyUpdate({
        // No-op upsert: keeps the existing row when source_event_id collides.
        set: { sourceEventId: sql`source_event_id` },
      });

      // MySQL: rowsAffected=1 means inserted, 0 means no-op duplicate.
      if (result[0].affectedRows === 1) {
        callsTotal++;
      }
    }

    await job.updateProgress({ calls: callsTotal, messages: messagesTotal });

    if (!res.next) break;
    if (res.next === page) {
      log.warn({ page }, "vocatech returned same cursor — breaking to avoid loop");
      break;
    }
    page = res.next;
    if (++pageCount > MAX_PAGES) {
      throw new Error(`backfill exceeded ${MAX_PAGES} pages — likely runaway`);
    }
  }

  // ---- Messages -------------------------------------------------------------
  let msgPage: string | undefined;
  let msgPageCount = 0;
  while (true) {
    const res = await listMessages({ startDate, endDate, direction: "any", page: msgPage });
    for (const m of res.data) {
      const kind = m.direction === "outbound" ? "sms_out" : "sms_in";
      const remoteNumber = m.direction === "outbound" ? m.to : m.from;
      const match = await matchPhoneToCustomer(remoteNumber);

      const result = await db.insert(phoneCommunications).values({
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
      }).onDuplicateKeyUpdate({
        // No-op upsert: keeps the existing row when source_event_id collides.
        set: { sourceEventId: sql`source_event_id` },
      });

      // MySQL: rowsAffected=1 means inserted, 0 means no-op duplicate.
      if (result[0].affectedRows === 1) {
        messagesTotal++;
      }
    }

    await job.updateProgress({ calls: callsTotal, messages: messagesTotal });
    if (!res.next) break;
    if (res.next === msgPage) {
      log.warn({ page: msgPage }, "vocatech returned same cursor — breaking to avoid loop");
      break;
    }
    msgPage = res.next;
    if (++msgPageCount > MAX_PAGES) {
      throw new Error(`backfill exceeded ${MAX_PAGES} pages (messages) — likely runaway`);
    }
  }

  log.info({ callsTotal, messagesTotal }, "backfill complete");
  return { calls: callsTotal, messages: messagesTotal };
}
