import {
  boolean,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { users } from "./auth";

export const NOTIFICATION_KINDS = [
  "customer_email_in",
  "task_assigned",
  "task_overdue",
  "mention",
  "ai_proposal",
  "chase_due",
  "system",
] as const;

export const notifications = mysqlTable(
  "notifications",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: mysqlEnum("kind", NOTIFICATION_KINDS).notNull(),
    customerId: varchar("customer_id", { length: 24 }).references(() => customers.id, {
      onDelete: "set null",
    }),
    refType: varchar("ref_type", { length: 64 }),
    refId: varchar("ref_id", { length: 64 }),
    payload: json("payload").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at"),
    deliveredInApp: boolean("delivered_in_app").notNull().default(false),
    deliveredEmail: boolean("delivered_email").notNull().default(false),
    deliveredPush: boolean("delivered_push").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index("idx_notifications_user_id").on(t.userId),
    userReadIdx: index("idx_notifications_user_read").on(t.userId, t.readAt),
    createdAtIdx: index("idx_notifications_created_at").on(t.createdAt),
  }),
);

export const pushSubscriptions = mysqlTable(
  "push_subscriptions",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 512 keeps the indexed key under MySQL's 3072-byte utf8mb4 limit
    // (512 * 4 = 2048 bytes). Real Web Push endpoints are 200-500 chars.
    endpoint: varchar("endpoint", { length: 512 }).notNull(),
    p256dh: varchar("p256dh", { length: 255 }).notNull(),
    auth: varchar("auth", { length: 255 }).notNull(),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index("idx_push_subscriptions_user_id").on(t.userId),
    endpointIdx: index("idx_push_subscriptions_endpoint").on(t.endpoint),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

// ---------------------------------------------------------------------------
// Tag-email schedules
// ---------------------------------------------------------------------------
// Operator-configured schedules that fire a digest email on a recurring basis.
// Each row ties a customer tag to a recipient address + frequency + content
// template. The worker queries enabled=true rows for each frequency bucket
// (daily/weekly/monthly) and dispatches one email per row.

export const TAG_EMAIL_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export const TAG_EMAIL_CONTENT_TYPES = ["hold_or_upfront_summary"] as const;

export const tagEmailSchedules = mysqlTable(
  "tag_email_schedules",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    tag: varchar("tag", { length: 64 }).notNull(),
    recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
    frequency: mysqlEnum("frequency", TAG_EMAIL_FREQUENCIES).notNull(),
    contentType: mysqlEnum("content_type", TAG_EMAIL_CONTENT_TYPES).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastSentAt: timestamp("last_sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    tagIdx: index("tag_email_schedules_tag_idx").on(t.tag),
    enabledIdx: index("tag_email_schedules_enabled_idx").on(t.enabled),
  }),
);

export type TagEmailSchedule = typeof tagEmailSchedules.$inferSelect;
export type NewTagEmailSchedule = typeof tagEmailSchedules.$inferInsert;
