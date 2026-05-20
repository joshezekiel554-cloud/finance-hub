import {
  boolean,
  index,
  json,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

// Operator-curated facts about Feldart, injected into autopilot drafts.
// `tags` holds "global" (applies to every draft) and/or AiProposalCategory
// slugs (chase_next, cadence_cold, ops_rma_stalled) to scope a fact to a
// draft type. Never per-customer — per-customer knowledge lives on
// customers.ai_customer_context (#4).
export const aiCompanyFacts = mysqlTable(
  "ai_company_facts",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    fact: text("fact").notNull(),
    tags: json("tags").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdByUserId: varchar("created_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    activeIdx: index("idx_ai_company_facts_active").on(t.active),
  }),
);

export const FACT_TAG_GLOBAL = "global";

export type AiCompanyFact = typeof aiCompanyFacts.$inferSelect;
export type NewAiCompanyFact = typeof aiCompanyFacts.$inferInsert;
