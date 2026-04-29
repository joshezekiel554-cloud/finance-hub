// Editable email templates. Originally the plan said "templates kept in
// code, no CRUD UI" but the user wants to iterate on copy without a deploy
// cycle, so they're persisted here. Default templates are seeded on first
// boot via scripts/seed-email-templates.ts; the UI exposes CRUD over them.
//
// `slug` is a stable identifier code paths can reference (e.g.
// "statement_open_items" → the statement-send route). `name` is the
// human-readable label shown in template pickers. `body` accepts
// {{merge_variables}} resolved at render time by the template-vars module.

import {
  index,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const EMAIL_TEMPLATE_CONTEXTS = [
  "chase",
  "statement",
  "payment_confirmation",
  "generic",
  "reply",
] as const;
export type EmailTemplateContext = (typeof EMAIL_TEMPLATE_CONTEXTS)[number];

export const emailTemplates = mysqlTable(
  "email_templates",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    // URL-safe stable identifier; code references templates by slug, not id.
    // e.g. statement_open_items, chase_l1, chase_l2, payment_confirmation.
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    // Routes templates to the right picker context. The compose modal's
    // template dropdown filters on this so a chase email doesn't show a
    // payment-confirmation template by default.
    context: varchar("context", { length: 32 }).notNull(),
    subject: varchar("subject", { length: 512 }).notNull(),
    // Body supports {{merge_variables}} resolved at render time. HTML is
    // allowed for the statement template (need a table render); plain
    // text is also fine for shorter chase notes.
    body: text("body").notNull(),
    // Optional one-line description shown in the templates list.
    description: varchar("description", { length: 512 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    contextIdx: index("idx_email_templates_context").on(t.context),
    slugIdx: index("idx_email_templates_slug").on(t.slug),
  }),
);

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;
