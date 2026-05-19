// BullMQ worker entrypoint.
//
// Runs as a separate Node process (pm2 manages it under the
// `finance-hub-worker` block in ecosystem.config.cjs). Connects to Redis,
// instantiates one Worker per queue, registers the repeatable jobs once on
// boot, and listens for SIGTERM/SIGINT to drain in-flight jobs cleanly
// before exiting.
//
// Why a separate process (vs. workers in the Fastify app):
//   - Independent restart cadence — sync code can crash without taking the
//     web server down with it.
//   - Different memory profile — fork mode, 512M cap on the worker side.
//   - Lets the web server stay snappy under heavy sync load.

import { Worker, type Job } from "bullmq";
import { processChaseDigest } from "./definitions/chase-digest.js";
import { processGmailPoll } from "./definitions/gmail-poll.js";
import { processQbSync } from "./definitions/qb-sync.js";
import { processTaskOverdueScan } from "./definitions/task-overdue-scan.js";
import { processTagEmail } from "./definitions/tag-email.js";
import { vocatechBackfillHandler } from "./definitions/vocatech-backfill.js";
import { vocatechRosterSyncHandler } from "./definitions/vocatech-roster-sync.js";
import { forwardBccHandler } from "./definitions/forward-bcc.js";
import { autopilotScanHandler } from "./definitions/autopilot-scan.js";
import { autopilotExecuteHandler } from "./definitions/autopilot-execute.js";
import {
  AUTOPILOT_EXECUTE_QUEUE,
  AUTOPILOT_SCAN_QUEUE,
  CHASE_QUEUE,
  FORWARD_BCC_QUEUE,
  GMAIL_QUEUE,
  NOTIFICATIONS_QUEUE,
  SYNC_QUEUE,
  TAG_EMAIL_QUEUE,
  VOCATECH_BACKFILL_QUEUE,
  VOCATECH_ROSTER_QUEUE,
  closeQueues,
  connectionOptions,
  getQueues,
} from "./queues.js";
import { seedDefaultTagEmailSchedules } from "../modules/tag-email/seed.js";
import { registerSchedules } from "./schedule.js";
import { env } from "../lib/env.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ component: "worker" });

// One concurrency per queue is plenty here — these jobs do a lot of I/O but
// our upstreams (QBO, Gmail, Vocatech) are rate-limited, and stacking
// parallel runs doesn't help. If load grows we can bump per-queue concurrency.
const QB_CONCURRENCY = 1;
const GMAIL_CONCURRENCY = 1;
const CHASE_CONCURRENCY = 1;
const NOTIFICATIONS_CONCURRENCY = 1;
const TAG_EMAIL_CONCURRENCY = 1;
const VOCATECH_BACKFILL_CONCURRENCY = 1;
const VOCATECH_ROSTER_CONCURRENCY = 1;
const FORWARD_BCC_CONCURRENCY = 2;
const AUTOPILOT_SCAN_CONCURRENCY = 1;
const AUTOPILOT_EXECUTE_CONCURRENCY = 2;

function buildWorkers(): Worker[] {
  const connection = connectionOptions();

  const qbWorker = new Worker(
    SYNC_QUEUE,
    async (job: Job) => processQbSync(job),
    { connection, concurrency: QB_CONCURRENCY },
  );

  const gmailWorker = new Worker(
    GMAIL_QUEUE,
    async (job: Job) => processGmailPoll(job),
    { connection, concurrency: GMAIL_CONCURRENCY },
  );

  const chaseWorker = new Worker(
    CHASE_QUEUE,
    async (job: Job) => processChaseDigest(job),
    { connection, concurrency: CHASE_CONCURRENCY },
  );

  const notificationsWorker = new Worker(
    NOTIFICATIONS_QUEUE,
    async (job: Job) => processTaskOverdueScan(job),
    { connection, concurrency: NOTIFICATIONS_CONCURRENCY },
  );

  const tagEmailWorker = new Worker(
    TAG_EMAIL_QUEUE,
    async (job: Job) => processTagEmail(job),
    { connection, concurrency: TAG_EMAIL_CONCURRENCY },
  );

  const vocatechBackfillWorker = new Worker(
    VOCATECH_BACKFILL_QUEUE,
    async (job: Job) => vocatechBackfillHandler(job),
    { connection, concurrency: VOCATECH_BACKFILL_CONCURRENCY },
  );

  const vocatechRosterWorker = new Worker(
    VOCATECH_ROSTER_QUEUE,
    async (job: Job) => vocatechRosterSyncHandler(job),
    { connection, concurrency: VOCATECH_ROSTER_CONCURRENCY },
  );

  const forwardBccWorker = new Worker(
    FORWARD_BCC_QUEUE,
    async (job: Job) => forwardBccHandler(job),
    { connection, concurrency: FORWARD_BCC_CONCURRENCY },
  );

  const autopilotScanWorker = new Worker(
    AUTOPILOT_SCAN_QUEUE,
    async (job: Job) => autopilotScanHandler(job),
    { connection, concurrency: AUTOPILOT_SCAN_CONCURRENCY },
  );

  const autopilotExecuteWorker = new Worker(
    AUTOPILOT_EXECUTE_QUEUE,
    async (job: Job) => autopilotExecuteHandler(job),
    { connection, concurrency: AUTOPILOT_EXECUTE_CONCURRENCY },
  );

  for (const w of [
    qbWorker,
    gmailWorker,
    chaseWorker,
    notificationsWorker,
    tagEmailWorker,
    vocatechBackfillWorker,
    vocatechRosterWorker,
    forwardBccWorker,
    autopilotScanWorker,
    autopilotExecuteWorker,
  ]) {
    w.on("failed", (job, err) => {
      log.error(
        {
          queue: w.name,
          jobId: job?.id,
          jobName: job?.name,
          attemptsMade: job?.attemptsMade,
          err: err.message,
        },
        "job failed",
      );
    });
    w.on("completed", (job) => {
      log.debug(
        { queue: w.name, jobId: job.id, jobName: job.name },
        "job completed",
      );
    });
    w.on("error", (err) => {
      log.warn({ queue: w.name, err: err.message }, "worker error event");
    });
  }

  return [
    qbWorker,
    gmailWorker,
    chaseWorker,
    notificationsWorker,
    tagEmailWorker,
    vocatechBackfillWorker,
    vocatechRosterWorker,
    forwardBccWorker,
  ];
}

async function shutdown(workers: Worker[], signal: string): Promise<void> {
  log.info({ signal, shadowMode: env.SHADOW_MODE }, "worker shutting down");
  // Tell workers to stop picking up new jobs and wait for current ones to
  // finish. BullMQ's close() does both — internally calls pause + drain.
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  log.info({ signal }, "worker shutdown complete");
  // Allow log buffers to flush before exit. Pino's transport may need a tick.
  setTimeout(() => process.exit(0), 50);
}

async function main(): Promise<void> {
  log.info(
    {
      shadowMode: env.SHADOW_MODE,
      nodeEnv: env.NODE_ENV,
      redisUrl: env.REDIS_URL.replace(/\/\/.*@/, "//[REDACTED]@"),
    },
    "worker booting",
  );

  const workers = buildWorkers();

  // Seed default tag-email schedule rows (idempotent).
  await seedDefaultTagEmailSchedules();

  // Register repeatable schedules. Idempotent: re-running on every boot just
  // updates the same jobIds in Redis. Done after workers start so jobs that
  // fire immediately have a consumer ready.
  const queues = getQueues();
  const scheduled = await registerSchedules(queues);
  log.info({ scheduled, workerCount: workers.length }, "worker ready");

  const handle = (signal: NodeJS.Signals): void => {
    void shutdown(workers, signal);
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);

  // Surface unhandled errors loudly. pm2 will restart on exit-code 1, but at
  // least we'll see why in the logs.
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled promise rejection in worker");
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err: err.message, stack: err.stack }, "uncaught exception in worker");
    // Let pm2 restart us; trying to recover from an uncaught is rarely safe.
    process.exit(1);
  });
}

main().catch((err) => {
  log.fatal({ err }, "worker failed to start");
  process.exit(1);
});
