// Queue definitions and the shared ioredis connection used by both queues
// and workers. Exported as singletons so the producer (Fastify routes that
// enqueue ad-hoc jobs) and the consumer (the worker process) talk to the
// same Redis client and don't fight over connection limits.
//
// Three queues, one per concern:
//   - SYNC_QUEUE  — QuickBooks pulls (every 30 min, repeatable)
//   - GMAIL_QUEUE — Gmail polls (every 15 min, repeatable)
//   - CHASE_QUEUE — Daily chase digest (17:00 Europe/London)
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

export const QB_SYNC_JOB = "qb-sync";
export const GMAIL_POLL_JOB = "gmail-poll";
export const CHASE_DIGEST_JOB = "chase-digest";

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
    }
  | undefined;

export type Queues = {
  sync: Queue;
  gmail: Queue;
  chase: Queue;
};

export function getQueues(): Queues {
  if (cachedQueues) return cachedQueues;
  const connection = connectionOptions();
  cachedQueues = {
    sync: new Queue(SYNC_QUEUE, { connection, defaultJobOptions }),
    gmail: new Queue(GMAIL_QUEUE, { connection, defaultJobOptions }),
    chase: new Queue(CHASE_QUEUE, { connection, defaultJobOptions }),
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
