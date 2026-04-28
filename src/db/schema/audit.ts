import {
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { users } from "./auth";

export const auditLog = mysqlTable(
  "audit_log",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    userId: varchar("user_id", { length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 128 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    before: json("before").$type<Record<string, unknown>>(),
    after: json("after").$type<Record<string, unknown>>(),
  },
  (t) => ({
    occurredAtIdx: index("idx_audit_log_occurred_at").on(t.occurredAt),
    entityIdx: index("idx_audit_log_entity").on(t.entityType, t.entityId),
    userIdIdx: index("idx_audit_log_user_id").on(t.userId),
  }),
);

export const AI_SURFACES = [
  "agent_chat",
  "inline_draft_email",
  "inline_summarize",
  "inline_suggest",
  "inline_enhance",
  "task_proposal",
  "background_proposing",
  "chase_digest",
  "email_summary",
  "customer_summary",
  "action_plan",
] as const;

export const aiInteractions = mysqlTable(
  "ai_interactions",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    userId: varchar("user_id", { length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    surface: mysqlEnum("surface", AI_SURFACES).notNull(),
    model: varchar("model", { length: 64 }).notNull(),
    toolsCalled: json("tools_called").$type<
      { name: string; ok: boolean; durationMs?: number }[]
    >(),
    inputTokens: int("input_tokens").notNull().default(0),
    outputTokens: int("output_tokens").notNull().default(0),
    cacheReadTokens: int("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: int("cache_creation_tokens").notNull().default(0),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  },
  (t) => ({
    occurredAtIdx: index("idx_ai_interactions_occurred_at").on(t.occurredAt),
    surfaceIdx: index("idx_ai_interactions_surface").on(t.surface),
    userIdIdx: index("idx_ai_interactions_user_id").on(t.userId),
  }),
);

export const SYNC_KINDS = [
  "qb_full",
  "qb_incremental",
  "gmail_poll",
  "shopify_full",
  "shopify_incremental",
  "monday_mirror",
] as const;

export const SYNC_STATUSES = ["running", "ok", "failed", "partial"] as const;

export const syncRuns = mysqlTable(
  "sync_runs",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    kind: mysqlEnum("kind", SYNC_KINDS).notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    status: mysqlEnum("status", SYNC_STATUSES).notNull().default("running"),
    stats: json("stats").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
  },
  (t) => ({
    kindStartedIdx: index("idx_sync_runs_kind_started").on(t.kind, t.startedAt),
    statusIdx: index("idx_sync_runs_status").on(t.status),
  }),
);

export const aiDigests = mysqlTable(
  "ai_digests",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
    model: varchar("model", { length: 64 }).notNull(),
    inputTokens: int("input_tokens").notNull().default(0),
    outputTokens: int("output_tokens").notNull().default(0),
    cacheReadTokens: int("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: int("cache_creation_tokens").notNull().default(0),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    body: text("body").notNull(),
  },
  (t) => ({
    generatedAtIdx: index("idx_ai_digests_generated_at").on(t.generatedAt),
  }),
);

export const CHASE_METHODS = ["email", "phone", "statement", "in_person", "ai"] as const;
export const CHASE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const chaseLog = mysqlTable(
  "chase_log",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    chasedAt: timestamp("chased_at").defaultNow().notNull(),
    method: mysqlEnum("method", CHASE_METHODS).notNull(),
    severity: mysqlEnum("severity", CHASE_SEVERITIES).notNull(),
    aiDigestId: varchar("ai_digest_id", { length: 24 }).references(() => aiDigests.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
  },
  (t) => ({
    customerIdIdx: index("idx_chase_log_customer_id").on(t.customerId),
    chasedAtIdx: index("idx_chase_log_chased_at").on(t.chasedAt),
  }),
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type AiInteraction = typeof aiInteractions.$inferSelect;
export type NewAiInteraction = typeof aiInteractions.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
export type AiDigest = typeof aiDigests.$inferSelect;
export type NewAiDigest = typeof aiDigests.$inferInsert;
export type ChaseLog = typeof chaseLog.$inferSelect;
export type NewChaseLog = typeof chaseLog.$inferInsert;
