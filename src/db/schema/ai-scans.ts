import {
  index,
  int,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const aiScans = mysqlTable(
  "ai_scans",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    trigger: varchar("trigger", { length: 16 }).notNull(),
    triggeredByUserId: varchar("triggered_by_user_id", {
      length: 255,
    }).references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    totalCandidates: int("total_candidates").notNull().default(0),
    proposalsGenerated: int("proposals_generated").notNull().default(0),
    costCents: int("cost_cents").notNull().default(0),
    error: text("error"),
  },
  (t) => ({
    startedIdx: index("idx_ai_scans_started").on(t.startedAt),
  }),
);

export type AiScan = typeof aiScans.$inferSelect;
export type NewAiScan = typeof aiScans.$inferInsert;
