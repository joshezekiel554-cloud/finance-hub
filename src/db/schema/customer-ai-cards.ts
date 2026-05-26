import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  json,
  int,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";

// AI-generated summary + action plan for a single customer. One row per
// customer. Stale (>24h) rows are still returned to the client; the
// frontend shows the timestamp and a Regenerate button. Cache hit avoids
// the Anthropic call entirely.
export const customerAiCards = mysqlTable("customer_ai_cards", {
  customerId: varchar("customer_id", { length: 24 })
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  actions: json("actions").$type<CardAction[]>().notNull(),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  modelUsed: varchar("model_used", { length: 64 }),
  tokensIn: int("tokens_in"),
  tokensOut: int("tokens_out"),
});

export type CustomerAiCard = typeof customerAiCards.$inferSelect;
export type NewCustomerAiCard = typeof customerAiCards.$inferInsert;

export type CardActionKind =
  | "send_chase_email"
  | "send_statement"
  | "send_check_in_email"
  | "view_rma"
  | "view_cron_failure";

export type CardAction = {
  kind: CardActionKind;
  label: string;
  args: Record<string, unknown>;
};
