// Task overdue scan job.
//
// Runs once a day (08:00 Europe/London — start of the operator's day,
// before the chase digest at 17:00). Finds every task whose due date is
// in the past and whose status isn't already done or cancelled, and
// drops a `task_overdue` bell notification on the assignee.
//
// Dedupe: recordNotification's dedupeOnRefId flag suppresses inserts
// when an unread row already exists for (userId, kind, refType=task,
// refId=taskId). Once the operator marks the bell row read OR completes
// the task, a future scan can drop another row — but never two unread
// at once for the same task. Stops the bell from ballooning over weeks.
//
// Read-only against tasks; only writes to notifications. Safe in shadow
// mode (which only gates outbound side effects to QBO/Gmail).

import type { Job } from "bullmq";
import { and, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tasks } from "../../db/schema/crm.js";
import { recordNotification } from "../../modules/notifications/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.task-overdue-scan" });

export type TaskOverdueScanJobData = {
  trigger?: "scheduled" | "manual";
};

export type TaskOverdueScanJobResult = {
  scanned: number;
  notified: number;
  skipped: number;
  durationMs: number;
};

export async function processTaskOverdueScan(
  job: Job<TaskOverdueScanJobData>,
): Promise<TaskOverdueScanJobResult> {
  const startedAt = Date.now();
  const jobLog = log.child({ jobId: job.id });

  jobLog.info(
    { stage: "started", trigger: job.data.trigger ?? "scheduled" },
    "task-overdue-scan started",
  );

  // We compare in MySQL with NOW() to avoid Node-vs-DB clock drift. The
  // due_at column is a timestamp (UTC at rest). Tasks with a future due
  // date or no due date are excluded by the WHERE clause.
  const overdue = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      assigneeUserId: tasks.assigneeUserId,
      customerId: tasks.customerId,
      dueAt: tasks.dueAt,
    })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueAt),
        lt(tasks.dueAt, sql`NOW()`),
        ne(tasks.status, "done"),
        ne(tasks.status, "cancelled"),
        isNotNull(tasks.assigneeUserId),
      ),
    );

  let notified = 0;
  let skipped = 0;
  for (const t of overdue) {
    if (!t.assigneeUserId) {
      skipped++;
      continue;
    }
    const id = await recordNotification({
      userId: t.assigneeUserId,
      kind: "task_overdue",
      customerId: t.customerId,
      refType: "task",
      refId: t.id,
      payload: {
        taskTitle: t.title,
        dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      },
      dedupeOnRefId: true,
    });
    if (id) notified++;
    else skipped++;
  }

  const durationMs = Date.now() - startedAt;
  jobLog.info(
    {
      stage: "completed",
      scanned: overdue.length,
      notified,
      skipped,
      durationMs,
    },
    "task-overdue-scan complete",
  );

  return {
    scanned: overdue.length,
    notified,
    skipped,
    durationMs,
  };
}
