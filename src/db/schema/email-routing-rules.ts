// Tag-driven email routing rules.
//
// Each row says "if a customer carries `tag`, take `action` with `value`".
// Actions like `bcc_invoice` apply ONLY to invoices finance-hub sends
// itself — QBO's Customer entity has no per-customer BillEmailBcc/Cc
// field, so the rules can't propagate to QBO-auto-sent invoices (the
// Shopify pipeline). Those fall back to QBO's company-wide
// Preferences.SalesFormsPrefs.SalesEmailBcc. The action column is an
// enum so future rules (bcc_statement, cc_invoice, etc.) can be added
// without migrating each rule individually.
//
// Tag matching is case-insensitive (we normalise customers.tags to
// lowercase on write). Multiple rules can match the same tag —
// e.g. tag "yiddy" might bcc both sales@ and ops@; rules are unioned
// at render time.

import {
  index,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

export const ROUTING_RULE_ACTIONS = [
  "bcc_invoice",
  "bcc_statement",
  "cc_invoice",
  "cc_statement",
] as const;
export type RoutingRuleAction = (typeof ROUTING_RULE_ACTIONS)[number];

export const emailRoutingRules = mysqlTable(
  "email_routing_rules",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    tag: varchar("tag", { length: 64 }).notNull(),
    action: mysqlEnum("action", ROUTING_RULE_ACTIONS).notNull(),
    value: varchar("value", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    createdByUserId: varchar("created_by_user_id", { length: 255 }),
  },
  (t) => ({
    tagIdx: index("idx_email_routing_rules_tag").on(t.tag),
    // (tag, action, value) is the natural primary key — same tuple
    // twice is a no-op, blocked here so we don't accidentally double-
    // BCC an address.
    uniq: uniqueIndex("uq_email_routing_rules_tag_action_value").on(
      t.tag,
      t.action,
      t.value,
    ),
  }),
);

export type EmailRoutingRule = typeof emailRoutingRules.$inferSelect;
export type NewEmailRoutingRule = typeof emailRoutingRules.$inferInsert;
