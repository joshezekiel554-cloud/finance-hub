// Gmail poll job processor.
//
// Wraps `pollNewEmails()` with sync_runs bookkeeping and structured logging.
// Like qb-sync, this is read-from-Gmail / write-to-our-DB, so SHADOW_MODE
// does not gate it.

import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { syncRuns } from "../../db/schema/audit.js";
import { pollNewEmails } from "../../integrations/gmail/poller.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.gmail-poll" });

export type GmailPollJobData = {
  trigger?: "scheduled" | "manual";
  maxResults?: number;
};

export type GmailPollJobResult = {
  syncRunId: string;
  fetched: number;
  inserted: number;
  matched: number;
  activitiesCreated: number;
  cursorAdvancedTo: string | null;
  durationMs: number;
};

export async function processGmailPoll(
  job: Job<GmailPollJobData>,
): Promise<GmailPollJobResult> {
  const startedAt = Date.now();
  const syncRunId = nanoid(24);
  const jobLog = log.child({ jobId: job.id, syncRunId });

  await db.insert(syncRuns).values({
    id: syncRunId,
    kind: "gmail_poll",
    status: "running",
  });

  jobLog.info(
    { stage: "started", trigger: job.data.trigger ?? "scheduled" },
    "gmail-poll job started",
  );

  try {
    const result = await pollNewEmails({
      ...(job.data.maxResults !== undefined && { maxResults: job.data.maxResults }),
    });
    const durationMs = Date.now() - startedAt;

    await db
      .update(syncRuns)
      .set({
        completedAt: new Date(),
        status: "ok",
        stats: { ...result, durationMs },
      })
      .where(eq(syncRuns.id, syncRunId));

    jobLog.info(
      { stage: "completed", ...result, durationMs },
      "gmail-poll job completed",
    );

    return { syncRunId, ...result, durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({
        completedAt: new Date(),
        status: "failed",
        errorMessage: message.slice(0, 1000),
      })
      .where(eq(syncRuns.id, syncRunId))
      .catch((updateErr) => {
        jobLog.error({ err: updateErr }, "failed to mark sync_run as failed");
      });
    jobLog.error({ err, stage: "failed" }, "gmail-poll job failed");
    throw err;
  }
}
