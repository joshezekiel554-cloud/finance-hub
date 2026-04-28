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
    endpoint: varchar("endpoint", { length: 1024 }).notNull(),
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
