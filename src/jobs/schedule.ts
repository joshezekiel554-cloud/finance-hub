// Repeatable job registration.
//
// BullMQ deduplicates repeatable jobs by jobId, so calling this on every
// worker boot is idempotent — the second registration is a no-op against
// Redis. Cron strings:
//
//   qb-sync                 */30 * * * *     every 30 minutes
//   gmail-poll              */15 * * * *     every 15 minutes
//   task-overdue-scan       0 8 * * *        08:00 daily, Europe/London
//   chase-digest            0 17 * * *       17:00 daily, Europe/London
//   tag-email-daily         0 9 * * *        09:00 daily, Europe/London
//   tag-email-weekly        0 9 * * 1        09:00 Monday, Europe/London
//   tag-email-monthly       0 9 1 * *        09:00 1st of month, Europe/London
//   vocatech-roster-delta   0 2 * * *        02:00 daily, Europe/London
//   vocatech-auto-backfill  */2 * * * *      every 2 minutes — workaround
//                                            for outbound-call webhook gap;
//                                            handler defaults to today UTC
//                                            when data is empty.
//
// Timezone handling: BullMQ's `repeat.tz` applies the cron in that zone, so
// "0 17 * * *" with tz="Europe/London" fires at 17:00 BST in summer and
// 17:00 GMT in winter — exactly the local-business semantic we want. The
// node process can run in UTC and the digest still lands at 5pm London.

import type { Queues } from "./queues.js";
import {
  AUTOPILOT_SCAN_JOB,
  CHASE_DIGEST_JOB,
  GMAIL_POLL_JOB,
  QB_SYNC_JOB,
  TAG_EMAIL_DAILY_JOB,
  TAG_EMAIL_MONTHLY_JOB,
  TAG_EMAIL_WEEKLY_JOB,
  TASK_OVERDUE_SCAN_JOB,
  VOCATECH_BACKFILL_JOB,
  VOCATECH_ROSTER_DELTA_JOB,
} from "./queues.js";
import type { AutopilotScanJobData } from "./definitions/autopilot-scan.js";
import type { VocatechBackfillJobData } from "./definitions/vocatech-backfill.js";
import type { VocatechRosterSyncJobData } from "./definitions/vocatech-roster-sync.js";
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

  // Tag-email daily — 09:00 Europe/London every day.
  await queues.tagEmail.add(
    TAG_EMAIL_DAILY_JOB,
    { frequency: "daily" },
    {
      jobId: `repeat:${TAG_EMAIL_DAILY_JOB}`,
      repeat: { pattern: "0 9 * * *", tz: "Europe/London" },
    },
  );
  registered.push({ name: TAG_EMAIL_DAILY_JOB, cron: "0 9 * * *", tz: "Europe/London" });

  // Tag-email weekly — 09:00 Monday Europe/London.
  await queues.tagEmail.add(
    TAG_EMAIL_WEEKLY_JOB,
    { frequency: "weekly" },
    {
      jobId: `repeat:${TAG_EMAIL_WEEKLY_JOB}`,
      repeat: { pattern: "0 9 * * 1", tz: "Europe/London" },
    },
  );
  registered.push({ name: TAG_EMAIL_WEEKLY_JOB, cron: "0 9 * * 1", tz: "Europe/London" });

  // Tag-email monthly — 09:00 on the 1st of each month, Europe/London.
  await queues.tagEmail.add(
    TAG_EMAIL_MONTHLY_JOB,
    { frequency: "monthly" },
    {
      jobId: `repeat:${TAG_EMAIL_MONTHLY_JOB}`,
      repeat: { pattern: "0 9 1 * *", tz: "Europe/London" },
    },
  );
  registered.push({ name: TAG_EMAIL_MONTHLY_JOB, cron: "0 9 1 * *", tz: "Europe/London" });

  // Vocatech roster delta — 02:00 Europe/London daily. Pushes only customers
  // whose records have changed since the last push. Runs at night to avoid
  // contention with daytime traffic; 2am is consistently quiet for this site.
  await queues.vocatechRoster.add(
    VOCATECH_ROSTER_DELTA_JOB,
    { mode: "delta" } as VocatechRosterSyncJobData,
    {
      jobId: `repeat:${VOCATECH_ROSTER_DELTA_JOB}`,
      repeat: { pattern: "0 2 * * *", tz: "Europe/London" },
    },
  );
  registered.push({
    name: VOCATECH_ROSTER_DELTA_JOB,
    cron: "0 2 * * *",
    tz: "Europe/London",
  });

  // Vocatech auto-backfill — every 2 minutes. Workaround for outbound-call
  // webhook gap (Vocatech tenant doesn't fire call.ended for outbounds, so
  // calls would otherwise only land via manual backfill). Empty data → the
  // handler defaults startDate/endDate to today UTC; INSERT IGNORE on
  // source_event_id makes re-fetching the same day idempotent.
  //
  // API cost: 2 calls per fire (listCalls + listMessages page 1) = ~1.4k
  // requests/day; well within Vocatech's tier. Remove this job once the
  // webhook gap is fixed upstream.
  await queues.vocatechBackfill.add(
    VOCATECH_BACKFILL_JOB,
    {} as VocatechBackfillJobData,
    {
      jobId: `repeat:vocatech-auto-backfill`,
      repeat: { pattern: "*/2 * * * *" },
    },
  );
  registered.push({ name: "vocatech-auto-backfill", cron: "*/2 * * * *" });

  // Autopilot scan — every 4 hours, Europe/London (00/04/08/12/16/20).
  // Runs deterministic SQL across 5 candidate categories; NO AI calls
  // during the scheduled scan (drafting happens on-demand when the
  // operator clicks "Draft for selected" on the /autopilot page).
  await queues.autopilotScan.add(
    AUTOPILOT_SCAN_JOB,
    { trigger: "cron" } as AutopilotScanJobData,
    {
      jobId: `repeat:${AUTOPILOT_SCAN_JOB}`,
      repeat: { pattern: "0 */4 * * *", tz: "Europe/London" },
    },
  );
  registered.push({
    name: AUTOPILOT_SCAN_JOB,
    cron: "0 */4 * * *",
    tz: "Europe/London",
  });

  log.info({ jobs: registered }, "repeatable jobs registered");
  return registered;
}
