import {
  boolean,
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
    // Per-channel recipients. These are the source of truth for who
    // gets emailed when finance-hub sends an invoice or statement —
    // QBO's Customer entity has no CC/BCC slots, so the sending
    // happens client-side here (PATCH BillEmail/Cc/Bcc on the QBO
    // Invoice + POST /send for QBO-routed sends; or direct via
    // Gmail). primary_email / billing_emails remain only as legacy
    // display fields seeded from QBO. Tag rules in
    // email_routing_rules add to CC/BCC at send time on top of
    // these values.
    invoiceToEmails: json("invoice_to_emails").$type<string[]>(),
    invoiceCcEmails: json("invoice_cc_emails").$type<string[]>(),
    invoiceBccEmails: json("invoice_bcc_emails").$type<string[]>(),
    statementToEmails: json("statement_to_emails").$type<string[]>(),
    statementCcEmails: json("statement_cc_emails").$type<string[]>(),
    statementBccEmails: json("statement_bcc_emails").$type<string[]>(),
    // Free-form tag list. Drives email_routing_rules — e.g. tag
    // "yiddy" auto-BCCs sales@feldart.com on invoices that finance-hub
    // sends. (QBO-auto-sent invoices, e.g. via Shopify pipeline, fall
    // back to QBO's company-wide SalesEmailBcc preference because the
    // QBO Customer entity has no per-customer BCC field.) Lower-cased
    // + trimmed before persisting.
    tags: json("tags").$type<string[]>(),
    // Main phone — seeded from QBO Customer.PrimaryPhone.FreeFormNumber
    // on first INSERT, then locally authoritative (operator edits in
    // finance-hub push back to QBO; the 30-min sync no longer
    // overwrites). Free-form text; we render verbatim.
    phone: varchar("phone", { length: 64 }),
    // Extra labelled phones the operator wants to track alongside the
    // main line — bookkeeper, owner, AR clerk, etc. Local-only;
    // doesn't round-trip to QBO. Each entry is a small object, not a
    // separate table, because phones are leafy data with no need for
    // joins or per-row metadata beyond the label.
    additionalPhones: json("additional_phones").$type<
      Array<{ label: string; number: string }>
    >(),
    paymentTerms: varchar("payment_terms", { length: 64 }),
    // hold_status carries the customer's current account state. Despite
    // the historical name, it has three values:
    //   active           — normal B2B operation
    //   hold             — blocked from B2B (b2b tag absent in Shopify)
    //   payment_upfront  — must prepay each order (b2b-b2b-upfront tag
    //                      in Shopify); not on hold, but not on terms
    holdStatus: mysqlEnum("hold_status", [
      "active",
      "hold",
      "payment_upfront",
    ])
      .notNull()
      .default("active"),
    shopifyCustomerId: varchar("shopify_customer_id", { length: 64 }),
    mondayItemId: varchar("monday_item_id", { length: 64 }),
    // Billing address — synced from QBO Customer.BillAddr at sync time.
    // Surfaces on the customer detail page header and on the rendered
    // Statement PDF (where the customer's address appears under "TO").
    // Stored as columns rather than JSON so future queries can filter by
    // region / postal without JSON_EXTRACT gymnastics.
    billingAddressLine1: varchar("billing_address_line1", { length: 255 }),
    billingAddressLine2: varchar("billing_address_line2", { length: 255 }),
    billingAddressCity: varchar("billing_address_city", { length: 128 }),
    billingAddressRegion: varchar("billing_address_region", { length: 64 }),
    billingAddressPostal: varchar("billing_address_postal", { length: 32 }),
    billingAddressCountry: varchar("billing_address_country", { length: 64 }),
    // B2B vs B2C classification. NULL until manually tagged via the
    // customers list bulk-sweep UI; new customers from QB sync land NULL
    // and surface in a "needs classification" banner. Customer list
    // defaults to filtering on customer_type='b2b'.
    customerType: mysqlEnum("customer_type", ["b2b", "b2c"]),
    balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    overdueBalance: decimal("overdue_balance", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    unappliedCreditBalance: decimal("unapplied_credit_balance", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),
    internalNotes: text("internal_notes"),
    lastSyncedAt: timestamp("last_synced_at"),
    vocatechLastPushedAt: timestamp("vocatech_last_pushed_at"),
    // Autopilot opt-out: when TRUE, this customer is excluded from every
    // ai_proposal candidate query. Useful for VIPs the operator handles
    // manually or accounts where AI judgment shouldn't apply.
    agentModeExcluded: boolean("agent_mode_excluded").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    primaryEmailIdx: index("idx_customers_primary_email").on(t.primaryEmail),
    displayNameIdx: index("idx_customers_display_name").on(t.displayName),
    holdStatusIdx: index("idx_customers_hold_status").on(t.holdStatus),
    shopifyIdIdx: index("idx_customers_shopify_id").on(t.shopifyCustomerId),
    customerTypeIdx: index("idx_customers_customer_type").on(t.customerType),
    agentExcludedIdx: index("idx_customers_agent_excluded").on(
      t.agentModeExcluded,
    ),
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
