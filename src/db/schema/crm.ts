import {
  boolean,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { users } from "./auth";

export const ACTIVITY_KINDS = [
  "email_in",
  "email_out",
  "qbo_invoice_sent",
  "qbo_statement_sent",
  "qbo_payment",
  "qbo_credit_memo",
  "balance_change",
  "hold_on",
  "hold_off",
  "terms_changed",
  "manual_note",
  "task_created",
  "task_completed",
] as const;

export const ACTIVITY_SOURCES = [
  "gmail_poll",
  "app_send",
  "qbo_sync",
  "shopify_sync",
  "user_action",
  "ai_agent",
] as const;

export const activities = mysqlTable(
  "activities",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    kind: mysqlEnum("kind", ACTIVITY_KINDS).notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    subject: varchar("subject", { length: 512 }),
    // mediumtext (16 MB) rather than text (64 KB). Email bodies in
    // activities can exceed 64 KB easily — long threads, quoted replies,
    // signatures with embedded images. Same for body_html, which is
    // typically larger still.
    body: mediumtext("body"),
    bodyHtml: mediumtext("body_html"),
    source: mysqlEnum("source", ACTIVITY_SOURCES).notNull(),
    refType: varchar("ref_type", { length: 64 }),
    refId: varchar("ref_id", { length: 64 }),
    meta: json("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_activities_customer_id").on(t.customerId),
    occurredAtIdx: index("idx_activities_occurred_at").on(t.occurredAt),
    customerOccurredIdx: index("idx_activities_customer_occurred").on(
      t.customerId,
      t.occurredAt,
    ),
    kindIdx: index("idx_activities_kind").on(t.kind),
    refIdx: index("idx_activities_ref").on(t.refType, t.refId),
  }),
);

// Status as varchar(32) (not mysqlEnum) so future Kanban columns are a
// config change rather than a schema migration. The TASK_STATUSES array
// is the source of truth; routes validate against it via zod.
export const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const tasks = mysqlTable(
  "tasks",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    customerId: varchar("customer_id", { length: 24 }).references(() => customers.id, {
      onDelete: "cascade",
    }),
    assigneeUserId: varchar("assignee_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdByUserId: varchar("created_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    title: varchar("title", { length: 512 }).notNull(),
    body: text("body"),
    dueAt: timestamp("due_at"),
    priority: mysqlEnum("priority", TASK_PRIORITIES).notNull().default("normal"),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    // Free-form tags. Stored as a JSON array of strings so the API
    // doesn't need a join table for what's basically a label set. Cap
    // count + length is enforced at the route layer.
    tags: json("tags").$type<string[]>().default([]).notNull(),
    // Position within its Kanban column. Kanban drag-drop sets this
    // when a card moves; sort by status + position to render columns.
    // Floats so reorder is O(1) without rewriting every other row's
    // position (insert between A and B → (A.position + B.position) / 2).
    position: varchar("position", { length: 32 }).notNull().default("0"),
    relatedActivityId: varchar("related_activity_id", { length: 24 }).references(
      () => activities.id,
      { onDelete: "set null" },
    ),
    aiProposed: boolean("ai_proposed").notNull().default(false),
    completedAt: timestamp("completed_at"),
    completedByUserId: varchar("completed_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_tasks_customer_id").on(t.customerId),
    assigneeStatusDueIdx: index("idx_tasks_assignee_status_due").on(
      t.assigneeUserId,
      t.status,
      t.dueAt,
    ),
    statusDueIdx: index("idx_tasks_status_due").on(t.status, t.dueAt),
    // Composite for Kanban column queries: WHERE status='open' ORDER BY position
    statusPositionIdx: index("idx_tasks_status_position").on(
      t.status,
      t.position,
    ),
  }),
);

// Watchers — users who get notifications about a task without being
// assignees. Composite primary key on (taskId, userId) is the natural
// key; no surrogate id needed.
export const taskWatchers = mysqlTable(
  "task_watchers",
  {
    taskId: varchar("task_id", { length: 24 })
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.userId] }),
    userIdx: index("idx_task_watchers_user").on(t.userId),
  }),
);

// Generic comments. parent_type+parent_id keys allow comments on tasks
// today, customers/invoices/whatever later — adding a new parent type
// is a route change, not a schema migration.
export const COMMENT_PARENT_TYPES = [
  "task",
  "customer",
  "invoice",
] as const;
export type CommentParentType = (typeof COMMENT_PARENT_TYPES)[number];

export const comments = mysqlTable(
  "comments",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    parentType: varchar("parent_type", { length: 32 }).notNull(),
    parentId: varchar("parent_id", { length: 24 }).notNull(),
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    parentIdx: index("idx_comments_parent").on(t.parentType, t.parentId),
    userIdx: index("idx_comments_user").on(t.userId),
    createdAtIdx: index("idx_comments_created_at").on(t.createdAt),
  }),
);

// @-mentions. Written when a comment body matches /@\w+/ and resolves
// to a known user. Drives the per-user mention bell + inbox view, and
// the SSE "mention" event.
export const mentions = mysqlTable(
  "mentions",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    commentId: varchar("comment_id", { length: 24 })
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    mentionedUserId: varchar("mentioned_user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    byUserId: varchar("by_user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Denormalized parent reference so we can list "mentions for me on
    // task XYZ" without joining through comments.
    parentType: varchar("parent_type", { length: 32 }).notNull(),
    parentId: varchar("parent_id", { length: 24 }).notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // Primary read pattern: my unread mentions, newest first.
    mentionedReadIdx: index("idx_mentions_mentioned_read").on(
      t.mentionedUserId,
      t.readAt,
      t.createdAt,
    ),
    parentIdx: index("idx_mentions_parent").on(t.parentType, t.parentId),
    commentIdx: index("idx_mentions_comment").on(t.commentId),
  }),
);

export const EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;

export const emailLog = mysqlTable(
  "email_log",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    gmailMessageId: varchar("gmail_message_id", { length: 128 }).notNull().unique(),
    threadId: varchar("thread_id", { length: 128 }),
    // RFC 5322 Message-ID header captured from inbound + sent messages
    // (e.g. "<CABc...@mail.example.com>"). Distinct from gmailMessageId,
    // which is Gmail's internal API id. Used as the In-Reply-To value on
    // outbound replies so non-Gmail recipients render the thread
    // correctly (Gmail recipients also work via threadId, which the API
    // call site sets independently). Nullable for old rows pre-capture
    // and for the rare message that arrives without the header set.
    messageIdHeader: varchar("message_id_header", { length: 998 }),
    customerId: varchar("customer_id", { length: 24 }).references(() => customers.id, {
      onDelete: "set null",
    }),
    userId: varchar("user_id", { length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    direction: mysqlEnum("direction", EMAIL_DIRECTIONS).notNull(),
    aliasUsed: varchar("alias_used", { length: 255 }),
    fromAddress: varchar("from_address", { length: 255 }),
    toAddress: varchar("to_address", { length: 1024 }),
    subject: varchar("subject", { length: 512 }),
    // mediumtext (16 MB) — Gmail bodies of 64 KB+ are routine for long
    // threads with quoted replies + signatures + base64 inline images.
    body: mediumtext("body"),
    snippet: varchar("snippet", { length: 512 }),
    classification: varchar("classification", { length: 64 }),
    emailDate: timestamp("email_date").notNull(),
    // Set when a user marks the email "actioned" — drives the email-tab
    // filter that hides done items by default. Null = not yet actioned;
    // un-actioning sets back to null. Persisted so other team members
    // see the same state.
    actionedAt: timestamp("actioned_at"),
    actionedByUserId: varchar("actioned_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_email_log_customer_id").on(t.customerId),
    threadIdx: index("idx_email_log_thread").on(t.threadId),
    emailDateIdx: index("idx_email_log_email_date").on(t.emailDate),
    directionIdx: index("idx_email_log_direction").on(t.direction),
    // Composite for the per-customer "open" inbox query: unactioned
    // emails, newest first.
    customerActionedIdx: index("idx_email_log_customer_actioned").on(
      t.customerId,
      t.actionedAt,
      t.emailDate,
    ),
  }),
);

export const statementSends = mysqlTable(
  "statement_sends",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at").defaultNow().notNull(),
    sentByUserId: varchar("sent_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    sentToEmail: varchar("sent_to_email", { length: 255 }),
    // Sequential statement number assigned by the send routine.
    // Allocated atomically from the `statement_number_next` row in
    // app_settings, then written here so the audit trail and the
    // attached PDF agree on the same number for a given send. Nullable
    // for backfill compatibility — old rows pre-PDF-rewrite have no
    // assigned number.
    statementNumber: int("statement_number"),
    qboResponse: json("qbo_response").$type<Record<string, unknown>>(),
    statementType: mysqlEnum("statement_type", ["open_items", "balance_forward"])
      .notNull()
      .default("open_items"),
  },
  (t) => ({
    customerIdIdx: index("idx_statement_sends_customer_id").on(t.customerId),
    sentAtIdx: index("idx_statement_sends_sent_at").on(t.sentAt),
  }),
);

export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskWatcher = typeof taskWatchers.$inferSelect;
export type NewTaskWatcher = typeof taskWatchers.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type Mention = typeof mentions.$inferSelect;
export type NewMention = typeof mentions.$inferInsert;
export type EmailLog = typeof emailLog.$inferSelect;
export type NewEmailLog = typeof emailLog.$inferInsert;
export type StatementSend = typeof statementSends.$inferSelect;
export type NewStatementSend = typeof statementSends.$inferInsert;
