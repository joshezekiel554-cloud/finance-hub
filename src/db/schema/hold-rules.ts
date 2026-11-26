import {
  boolean,
  decimal,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { users } from "./auth";

// Per-customer automatic hold rule (Hold Orders app). A row exists ONLY for
// customers someone explicitly set a rule on. Customers without a row keep
// the standard hold behaviour — unless an admin switches on the default b2b
// rule in Hold Orders → Settings (ships off; see
// src/modules/hold-orders/effective-rules.ts). A row always beats the
// default, including "never". For preset rows the stored numbers are a
// snapshot; evaluation uses the live preset numbers from Settings. Rules are
// OVERDUE-based since migration 0063 (days past each invoice's due date);
// terms are not stored here — they're the customer's payment_terms. Semantics
// of the numbers: src/modules/hold-orders/presets.ts. Every change is
// audit-logged (entity "customer_hold_rule").
export const customerHoldRules = mysqlTable(
  "customer_hold_rules",
  {
    customerId: varchar("customer_id", { length: 24 })
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    preset: mysqlEnum("preset", ["strict", "standard", "relaxed", "never", "custom"]).notNull(),
    // Hold when an open invoice is MORE than this many days past its due date.
    graceDays: int("grace_days").notNull().default(15),
    // ...and the customer's overdue balance is at least this much.
    minOverdue: decimal("min_overdue", { precision: 12, scale: 2 }).notNull().default("50"),
    autoStartLadder: boolean("auto_start_ladder").notNull().default(false),
    autoReleaseOnPayment: boolean("auto_release_on_payment").notNull().default(true),
    notifyWarehouse: boolean("notify_warehouse").notNull().default(true),
    note: varchar("note", { length: 500 }),
    setByUserId: varchar("set_by_user_id", { length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    setAt: timestamp("set_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    presetIdx: index("idx_customer_hold_rules_preset").on(t.preset),
  }),
);

export type CustomerHoldRule = typeof customerHoldRules.$inferSelect;
export type NewCustomerHoldRule = typeof customerHoldRules.$inferInsert;
