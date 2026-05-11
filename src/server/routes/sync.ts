// Manual QB sync trigger + status endpoints.
//
// GET  /api/sync/qb/last  → most recent sync_runs row (kind="qb_full")
//                           — drives the "last synced" badge on
//                           customer / chase pages.
// POST /api/sync/qb       → enqueue a manual qb-sync job. Operator
//                           presses this when they need fresh data for
//                           a statement send and don't want to wait
//                           for the 30-min cron tick. Returns the
//                           BullMQ job id so the UI can poll status if
//                           it ever wants to.
//
// Auth-gated. Doesn't run the sync inline — that'd block the request
// for 30+ seconds. The worker picks the job up within a second or so.

import type { FastifyPluginAsync } from "fastify";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { syncRuns } from "../../db/schema/audit.js";
import { getQueues, QB_SYNC_JOB } from "../../jobs/queues.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.sync" });

const syncRoute: FastifyPluginAsync = async (app) => {
  // Latest qb_full run — completed or running. The UI uses this to render
  // a "Synced N min ago" badge plus the running indicator while a job is
  // in flight.
  app.get("/qb/last", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.kind, "qb_full"))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) return reply.send({ run: null });
    return reply.send({
      run: {
        id: row.id,
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        status: row.status,
        stats: row.stats,
        errorMessage: row.errorMessage,
      },
    });
  });

  // Enqueue a one-shot manual sync. Idempotent on the queue side: BullMQ
  // happily accepts repeated adds; the worker processes them serially.
  app.post("/qb", async (req, reply) => {
    const user = await requireAuth(req);
    try {
      // BullMQ deduplicates jobs by jobId. Date.now() collides on
      // sub-millisecond clicks (two operators firing in the same ms),
      // silently dropping the second submission. nanoid gives us
      // enough entropy that a duplicate is effectively impossible.
      const job = await getQueues().sync.add(
        QB_SYNC_JOB,
        { trigger: "manual" },
        { jobId: `manual-${nanoid(12)}` },
      );
      log.info(
        { userId: user.id, jobId: job.id },
        "manual qb-sync enqueued",
      );
      return reply.send({ jobId: job.id });
    } catch (err) {
      log.error({ err }, "failed to enqueue manual qb-sync");
      return reply
        .code(502)
        .send({ error: "failed to enqueue sync job" });
    }
  });
};

export default syncRoute;
