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
import { eq } from "drizzle-orm";
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
  startDate?: string; // ISO yyyy-mm-dd. If omitted, defaults to today UTC.
  endDate?: string;   // If omitted, defaults to today UTC.
};

export type VocatechBackfillJobResult = {
  calls: number;
  // Existing rows enriched in place with newly-available
  // summary/transcription/recording (re-run / one-off back-enrichment).
  callsEnriched: number;
  messages: number;
};

const MAX_PAGES = 10_000;

export async function vocatechBackfillHandler(
  job: Job<VocatechBackfillJobData>,
): Promise<VocatechBackfillJobResult> {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = job.data.startDate ?? today;
  const endDate = job.data.endDate ?? today;
  log.info({ startDate, endDate, auto: !job.data.startDate }, "backfill starting");

  let callsTotal = 0;
  let callsEnriched = 0;
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
      let summary: string | null = null;
      let recordingMediaId: string | null = null;
      const segWithTranscription = c.journey?.find((s) => s.transcription);
      if (segWithTranscription) {
        transcription = segWithTranscription.transcription ?? null;
      }
      // AI summary — the journey segment carries it (client type:
      // VocatechCallJourneySegment.summary). The webhook path stores the
      // call-level summary in `body`; mirror that here. Previously this was
      // hardcoded to null, so NO backfilled call ever got a summary (and
      // backfill is the primary populator) — that's why summaries never
      // appeared. Harmless when the list omits it (stays null).
      const segWithSummary = c.journey?.find((s) => s.summary);
      if (segWithSummary) {
        summary = segWithSummary.summary ?? null;
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
        body: summary,
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
      } else if (summary || transcription || recordingMediaId) {
        // Row already existed (a prior backfill, or a call.ended webhook that
        // landed before transcription completed). Enrich it with whatever new
        // data the list now carries. We ONLY set the fields we actually have,
        // so we never null out data the webhook already delivered, and we
        // never touch customerId / phoneLabelMatched (an operator may have
        // manually matched this call). This is what lets a one-off backfill
        // over historical dates back-fill summaries/recordings onto calls
        // that were ingested before the summary was available.
        const enrich: Partial<{
          body: string;
          transcription: string;
          recordingMediaId: string;
        }> = {};
        if (summary) enrich.body = summary;
        if (transcription) enrich.transcription = transcription;
        if (recordingMediaId) enrich.recordingMediaId = recordingMediaId;
        await db
          .update(phoneCommunications)
          .set(enrich)
          .where(eq(phoneCommunications.sourceEventId, c.call_id));
        callsEnriched++;
      }
    }

    await job.updateProgress({ calls: callsTotal, callsEnriched, messages: messagesTotal });

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

    await job.updateProgress({ calls: callsTotal, callsEnriched, messages: messagesTotal });
    if (msgPage >= res.meta.total_pages) break;
    msgPage++;
    if (msgPage > MAX_PAGES) {
      throw new Error(`backfill exceeded ${MAX_PAGES} pages (messages) — likely runaway`);
    }
  }

  log.info({ callsTotal, callsEnriched, messagesTotal }, "backfill complete");
  return { calls: callsTotal, callsEnriched, messages: messagesTotal };
}
