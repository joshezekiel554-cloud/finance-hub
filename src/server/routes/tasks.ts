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
        commentCount: sql<number>`(SELECT COUNT(*) FROM comments WHERE parent_type = 'task' AND parent_id = ${tasks.id})`,
        watcherCount: sql<number>`(SELECT COUNT(*) FROM task_watchers WHERE task_id = ${tasks.id})`,
        mentionCount: sql<number>`(SELECT COUNT(*) FROM mentions WHERE parent_type = 'task' AND parent_id = ${tasks.id} AND mentioned_user_id = ${user.id})`,
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
};

export default tasksRoute;
