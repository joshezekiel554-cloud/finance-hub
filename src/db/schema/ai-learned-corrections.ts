import {
  index,
  json,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const CORRECTION_STATUSES = [
  "proposed",
  "active",
  "rejected",
  "retired",
] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

// Distilled, operator-approved style corrections injected into autopilot
// drafts. `tags` = "global" and/or AiProposalCategory slugs (same scheme as
// ai_company_facts). `sourceProposalIds` records which draft-vs-sent pairs
// the correction was distilled from (provenance).
export const aiLearnedCorrections = mysqlTable(
  "ai_learned_corrections",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    correction: text("correction").notNull(),
    tags: json("tags").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 16 }).notNull().default("proposed"),
    sourceProposalIds: json("source_proposal_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    decidedByUserId: varchar("decided_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    decidedAt: timestamp("decided_at"),
  },
  (t) => ({
    statusIdx: index("idx_ai_learned_corrections_status").on(t.status),
  }),
);

export type AiLearnedCorrection = typeof aiLearnedCorrections.$inferSelect;
export type NewAiLearnedCorrection = typeof aiLearnedCorrections.$inferInsert;
