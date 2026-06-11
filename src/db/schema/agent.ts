// AI agent conversation persistence (spec: 2026-06-11-ai-agent-design §6).
//
// Conversations are PER-USER (each operator has their own thread list);
// everything the agent learns/produces (memory, files, reports, proposals)
// is team-global and lives elsewhere. agent_files + agent_reports are
// created in the same migration as the conversation tables even though
// Waves B/C populate them — one migration for the whole Phase 1 schema.

import {
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";
import { customers } from "./customers";

export const agentConversations = mysqlTable(
  "agent_conversations",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    userId: varchar("user_id", { length: 255 })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    title: varchar("title", { length: 256 }).notNull(),
    // Rolling summary of older turns once the conversation outgrows the
    // context budget. Recent turns stay verbatim in agent_messages; the
    // loop prepends this block when assembling context.
    summary: text("summary"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    userIdx: index("idx_agent_conversations_user").on(
      t.userId,
      t.updatedAt,
    ),
  }),
);

// Message content is a json envelope rather than columns-per-shape:
// user messages carry { text, pageContext? }, assistant messages carry
// { text }, tool_event rows carry { tool, args-summary, ok, durationMs }
// so the UI can replay the chips. Proposal/file refs (Waves B/C) extend
// the same envelope without migrations.
export const AGENT_MESSAGE_ROLES = ["user", "assistant", "tool_event"] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

export const agentMessages = mysqlTable(
  "agent_messages",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 24 })
      .references(() => agentConversations.id, { onDelete: "cascade" })
      .notNull(),
    role: mysqlEnum("role", AGENT_MESSAGE_ROLES).notNull(),
    content: json("content").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    conversationIdx: index("idx_agent_messages_conversation").on(
      t.conversationId,
      t.createdAt,
    ),
  }),
);

// Uploaded files + email attachments the agent has read (Wave C).
// storagePath is relative to data/agent-files/ on the VPS (rsync-excluded
// from deploys, like the rest of data/).
export const agentFiles = mysqlTable(
  "agent_files",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 24 }).references(
      () => agentConversations.id,
      { onDelete: "set null" },
    ),
    uploaderUserId: varchar("uploader_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    filename: varchar("filename", { length: 512 }).notNull(),
    mime: varchar("mime", { length: 128 }).notNull(),
    sizeBytes: int("size_bytes").notNull(),
    storagePath: varchar("storage_path", { length: 1024 }).notNull(),
    // When the file came off an email rather than an upload.
    sourceEmailLogId: varchar("source_email_log_id", { length: 24 }),
    // Optional record links ("file this remittance under Brown & Co").
    customerId: varchar("customer_id", { length: 24 }).references(
      () => customers.id,
      { onDelete: "set null" },
    ),
    rmaId: varchar("rma_id", { length: 24 }),
    invoiceId: varchar("invoice_id", { length: 24 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    customerIdx: index("idx_agent_files_customer").on(t.customerId),
    conversationIdx: index("idx_agent_files_conversation").on(
      t.conversationId,
    ),
  }),
);

export const AGENT_REPORT_KINDS = ["pdf", "csv"] as const;
export type AgentReportKind = (typeof AGENT_REPORT_KINDS)[number];

// Generated reports library (Wave C): re-downloadable, attachable to email.
export const agentReports = mysqlTable(
  "agent_reports",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 24 }).references(
      () => agentConversations.id,
      { onDelete: "set null" },
    ),
    requestedByUserId: varchar("requested_by_user_id", {
      length: 255,
    }).references(() => users.id, { onDelete: "set null" }),
    title: varchar("title", { length: 256 }).notNull(),
    kind: mysqlEnum("kind", AGENT_REPORT_KINDS).notNull(),
    storagePath: varchar("storage_path", { length: 1024 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    createdIdx: index("idx_agent_reports_created").on(t.createdAt),
  }),
);

export type AgentConversation = typeof agentConversations.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type AgentFile = typeof agentFiles.$inferSelect;
export type AgentReport = typeof agentReports.$inferSelect;
