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
