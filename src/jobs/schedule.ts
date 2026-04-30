// Repeatable job registration.
//
// BullMQ deduplicates repeatable jobs by jobId, so calling this on every
// worker boot is idempotent — the second registration is a no-op against
// Redis. Cron strings:
//
//   qb-sync             */30 * * * *     every 30 minutes
//   gmail-poll          */15 * * * *     every 15 minutes
//   task-overdue-scan   0 8 * * *        08:00 daily, Europe/London
//   chase-digest        0 17 * * *       17:00 daily, Europe/London
//
// Timezone handling: BullMQ's `repeat.tz` applies the cron in that zone, so
// "0 17 * * *" with tz="Europe/London" fires at 17:00 BST in summer and
// 17:00 GMT in winter — exactly the local-business semantic we want. The
// node process can run in UTC and the digest still lands at 5pm London.

import type { Queues } from "./queues.js";
import {
  CHASE_DIGEST_JOB,
  GMAIL_POLL_JOB,
  QB_SYNC_JOB,
  TASK_OVERDUE_SCAN_JOB,
} from "./queues.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ component: "jobs.schedule" });

type RegisteredJob = { name: string; cron: string; tz?: string };

export async function registerSchedules(queues: Queues): Promise<RegisteredJob[]> {
  const registered: RegisteredJob[] = [];

  // QB sync — every 30 minutes. Stable jobId so re-registration replaces the
  // previous schedule rather than stacking duplicates.
  await queues.sync.add(
    QB_SYNC_JOB,
    { trigger: "scheduled" },
    {
      jobId: `repeat:${QB_SYNC_JOB}`,
      repeat: { pattern: "*/30 * * * *" },
    },
  );
  registered.push({ name: QB_SYNC_JOB, cron: "*/30 * * * *" });

  // Gmail poll — every 15 minutes.
  await queues.gmail.add(
    GMAIL_POLL_JOB,
    { trigger: "scheduled" },
    {
      jobId: `repeat:${GMAIL_POLL_JOB}`,
      repeat: { pattern: "*/15 * * * *" },
    },
  );
  registered.push({ name: GMAIL_POLL_JOB, cron: "*/15 * * * *" });

  // Chase digest — 17:00 Europe/London daily. The tz field tracks DST.
  await queues.chase.add(
    CHASE_DIGEST_JOB,
    { trigger: "scheduled" },
    {
      jobId: `repeat:${CHASE_DIGEST_JOB}`,
      repeat: { pattern: "0 17 * * *", tz: "Europe/London" },
    },
  );
  registered.push({
    name: CHASE_DIGEST_JOB,
    cron: "0 17 * * *",
    tz: "Europe/London",
  });

  // Task-overdue scan — 08:00 Europe/London daily. Fires before the
  // operator's day starts so the bell is populated by the time they
  // open the app. Dedupe inside the job means stuck tasks don't spam.
  await queues.notifications.add(
    TASK_OVERDUE_SCAN_JOB,
    { trigger: "scheduled" },
    {
      jobId: `repeat:${TASK_OVERDUE_SCAN_JOB}`,
      repeat: { pattern: "0 8 * * *", tz: "Europe/London" },
    },
  );
  registered.push({
    name: TASK_OVERDUE_SCAN_JOB,
    cron: "0 8 * * *",
    tz: "Europe/London",
  });

  log.info({ jobs: registered }, "repeatable jobs registered");
  return registered;
}
