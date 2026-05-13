// Queue definitions and the shared ioredis connection used by both queues
// and workers. Exported as singletons so the producer (Fastify routes that
// enqueue ad-hoc jobs) and the consumer (the worker process) talk to the
// same Redis client and don't fight over connection limits.
//
// Eight queues, one per concern:
//   - SYNC_QUEUE              — QuickBooks pulls (every 30 min, repeatable)
//   - GMAIL_QUEUE             — Gmail polls (every 15 min, repeatable)
//   - CHASE_QUEUE             — Daily chase digest (17:00 Europe/London)
//   - NOTIFICATIONS_QUEUE     — Daily task-overdue scan (08:00 Europe/London)
//   - TAG_EMAIL_QUEUE         — Tag-driven digest emails (daily/weekly/monthly)
//   - VOCATECH_BACKFILL_QUEUE — Ad-hoc history backfill (admin-triggered)
//   - VOCATECH_ROSTER_QUEUE   — Contact roster push (full or nightly delta)
//   - FORWARD_BCC_QUEUE       — BCC-forward copies after QB invoice/receipt send
//
// Defaults are conservative: 3 attempts with exponential backoff, completed
// jobs trimmed at 100 to keep Redis memory bounded; failed jobs trimmed at
// 500 so we can still inspect a handful of recent failures.

import { Queue, type ConnectionOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "../lib/env.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ component: "jobs.queues" });

export const SYNC_QUEUE = "sync";
export const GMAIL_QUEUE = "gmail";
export const CHASE_QUEUE = "chase";
export const NOTIFICATIONS_QUEUE = "notifications";
export const TAG_EMAIL_QUEUE = "tag-email";
export const VOCATECH_BACKFILL_QUEUE = "vocatech-backfill";
export const VOCATECH_ROSTER_QUEUE = "vocatech-roster";
export const FORWARD_BCC_QUEUE = "forward-bcc";

export const QB_SYNC_JOB = "qb-sync";
export const GMAIL_POLL_JOB = "gmail-poll";
export const CHASE_DIGEST_JOB = "chase-digest";
export const TASK_OVERDUE_SCAN_JOB = "task-overdue-scan";
export const TAG_EMAIL_DAILY_JOB = "tag-email-daily";
export const TAG_EMAIL_WEEKLY_JOB = "tag-email-weekly";
export const TAG_EMAIL_MONTHLY_JOB = "tag-email-monthly";
export const VOCATECH_BACKFILL_JOB = "vocatech-backfill";
export const VOCATECH_ROSTER_JOB = "vocatech-roster-full";
export const VOCATECH_ROSTER_DELTA_JOB = "vocatech-roster-delta";
export const FORWARD_BCC_JOB = "forward-bcc";

let cachedConnection: Redis | undefined;

// BullMQ requires `maxRetriesPerRequest: null` on the underlying ioredis
// client so blocking commands (BRPOPLPUSH, etc.) don't time out. We also
// disable the default 30-attempt retry; one retry-per-request is enough,
// callers handle their own retry semantics via job attempts.
function createConnection(): Redis {
  const conn = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  conn.on("error", (err) => {
    log.warn({ err: err.message }, "redis connection error");
  });
  return conn;
}

export function getConnection(): Redis {
  if (!cachedConnection) cachedConnection = createConnection();
  return cachedConnection;
}

export function connectionOptions(): ConnectionOptions {
  return getConnection() as ConnectionOptions;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

let cachedQueues:
  | {
      sync: Queue;
      gmail: Queue;
      chase: Queue;
      notifications: Queue;
      tagEmail: Queue;
      vocatechBackfill: Queue;
      vocatechRoster: Queue;
      forwardBcc: Queue;
    }
  | undefined;

export type Queues = {
  sync: Queue;
  gmail: Queue;
  chase: Queue;
  notifications: Queue;
  tagEmail: Queue;
  vocatechBackfill: Queue;
  vocatechRoster: Queue;
  forwardBcc: Queue;
};

export function getQueues(): Queues {
  if (cachedQueues) return cachedQueues;
  const connection = connectionOptions();
  cachedQueues = {
    sync: new Queue(SYNC_QUEUE, { connection, defaultJobOptions }),
    gmail: new Queue(GMAIL_QUEUE, { connection, defaultJobOptions }),
    chase: new Queue(CHASE_QUEUE, { connection, defaultJobOptions }),
    notifications: new Queue(NOTIFICATIONS_QUEUE, {
      connection,
      defaultJobOptions,
    }),
    tagEmail: new Queue(TAG_EMAIL_QUEUE, { connection, defaultJobOptions }),
    vocatechBackfill: new Queue(VOCATECH_BACKFILL_QUEUE, {
      connection,
      defaultJobOptions,
    }),
    vocatechRoster: new Queue(VOCATECH_ROSTER_QUEUE, {
      connection,
      defaultJobOptions,
    }),
    forwardBcc: new Queue(FORWARD_BCC_QUEUE, { connection, defaultJobOptions }),
  };
  return cachedQueues;
}

// Graceful shutdown: close every queue and the shared redis client.
// Called from worker.ts on SIGTERM/SIGINT.
export async function closeQueues(): Promise<void> {
  if (cachedQueues) {
    await Promise.all([
      cachedQueues.sync.close(),
      cachedQueues.gmail.close(),
      cachedQueues.chase.close(),
      cachedQueues.notifications.close(),
      cachedQueues.tagEmail.close(),
      cachedQueues.vocatechBackfill.close(),
      cachedQueues.vocatechRoster.close(),
      cachedQueues.forwardBcc.close(),
    ]);
    cachedQueues = undefined;
  }
  if (cachedConnection) {
    await cachedConnection.quit().catch(() => {
      // Connection may already be ending; force-disconnect as a last resort.
      cachedConnection?.disconnect();
    });
    cachedConnection = undefined;
  }
}
