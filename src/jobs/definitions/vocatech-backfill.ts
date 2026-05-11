// Vocatech backfill job.
//
// Paginates the Vocatech REST API over a caller-supplied date range and
// inserts any calls/messages we don't already have in `phone_communications`.
// This is how we hydrate history on first install and after extended
// downtime — the webhook only fires forward-going events.
//
// Pagination model (confirmed against live API 2026-05-11): page-numbered,
// 1-indexed, stop when current page >= meta.total_pages. The response
// envelope is `{ calls: [...], meta }` for /calls and `{ messages: [...],
// meta }` for /messages — there is NO `data` field and NO `next` cursor.
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
import {
  listCalls,
  listMessages,
  mapDirection,
} from "../../integrations/vocatech/client.js";
import { db } from "../../db/index.js";
import { phoneCommunications } from "../../db/schema/vocatech.js";
import { matchPhoneToCustomer } from "../../integrations/vocatech/matcher.js";
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
  let page = 1;
  while (true) {
    const res = await listCalls({ startDate, endDate, direction: "any", page });
    for (const c of res.calls) {
      const match = await matchPhoneToCustomer(c.remote_number);
      const dbDirection = mapDirection(c.direction);
      const kind = dbDirection === "outbound" ? "call_out" : "call_in";

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

      const result = await db.insert(phoneCommunications).ignore().values({
        id: nanoid(),
        kind,
        customerId: match?.customerId ?? null,
        phoneLabelMatched: match?.phoneLabel ?? null,
        remoteNumber: c.remote_number,
        extensionNumber: c.extension ?? null,
        extensionName: c.extension_name ?? null,
        direction: dbDirection,
        startedAt: new Date(c.start_time),
        durationSeconds: c.duration,
        body: null,
        transcription,
        recordingMediaId,
        groupNumber: c.group_number ?? null,
        sourceEventId: c.call_id,
      });

      // INSERT IGNORE: affectedRows=1 on new insert, 0 when the UNIQUE
      // constraint on source_event_id rejected the row. This counter is
      // immune to mysql2's CLIENT_FOUND_ROWS flag (which only affects
      // UPDATE/REPLACE row counts, not IGNORE-rejected inserts).
      if (result[0].affectedRows === 1) {
        callsTotal++;
      }
    }

    await job.updateProgress({ calls: callsTotal, messages: messagesTotal });

    if (page >= res.meta.total_pages) break;
    page++;
    if (page > MAX_PAGES) {
      throw new Error(`backfill exceeded ${MAX_PAGES} pages — likely runaway`);
    }
  }

  // ---- Messages -------------------------------------------------------------
  let msgPage = 1;
  while (true) {
    const res = await listMessages({ startDate, endDate, direction: "any", page: msgPage });
    for (const m of res.messages) {
      const dbDirection = mapDirection(m.direction);
      const kind = dbDirection === "outbound" ? "sms_out" : "sms_in";
      // Vocatech messages have a single `remote_number` regardless of
      // direction — for an outbound message that's the recipient, for an
      // inbound message that's the sender.
      const remoteNumber = m.remote_number;
      const match = await matchPhoneToCustomer(remoteNumber);

      const result = await db.insert(phoneCommunications).ignore().values({
        id: nanoid(),
        kind,
        customerId: match?.customerId ?? null,
        phoneLabelMatched: match?.phoneLabel ?? null,
        remoteNumber,
        direction: dbDirection,
        startedAt: new Date(m.sent_time),
        body: m.body,
        smsStatus: m.status,
        groupNumber: m.group_number ?? null,
        sourceEventId: m.message_id,
      });

      // INSERT IGNORE — see /calls comment above.
      if (result[0].affectedRows === 1) {
        messagesTotal++;
      }
    }

    await job.updateProgress({ calls: callsTotal, messages: messagesTotal });
    if (msgPage >= res.meta.total_pages) break;
    msgPage++;
    if (msgPage > MAX_PAGES) {
      throw new Error(`backfill exceeded ${MAX_PAGES} pages (messages) — likely runaway`);
    }
  }

  log.info({ callsTotal, messagesTotal }, "backfill complete");
  return { calls: callsTotal, messages: messagesTotal };
}
