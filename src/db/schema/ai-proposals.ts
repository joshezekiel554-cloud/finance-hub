import {
  decimal,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const AI_PROPOSAL_CATEGORIES = [
  "chase_next",
  "cadence_statement",
  "cadence_cold",
  "ops_rma_stalled",
  "ops_cron_fail",
  "tj_chase",
  "tj_dispute_nudge",
] as const;
export type AiProposalCategory = (typeof AI_PROPOSAL_CATEGORIES)[number];

export const AI_PROPOSAL_STATUSES = [
  "pending",
  "drafting",
  "drafted",
  "approved",
  "executed",
  "execution_failed",
  "dismissed",
  "snoozed",
  "rejected",
  "expired",
  "superseded",
] as const;
export type AiProposalStatus = (typeof AI_PROPOSAL_STATUSES)[number];

export const aiProposals = mysqlTable(
  "ai_proposals",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    category: varchar("category", { length: 32 }).notNull(),
    // Which book the proposal belongs to. 'tj' categories (tj_chase,
    // tj_dispute_nudge) insert 'tj'; chase_next inserts 'feldart'; null =
    // book-agnostic categories (cadence_*, ops_*).
    origin: mysqlEnum("origin", ["feldart", "tj"]),
    // Where the proposal came from: the autopilot scanner ('scan') or an
    // agent chat turn ('chat', Wave B). One queue + one executor either way.
    source: mysqlEnum("source", ["scan", "chat"]).default("scan").notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    candidateSummary: json("candidate_summary")
      .$type<Record<string, unknown>>()
      .notNull(),
    draftedAction: json("drafted_action").$type<{
      tool: string;
      args: Record<string, unknown>;
    }>(),
    draftedPreview: text("drafted_preview"),
    draftedAt: timestamp("drafted_at"),
    reasoning: text("reasoning"),
    confidence: decimal("confidence", { precision: 3, scale: 2 }),
    scanId: varchar("scan_id", { length: 24 }).notNull(),
    decidedAt: timestamp("decided_at"),
    decidedByUserId: varchar("decided_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    snoozedUntil: timestamp("snoozed_until"),
    executedAt: timestamp("executed_at"),
    executionError: text("execution_error"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    statusCategoryIdx: index("idx_ai_proposals_status_category").on(
      t.status,
      t.category,
      t.createdAt,
    ),
    entityIdx: index("idx_ai_proposals_entity").on(
      t.entityType,
      t.entityId,
      t.status,
    ),
    scanIdx: index("idx_ai_proposals_scan").on(t.scanId),
  }),
);

export type AiProposal = typeof aiProposals.$inferSelect;
export type NewAiProposal = typeof aiProposals.$inferInsert;
