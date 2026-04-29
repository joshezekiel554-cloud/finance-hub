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

export const customers = mysqlTable(
  "customers",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    qbCustomerId: varchar("qb_customer_id", { length: 64 }).unique(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    primaryEmail: varchar("primary_email", { length: 255 }),
    billingEmails: json("billing_emails").$type<string[]>(),
    paymentTerms: varchar("payment_terms", { length: 64 }),
    holdStatus: mysqlEnum("hold_status", ["active", "hold"]).notNull().default("active"),
    shopifyCustomerId: varchar("shopify_customer_id", { length: 64 }),
    mondayItemId: varchar("monday_item_id", { length: 64 }),
    // B2B vs B2C classification. NULL until manually tagged via the
    // customers list bulk-sweep UI; new customers from QB sync land NULL
    // and surface in a "needs classification" banner. Customer list
    // defaults to filtering on customer_type='b2b'.
    customerType: mysqlEnum("customer_type", ["b2b", "b2c"]),
    balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    overdueBalance: decimal("overdue_balance", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    internalNotes: text("internal_notes"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    primaryEmailIdx: index("idx_customers_primary_email").on(t.primaryEmail),
    displayNameIdx: index("idx_customers_display_name").on(t.displayName),
    holdStatusIdx: index("idx_customers_hold_status").on(t.holdStatus),
    shopifyIdIdx: index("idx_customers_shopify_id").on(t.shopifyCustomerId),
    customerTypeIdx: index("idx_customers_customer_type").on(t.customerType),
  }),
);

export const customerContacts = mysqlTable(
  "customer_contacts",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }),
    email: varchar("email", { length: 255 }),
    role: varchar("role", { length: 64 }),
    phone: varchar("phone", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_customer_contacts_customer_id").on(t.customerId),
    emailIdx: index("idx_customer_contacts_email").on(t.email),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type CustomerContact = typeof customerContacts.$inferSelect;
export type NewCustomerContact = typeof customerContacts.$inferInsert;
