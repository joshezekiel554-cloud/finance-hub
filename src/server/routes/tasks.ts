// Tasks API. Backs the Kanban board, the per-customer tasks panel, and the
// "my tasks" inbox. Schema lives in src/db/schema/crm.ts.
//
// Conventions match customers.ts: every mutation requires auth, writes a
// row to audit_log capturing before/after, and emits a domain event via
// `events.emit(...)` so the SSE plugin can fan out to connected clients.
//
// Watch state is per-(task, user) and lives in task_watchers. Watchers
// are tracked separately from the assignee so a task can have one owner
// and many people quietly subscribed (e.g., the customer's account
// manager wants to see updates without being on the hook).

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  comments,
  mentions,
  tasks,
  taskWatchers,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
} from "../../db/schema/crm.js";
import { users } from "../../db/schema/auth.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";
import { resolveMentions } from "./comments.js";
import { recordNotification } from "../../modules/notifications/index.js";
import { env } from "../../lib/env.js";
import {
  mintViewerToken,
  mintEditToken,
  TasksEmbedSecretMissingError,
} from "../lib/tasks-embed-token.js";
import {
  requireMemberForUser,
  NoInboxAccountError,
} from "../../modules/tasks-shared/identity.js";
import { listMembers } from "../../integrations/inbox/members.js";
import {
  inboxFetch,
  InboxUnreachableError,
  InboxApiError,
} from "../../integrations/inbox/client.js";

// --- Shared-tasks embed config (M1) ------------------------------------------
// The embedded inbox global-tasks board. Finance points an <iframe> at:
//   `${INBOX_PUBLIC_URL}${EMBED_PATH}?vt=${viewerToken}`
// Path CONFIRMED with inbox (2026-06-22): a DEDICATED chrome-free route OUTSIDE
// the session-gated /tasks layout — https://inbox.feldart.com/embed/tasks?vt=<token>
// (the vt token is the auth; no session/redirect on this path).
const EMBED_PATH = "/embed/tasks";

// embed-url ?mode= — "edit" mints the M6 write-scoped token, anything else (incl.
// absent) yields a read-only view token. Coerced + defaulted so a missing/odd
// value degrades safely to "view" rather than erroring.
const embedModeSchema = z
  .enum(["view", "edit"])
  .catch("view")
  .default("view");

// Shape of a task as the inbox `GET /api/svc/tasks` endpoint returns it (LOCKED
// contract with inbox). `ownerId` is the ASSIGNEE member id (the inbox model
// names the assignee "owner"). The "my tasks" widget only needs these fields.
type InboxMineTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  financeCustomerId: string | null;
  ownerId: string | null;
};
type InboxMineResponse = { tasks: InboxMineTask[] };

// --- Shared-task CREATE (M2) -------------------------------------------------
// Finance creates a shared task by POSTing to inbox `POST /api/svc/tasks` with
// the CREATOR as `actingMemberId` and the ASSIGNEE (optional) as `ownerId`.
// LOCKED contract with inbox (2026-06-22). Comments / @mentions / attachments
// are authored ON the embedded inbox board, NOT here — M2 finance = creation.

// Body finance accepts from its own UI. ownerId / financeCustomerId are
// nullable+optional (null/omitted ownerId = unassigned). dueAt/reminderAt are
// ISO-8601 instants; we forward them to inbox verbatim.
// Maps finance's task priority vocabulary (crm.ts TASK_PRIORITIES) to the inbox
// Task model's enum. Locked contract: inbox = LOW|NORMAL|IMPORTANT|URGENT.
const FINANCE_TO_INBOX_PRIORITY: Record<string, string> = {
  low: "LOW",
  normal: "NORMAL",
  high: "IMPORTANT",
  urgent: "URGENT",
};

export const sharedCreateBodySchema = z
  .object({
    // inbox caps title at 300 (locked contract) — validate here so we fail fast.
    title: z.string().trim().min(1).max(300),
    body: z.string().max(10_000).nullable().optional(),
    ownerId: z.string().min(1).max(255).nullable().optional(),
    financeCustomerId: z.string().min(1).max(64).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    reminderAt: z.string().datetime({ offset: true }).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    // Watchers (EXCLUDES the owner) — inbox member ids. Forwarded verbatim.
    watcherIds: z.array(z.string().min(1).max(255)).max(50).optional(),
    // Recurrence (inbox contract). Field names forwarded verbatim to inbox.
    recurrenceKind: z
      .enum(["NONE", "DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY", "CUSTOM"])
      .optional(),
    recurrenceInterval: z.number().int().min(1).max(365).nullable().optional(),
    recurrenceUnit: z.enum(["DAY", "WEEK", "MONTH"]).nullable().optional(),
  })
  // A repeating task (recurrenceKind != NONE) REQUIRES a dueAt — the inbox
  // recurrence engine schedules the next occurrence off the due date, so a
  // recurring task with no anchor is meaningless. Enforce server-side too (not
  // just in the dialog) so any caller of this schema is held to the contract.
  .refine(
    (v) =>
      !v.recurrenceKind ||
      v.recurrenceKind === "NONE" ||
      (v.dueAt !== undefined && v.dueAt !== null),
    {
      message: "Repeating tasks require a due date",
      path: ["dueAt"],
    },
  )
  // CUSTOM recurrence requires interval + unit — hold non-dialog callers (the AI
  // agent / a direct API call) to the contract, not just the UI. (The dialog
  // always sends both for CUSTOM.)
  .refine(
    (v) =>
      v.recurrenceKind !== "CUSTOM" ||
      (typeof v.recurrenceInterval === "number" && v.recurrenceUnit != null),
    {
      message: "Custom recurrence requires an interval and a unit",
      path: ["recurrenceInterval"],
    },
  );
export type SharedCreateBody = z.infer<typeof sharedCreateBodySchema>;

// What inbox returns from POST /api/svc/tasks (LOCKED contract). `ownerId` is the
// assignee member id.
export type InboxCreatedTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  financeCustomerId: string | null;
  ownerId: string | null;
};
type InboxCreateResponse = { task: InboxCreatedTask };

/**
 * Resolve the finance user → their inbox member, then create the shared task in
 * inbox (the canonical store) with `actingMemberId` = the creator. Pure of HTTP
 * framing so it is unit-testable (mock identity + the inbox client). Surfaces
 * NoInboxAccountError / InboxUnreachableError / InboxApiError to the caller for
 * status mapping.
 */
export async function createSharedTaskForUser(
  user: { email: string | null | undefined },
  input: SharedCreateBody,
): Promise<InboxCreatedTask> {
  const member = await requireMemberForUser({ email: user.email ?? "" });
  const res = await inboxFetch<InboxCreateResponse>("/api/svc/tasks", {
    method: "POST",
    body: JSON.stringify({
      actingMemberId: member.teamMemberId,
      title: input.title,
      // Only forward the optional fields the caller actually set, so we don't
      // pin inbox defaults (e.g. send `ownerId: null` only when explicitly
      // unassigning vs omitting).
      // Field-name reconciliation to the locked inbox model: body→notes,
      // reminderAt→remindAt, priority mapped to inbox's enum.
      ...(input.body !== undefined ? { notes: input.body } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.financeCustomerId !== undefined
        ? { financeCustomerId: input.financeCustomerId }
        : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.reminderAt !== undefined ? { remindAt: input.reminderAt } : {}),
      ...(input.priority !== undefined
        ? { priority: FINANCE_TO_INBOX_PRIORITY[input.priority] ?? "NORMAL" }
        : {}),
      // Watchers + recurrence — field names match the inbox contract verbatim,
      // forwarded only when the caller set them (same conditional-spread story).
      ...(input.watcherIds !== undefined ? { watcherIds: input.watcherIds } : {}),
      ...(input.recurrenceKind !== undefined
        ? { recurrenceKind: input.recurrenceKind }
        : {}),
      ...(input.recurrenceInterval !== undefined
        ? { recurrenceInterval: input.recurrenceInterval }
        : {}),
      ...(input.recurrenceUnit !== undefined
        ? { recurrenceUnit: input.recurrenceUnit }
        : {}),
    }),
  });
  return res.task;
}

const log = createLogger({ component: "routes.tasks" });

// Limits on tag size — schema stores as JSON so the cap is purely a route
// concern. 32 tags × 64 chars each is plenty for any realistic taxonomy.
const tagsSchema = z
  .array(z.string().min(1).max(64))
  .max(32)
  .default([]);

const listQuerySchema = z.object({
  // assignee can be "me", "all", or a specific user id (varchar(255) per
  // schema). We don't want to validate the userId format strictly — auth.js
  // mints uuids today but the schema column is generic varchar.
  assignee: z.string().min(1).max(255).default("me"),
  // Comma-separated subset of TASK_STATUSES. Default hides "done" +
  // "cancelled" so the inbox view doesn't accumulate cruft.
  status: z
    .string()
    .default("open,in_progress,blocked")
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    )
    .pipe(z.array(z.enum(TASK_STATUSES))),
  customerId: z.string().min(1).max(24).optional(),
  q: z.string().max(200).optional(),
  sort: z
    .enum(["dueAt", "priority", "createdAt", "position"])
    .default("position"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const createBodySchema = z.object({
  title: z.string().min(1).max(512),
  body: z.string().max(10_000).nullable().optional(),
  customerId: z.string().min(1).max(24).nullable().optional(),
  assigneeUserId: z.string().min(1).max(255).nullable().optional(),
  dueAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  tags: tagsSchema.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  relatedActivityId: z.string().min(1).max(24).nullable().optional(),
});

// PATCH accepts every field as optional. dueAt accepts null to clear it.
const patchBodySchema = z.object({
  title: z.string().min(1).max(512).optional(),
  body: z.string().max(10_000).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  customerId: z.string().min(1).max(24).nullable().optional(),
  assigneeUserId: z.string().min(1).max(255).nullable().optional(),
  tags: tagsSchema.optional(),
  position: z.string().min(1).max(32).optional(),
  relatedActivityId: z.string().min(1).max(24).nullable().optional(),
});

const commentBodySchema = z.object({
  body: z.string().min(1).max(10_000),
});

// JSON-safe view of a task for audit_log.before/after. Drizzle hands us
// Date objects; ISO-stringify so JSON.parse(JSON.stringify(...)) round-trips
// timestamps the way audit readers expect.
function serializeTask(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    customerId: t.customerId,
    assigneeUserId: t.assigneeUserId,
    createdByUserId: t.createdByUserId,
    title: t.title,
    body: t.body,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    priority: t.priority,
    status: t.status,
    tags: t.tags,
    position: t.position,
    relatedActivityId: t.relatedActivityId,
    aiProposed: t.aiProposed,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    completedByUserId: t.completedByUserId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

const tasksRoute: FastifyPluginAsync = async (app) => {
  // GET /api/tasks — paginated list with filters. Defaults are tuned for
  // the "my open tasks" inbox: assignee=me, status excludes done/cancelled,
  // sorted by Kanban position so cards render in column order.
  app.get("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { assignee, status, customerId, q, sort, dir, limit, offset } =
      parse.data;

    const filters = [];
    if (assignee === "me") {
      filters.push(eq(tasks.assigneeUserId, user.id));
    } else if (assignee !== "all") {
      filters.push(eq(tasks.assigneeUserId, assignee));
    }
    if (status.length > 0) {
      filters.push(inArray(tasks.status, status));
    }
    if (customerId) {
      filters.push(eq(tasks.customerId, customerId));
    }
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      filters.push(or(like(tasks.title, term), like(tasks.body, term)));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const sortCol = {
      dueAt: tasks.dueAt,
      priority: tasks.priority,
      createdAt: tasks.createdAt,
      position: tasks.position,
    }[sort];
    const orderFn = dir === "asc" ? asc : desc;

    // Scalar subqueries enrich each row with the badge counts the Kanban
    // card renders (comments, watchers, mentions-for-me). Cheaper at this
    // scale than a JOIN+GROUP BY and avoids breaking the natural ORDER BY.
    // Mention count is filtered to the current user — that's the bell-
    // badge semantic ("how many of these mention me?"), not a global count.
    const rowsRaw = await db
      .select({
        id: tasks.id,
        customerId: tasks.customerId,
        assigneeUserId: tasks.assigneeUserId,
        createdByUserId: tasks.createdByUserId,
        title: tasks.title,
        body: tasks.body,
        dueAt: tasks.dueAt,
        priority: tasks.priority,
        status: tasks.status,
        tags: tasks.tags,
        position: tasks.position,
        relatedActivityId: tasks.relatedActivityId,
        aiProposed: tasks.aiProposed,
        completedAt: tasks.completedAt,
        completedByUserId: tasks.completedByUserId,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        // Hand-qualify `tasks`.`id` here. ${tasks.id} inside a sql tag
        // gets serialised as the bare column name `id`, and once that
        // lands inside the inner subquery it resolves against the
        // inner table (comments.id, task_watchers.id, mentions.id)
        // instead of tasks.id — so the WHERE was always-false and
        // every count returned 0. Same gotcha as
        // src/server/routes/customers.ts hasPendingRma + lastChasedAt.
        commentCount: sql<number>`(SELECT COUNT(*) FROM comments WHERE parent_type = 'task' AND parent_id = \`tasks\`.\`id\`)`,
        watcherCount: sql<number>`(SELECT COUNT(*) FROM task_watchers WHERE task_id = \`tasks\`.\`id\`)`,
        mentionCount: sql<number>`(SELECT COUNT(*) FROM mentions WHERE parent_type = 'task' AND parent_id = \`tasks\`.\`id\` AND mentioned_user_id = ${user.id})`,
        // Customer display name resolved via subquery so the kanban
        // card can render "for: Bais Hasforim" without a separate
        // per-task lookup. NULL when the task isn't customer-scoped.
        customerName: sql<string | null>`(SELECT display_name FROM customers WHERE id = \`tasks\`.\`customer_id\`)`,
      })
      .from(tasks)
      .where(where)
      .orderBy(orderFn(sortCol), asc(tasks.id))
      .limit(limit + 1) // +1 to detect hasMore without a separate count
      .offset(offset);

    const rows = rowsRaw.slice(0, limit);
    const hasMore = rowsRaw.length > limit;

    return reply.send({ rows, hasMore });
  });

  // POST /api/tasks — create a new task. Defaults are deliberately
  // opinionated so the UI can post a single field (title) and get a
  // sensible row out: assignee=current user, status=open, priority=normal,
  // position=1000 (high enough that new tasks land at the top of their
  // Kanban column without rewriting siblings).
  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const input = parse.data;

    const id = nanoid(24);
    const row = {
      id,
      customerId: input.customerId ?? null,
      assigneeUserId: input.assigneeUserId ?? user.id,
      createdByUserId: user.id,
      title: input.title,
      body: input.body ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      priority: input.priority ?? "normal",
      status: input.status ?? "open",
      tags: input.tags ?? [],
      position: "1000",
      relatedActivityId: input.relatedActivityId ?? null,
    };

    await db.insert(tasks).values(row);

    const insertedRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    const inserted = insertedRows[0]!;

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "task.create",
      entityType: "task",
      entityId: id,
      before: null,
      after: serializeTask(inserted),
    });

    events.emit("task.created", {
      taskId: id,
      customerId: inserted.customerId,
    });

    // Bell notification for the assignee — but not when the operator
    // assigned the task to themselves (no point pinging yourself).
    if (
      inserted.assigneeUserId &&
      inserted.assigneeUserId !== user.id
    ) {
      await recordNotification({
        userId: inserted.assigneeUserId,
        kind: "task_assigned",
        customerId: inserted.customerId,
        refType: "task",
        refId: id,
        payload: {
          taskTitle: inserted.title,
          byUserId: user.id,
          byUserName: user.name,
          byUserEmail: user.email,
        },
      });
    }

    log.info(
      { taskId: id, userId: user.id, customerId: inserted.customerId },
      "task created",
    );

    return reply.send({ task: inserted });
  });

  // GET /api/tasks/:id — detail view. Bundles comments + watchers +
  // mentions so the detail page renders from a single round trip.
  // Comments newest-first matches the chat-style rendering.
  app.get("/:id", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    const task = taskRows[0];
    if (!task) return reply.code(404).send({ error: "task not found" });

    const taskComments = await db
      .select()
      .from(comments)
      .where(and(eq(comments.parentType, "task"), eq(comments.parentId, id)))
      .orderBy(desc(comments.createdAt));

    // Watchers — return as user records so the UI can render avatars
    // without a follow-up call. Inner join so we naturally drop watchers
    // whose user row was deleted (the FK cascade should handle that, but
    // belt-and-suspenders).
    const watchers = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(taskWatchers)
      .innerJoin(users, eq(taskWatchers.userId, users.id))
      .where(eq(taskWatchers.taskId, id));

    const taskMentions = await db
      .select()
      .from(mentions)
      .where(and(eq(mentions.parentType, "task"), eq(mentions.parentId, id)))
      .orderBy(desc(mentions.createdAt));

    return reply.send({
      task,
      comments: taskComments,
      watchers,
      mentions: taskMentions,
    });
  });

  // PATCH /api/tasks/:id — partial update. Special case: when status
  // transitions to "done", stamp completedAt + completedByUserId so we
  // have an audit trail of who closed the task. Emit task.completed
  // (not task.updated) for that transition so SSE consumers can fire
  // a different visual treatment (confetti / strikethrough animation).
  app.patch("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const updates = parse.data;
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "no fields to update" });
    }

    const beforeRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "task not found" });

    // Build the drizzle update set. Translate Date strings → Date so
    // mysql2 binds them correctly. Only include keys the caller sent —
    // omitting a field shouldn't clobber it to null.
    const set: Partial<Task> = {};
    if (updates.title !== undefined) set.title = updates.title;
    if (updates.body !== undefined) set.body = updates.body;
    if (updates.status !== undefined) set.status = updates.status;
    if (updates.priority !== undefined) set.priority = updates.priority;
    if (updates.dueAt !== undefined) {
      set.dueAt = updates.dueAt ? new Date(updates.dueAt) : null;
    }
    if (updates.customerId !== undefined) set.customerId = updates.customerId;
    if (updates.assigneeUserId !== undefined) {
      set.assigneeUserId = updates.assigneeUserId;
    }
    if (updates.tags !== undefined) set.tags = updates.tags;
    if (updates.position !== undefined) set.position = updates.position;
    if (updates.relatedActivityId !== undefined) {
      set.relatedActivityId = updates.relatedActivityId;
    }

    // Status → done transition: stamp completion metadata. We only do
    // this on the EDGE (open/in_progress/blocked → done), not when a
    // task is already done and gets touched.
    const wentToDone = updates.status === "done" && before.status !== "done";
    if (wentToDone) {
      set.completedAt = new Date();
      set.completedByUserId = user.id;
    }
    // If status moves AWAY from done, clear the completion metadata so
    // re-opening a task doesn't keep stale completedBy info.
    if (
      updates.status !== undefined &&
      before.status === "done" &&
      updates.status !== "done"
    ) {
      set.completedAt = null;
      set.completedByUserId = null;
    }

    await db.update(tasks).set(set).where(eq(tasks.id, id));

    const afterRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    const after = afterRows[0]!;

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "task.update",
      entityType: "task",
      entityId: id,
      before: serializeTask(before),
      after: serializeTask(after),
    });

    if (wentToDone) {
      events.emit("task.completed", {
        taskId: id,
        customerId: after.customerId,
      });
    } else {
      events.emit("task.updated", {
        taskId: id,
        customerId: after.customerId,
      });
    }

    // Reassignment ping — fires when the assignee changes to someone
    // other than the editor. Self-reassignments and no-op writes don't
    // notify; matches the create-flow rule.
    const assigneeChanged =
      after.assigneeUserId !== before.assigneeUserId &&
      after.assigneeUserId !== null &&
      after.assigneeUserId !== user.id;
    if (assigneeChanged) {
      await recordNotification({
        userId: after.assigneeUserId!,
        kind: "task_assigned",
        customerId: after.customerId,
        refType: "task",
        refId: id,
        payload: {
          taskTitle: after.title,
          byUserId: user.id,
          byUserName: user.name,
          byUserEmail: user.email,
        },
      });
    }

    return reply.send({ task: after });
  });

  // DELETE /api/tasks/:id — hard delete. comments + watchers + mentions
  // cascade via FK on delete. We keep a copy of the row in audit_log.before
  // so a moderator can reconstruct after-the-fact what was deleted.
  app.delete("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const beforeRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "task not found" });

    await db.delete(tasks).where(eq(tasks.id, id));

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "task.delete",
      entityType: "task",
      entityId: id,
      before: serializeTask(before),
      after: null,
    });

    events.emit("task.deleted", {
      taskId: id,
      customerId: before.customerId,
    });

    log.info({ taskId: id, userId: user.id }, "task deleted");

    return reply.send({ ok: true });
  });

  // POST /api/tasks/:id/watch — current user starts watching. Idempotent:
  // the natural primary key (taskId, userId) makes a re-call a no-op via
  // onDuplicateKeyUpdate. Audit-logs only on a state change so a polling
  // UI doesn't churn the audit log.
  app.post("/:id/watch", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;

    // Confirm task exists — we'd insert a dangling watcher otherwise
    // (FK protects against this but we want a clean 404).
    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    if (!taskRows[0]) {
      return reply.code(404).send({ error: "task not found" });
    }

    const existing = await db
      .select()
      .from(taskWatchers)
      .where(
        and(eq(taskWatchers.taskId, id), eq(taskWatchers.userId, user.id)),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(taskWatchers).values({ taskId: id, userId: user.id });
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "task.watch",
        entityType: "task",
        entityId: id,
        before: null,
        after: { taskId: id, userId: user.id },
      });
    }

    return reply.send({ watching: true });
  });

  // DELETE /api/tasks/:id/watch — current user stops watching. Same
  // idempotency story: deleting an already-deleted row is fine.
  app.delete("/:id/watch", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const existing = await db
      .select()
      .from(taskWatchers)
      .where(
        and(eq(taskWatchers.taskId, id), eq(taskWatchers.userId, user.id)),
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .delete(taskWatchers)
        .where(
          and(eq(taskWatchers.taskId, id), eq(taskWatchers.userId, user.id)),
        );
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "task.unwatch",
        entityType: "task",
        entityId: id,
        before: { taskId: id, userId: user.id },
        after: null,
      });
    }

    return reply.send({ watching: false });
  });

  // POST /api/tasks/:id/comments — create a comment on a task. Lives on
  // the tasks router (rather than /api/comments) because the task is the
  // natural parent and we want to 404 if the task is gone before writing.
  // Generic comments routes (PATCH/DELETE) live in comments.ts.
  app.post("/:id/comments", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = commentBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { body } = parse.data;

    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    if (!taskRows[0]) {
      return reply.code(404).send({ error: "task not found" });
    }

    const commentId = nanoid(24);
    await db.insert(comments).values({
      id: commentId,
      parentType: "task",
      parentId: id,
      userId: user.id,
      body,
    });

    const insertedComments = await db
      .select()
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1);
    const comment = insertedComments[0]!;

    // Resolve mentions and write rows. resolveMentions handles the
    // self-mention skip + dedupe + per-user mention SSE event. We pass
    // existingMentionedUserIds=[] because this is a fresh comment.
    const newMentions = await resolveMentions({
      body,
      commentId,
      byUserId: user.id,
      byUserName: user.name,
      byUserEmail: user.email,
      parentType: "task",
      parentId: id,
      existingMentionedUserIds: [],
    });

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "comment.create",
      entityType: "comment",
      entityId: commentId,
      before: null,
      after: {
        id: commentId,
        parentType: "task",
        parentId: id,
        body,
        mentionedUserIds: newMentions.map((m) => m.mentionedUserId),
      },
    });

    events.emit("comment.created", {
      commentId,
      parentType: "task",
      parentId: id,
    });

    return reply.send({ comment, mentions: newMentions });
  });

  // --- Shared tasks (M1) -----------------------------------------------------
  // These two endpoints back the embedded inbox tasks board + the dashboard
  // "My tasks" widget. They are DISTINCT from the finance-native task system
  // above (which is the local Kanban). The board itself is inbox's; finance
  // only mints the scoped viewer token + proxies the assigned-to-me list.

  // GET /api/tasks/embed-url — mint a fresh short-lived token for the current
  // finance user and return the inbox board iframe URL scoped to them.
  //   ?mode=edit → mint a 30-min EDIT-scoped token (M6 interactive embed: open
  //                a task + edit core fields + drag-restatus). Inbox gates all
  //                writes on scope === "edit".
  //   default    → mint a 5-min VIEW token (read-only embed).
  app.get("/embed-url", async (req, reply) => {
    const user = await requireAuth(req);
    if (!user.email) {
      return reply.code(409).send({ error: "no_email_on_account" });
    }
    const mode = embedModeSchema.parse(
      (req.query as { mode?: unknown } | undefined)?.mode,
    );
    let token: string;
    try {
      token = mode === "edit" ? mintEditToken(user.email) : mintViewerToken(user.email);
    } catch (err) {
      if (err instanceof TasksEmbedSecretMissingError) {
        log.error("tasks embed secret not configured");
        return reply.code(503).send({ error: "tasks_not_configured" });
      }
      throw err;
    }
    const url = `${env.INBOX_PUBLIC_URL.replace(/\/+$/, "")}${EMBED_PATH}?vt=${encodeURIComponent(token)}`;
    return reply.send({ url, mode });
  });

  // GET /api/tasks/mine — proxy the current user's assigned tasks from inbox.
  // Resolves the finance user → inbox member (409 NoInboxAccount), then calls
  // inbox `GET /api/svc/tasks?mine`. Degrades to 503 when inbox is unreachable.
  app.get("/mine", async (req, reply) => {
    const user = await requireAuth(req);
    let member;
    try {
      member = await requireMemberForUser({ email: user.email ?? "" });
    } catch (err) {
      if (err instanceof NoInboxAccountError) {
        return reply.code(409).send({ error: "no_inbox_account", message: err.message });
      }
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      // A non-2xx from the inbox roster fetch is a sibling-service error, not a
      // finance bug — degrade to 502 rather than a 500.
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }

    try {
      // Locked contract: convey WHO is acting (the service token authenticates
      // the app, not a user) — inbox derives admin + scopes visibility from
      // actingMemberId, and `mine=1` filters to ownerId == actingMemberId.
      const res = await inboxFetch<InboxMineResponse>(
        `/api/svc/tasks?actingMemberId=${encodeURIComponent(member.teamMemberId)}&mine=1`,
      );
      return reply.send({ tasks: res.tasks ?? [] });
    } catch (err) {
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }
  });

  // --- Shared tasks: members + create (M2) -----------------------------------

  // GET /api/tasks/members — the assignee picker source. Returns the inbox
  // roster filtered to active, trimmed to just {teamMemberId, name} (don't leak
  // emails/roles to the picker — it only needs to render names + send an id).
  app.get("/members", async (req, reply) => {
    await requireAuth(req);
    try {
      const all = await listMembers();
      const members = all
        .filter((m) => m.active)
        .map((m) => ({ teamMemberId: m.teamMemberId, name: m.name }));
      return reply.send({ members });
    } catch (err) {
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }
  });

  // POST /api/tasks/shared — create a shared task in inbox (the canonical
  // store). Named `/shared` to avoid colliding with the native Kanban
  // `POST /api/tasks` above (different task system). The current user is the
  // creator (actingMemberId); `ownerId` (optional) is the assignee.
  app.post("/shared", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = sharedCreateBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }

    try {
      const task = await createSharedTaskForUser(
        { email: user.email },
        parse.data,
      );
      log.info(
        { taskId: task.id, byUserId: user.id, ownerId: task.ownerId },
        "shared task created",
      );
      return reply.code(201).send({ task });
    } catch (err) {
      if (err instanceof NoInboxAccountError) {
        return reply
          .code(409)
          .send({ error: "no_inbox_account", message: err.message });
      }
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }
  });
};

export default tasksRoute;
