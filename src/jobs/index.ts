// Public surface of the jobs module. Imported by the Fastify app to enqueue
// ad-hoc jobs (e.g. "sync now" buttons) without needing to know how the
// worker process is wired internally.

export {
  CHASE_DIGEST_JOB,
  CHASE_QUEUE,
  GMAIL_POLL_JOB,
  GMAIL_QUEUE,
  QB_SYNC_JOB,
  SYNC_QUEUE,
  TAG_EMAIL_DAILY_JOB,
  TAG_EMAIL_MONTHLY_JOB,
  TAG_EMAIL_QUEUE,
  TAG_EMAIL_WEEKLY_JOB,
  VOCATECH_BACKFILL_JOB,
  VOCATECH_BACKFILL_QUEUE,
  VOCATECH_ROSTER_DELTA_JOB,
  VOCATECH_ROSTER_JOB,
  VOCATECH_ROSTER_QUEUE,
  closeQueues,
  getConnection,
  getQueues,
  type Queues,
} from "./queues.js";

export { registerSchedules } from "./schedule.js";

export type {
  QbSyncJobData,
  QbSyncJobResult,
} from "./definitions/qb-sync.js";
export type {
  GmailPollJobData,
  GmailPollJobResult,
} from "./definitions/gmail-poll.js";
export type {
  ChaseDigestJobData,
  ChaseDigestJobResult,
} from "./definitions/chase-digest.js";
export type {
  TagEmailJobData,
  TagEmailJobResult,
} from "./definitions/tag-email.js";
export type {
  VocatechBackfillJobData,
  VocatechBackfillJobResult,
} from "./definitions/vocatech-backfill.js";
export type {
  VocatechRosterSyncJobData,
  VocatechRosterSyncJobResult,
} from "./definitions/vocatech-roster-sync.js";
