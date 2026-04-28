import {
  boolean,
  index,
  json,
  mysqlEnum,
  mysqlTable,
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
    body: text("body"),
    bodyHtml: text("body_html"),
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

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
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
    status: mysqlEnum("status", TASK_STATUSES).notNull().default("open"),
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
  }),
);

export const EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;

export const emailLog = mysqlTable(
  "email_log",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    gmailMessageId: varchar("gmail_message_id", { length: 128 }).notNull().unique(),
    threadId: varchar("thread_id", { length: 128 }),
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
    body: text("body"),
    snippet: varchar("snippet", { length: 512 }),
    classification: varchar("classification", { length: 64 }),
    emailDate: timestamp("email_date").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_email_log_customer_id").on(t.customerId),
    threadIdx: index("idx_email_log_thread").on(t.threadId),
    emailDateIdx: index("idx_email_log_email_date").on(t.emailDate),
    directionIdx: index("idx_email_log_direction").on(t.direction),
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
export type EmailLog = typeof emailLog.$inferSelect;
export type NewEmailLog = typeof emailLog.$inferInsert;
export type StatementSend = typeof statementSends.$inferSelect;
export type NewStatementSend = typeof statementSends.$inferInsert;
