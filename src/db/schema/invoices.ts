import {
  date,
  decimal,
  float,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  tinyint,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { orders } from "./catalog";
import { users } from "./auth";

export const invoices = mysqlTable(
  "invoices",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    qbInvoiceId: varchar("qb_invoice_id", { length: 64 }).notNull().unique(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    docNumber: varchar("doc_number", { length: 64 }),
    issueDate: date("issue_date"),
    dueDate: date("due_date"),
    total: decimal("total", { precision: 12, scale: 2 }).notNull().default("0"),
    balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    status: mysqlEnum("status", [
      "draft",
      "sent",
      "partial",
      "paid",
      "void",
      "overdue",
    ]),
    // Invoice origin: 'feldart' (docNumber begins 1 — we supplied it, simple to
    // chase) vs 'tj' (Torah Judaica legacy hand-over, docNumber begins 2 — a
    // wind-down book with its own softer chase track + dispute loop). Seeded
    // from the docNumber prefix on sync; never overwritten once an operator
    // sets it manually (origin_source='manual') or it's flagged needs_review.
    origin: mysqlEnum("origin", ["feldart", "tj"]).notNull().default("feldart"),
    originSource: mysqlEnum("origin_source", [
      "prefix",
      "manual",
      "needs_review",
    ])
      .notNull()
      .default("prefix"),
    // TJ dispute lifecycle (local-only; never round-trips to QBO except the
    // eventual void). 'verifying' parks the invoice out of the active TJ chase
    // while we check the claim with the TJ bookkeeper; 'confirmed_unpaid'
    // resumes chasing; 'confirmed_paid' is set after the hub voids it in QBO.
    disputeState: mysqlEnum("dispute_state", [
      "verifying",
      "confirmed_paid",
      "confirmed_unpaid",
    ]),
    disputeClaimedAt: timestamp("dispute_claimed_at"),
    disputeNote: text("dispute_note"),
    disputeUpdatedBy: varchar("dispute_updated_by", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    // Gmail threadId of the dispute's bookkeeper thread. Recorded when the
    // operator sends a bookkeeper email from the dispute flow, so the AI
    // dispute-nudge can detect a thread gone silent (latest email_log row on
    // this thread older than 7 days) vs. an invoice still awaiting its first
    // bookkeeper email.
    bookkeeperThreadId: varchar("bookkeeper_thread_id", { length: 128 }),
    sentAt: timestamp("sent_at"),
    sentVia: varchar("sent_via", { length: 32 }),
    // QBO Invoice.CustomerMemo.value — the customer-facing memo
    // printed on the invoice + statement. Synced from QBO every 30
    // min. Surfaced as a read-only column on the customer profile's
    // Invoices tab so the operator can see what the customer sees.
    customerMemo: text("customer_memo"),
    syncToken: varchar("sync_token", { length: 32 }),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_invoices_customer_id").on(t.customerId),
    dueDateIdx: index("idx_invoices_due_date").on(t.dueDate),
    statusIdx: index("idx_invoices_status").on(t.status),
    docNumberIdx: index("idx_invoices_doc_number").on(t.docNumber),
    originIdx: index("idx_invoices_origin").on(t.origin),
    originBalanceIdx: index("idx_invoices_origin_balance").on(
      t.origin,
      t.balance,
    ),
    disputeStateIdx: index("idx_invoices_dispute_state").on(t.disputeState),
  }),
);

export const invoiceLines = mysqlTable(
  "invoice_lines",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    invoiceId: varchar("invoice_id", { length: 24 })
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 64 }),
    description: text("description"),
    qty: decimal("qty", { precision: 12, scale: 4 }),
    unitPrice: decimal("unit_price", { precision: 12, scale: 4 }),
    lineTotal: decimal("line_total", { precision: 12, scale: 2 }),
    matchedOrderId: varchar("matched_order_id", { length: 24 }).references(
      () => orders.id,
      { onDelete: "set null" },
    ),
    position: int("position"),
  },
  (t) => ({
    invoiceIdIdx: index("idx_invoice_lines_invoice_id").on(t.invoiceId),
    matchedOrderIdx: index("idx_invoice_lines_matched_order_id").on(t.matchedOrderId),
  }),
);

export type ShipmentLineItem = {
  sku: string;
  description?: string;
  qty: number;
  unitPrice?: string;
};

export const shipments = mysqlTable(
  "shipments",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    sourceEmailId: varchar("source_email_id", { length: 255 }),
    parsedAt: timestamp("parsed_at"),
    customerMatchId: varchar("customer_match_id", { length: 24 }).references(
      () => customers.id,
      { onDelete: "set null" },
    ),
    lineItems: json("line_items").$type<ShipmentLineItem[]>(),
    rawEmail: text("raw_email"),
    parseConfidence: float("parse_confidence"),
    trackingNumber: varchar("tracking_number", { length: 128 }),
    shipVia: varchar("ship_via", { length: 64 }),
    shipDate: date("ship_date"),
    status: mysqlEnum("status", [
      "parsed",
      "matched",
      "reconciled",
      "invoiced",
      "ignored",
      "needs_review",
    ])
      .notNull()
      .default("parsed"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerMatchIdx: index("idx_shipments_customer_match_id").on(t.customerMatchId),
    statusIdx: index("idx_shipments_status").on(t.status),
    parsedAtIdx: index("idx_shipments_parsed_at").on(t.parsedAt),
    sourceEmailIdx: index("idx_shipments_source_email_id").on(t.sourceEmailId),
  }),
);

// One row per (invoice × chase email send). Written from the chase
// route after a successful Gmail send — INSERT one row per invoice
// in scope (subset if operator selected, otherwise all open at the
// time of send). Drives the "Last chased" column on the customer
// detail Invoices tab so the operator can target the next chase at
// invoices that haven't been chased recently.
//
// History is preserved (one row per send) so the timeline can show
// "chased L1 on Apr 15, L2 on Apr 22" if useful in future. The
// composite index supports the MAX(sent_at)-per-invoice subquery
// the invoices route uses to compute "last chased".
//
// Local-only — never round-trips to QBO. Cascades on invoice delete
// because the chase ceases to be meaningful without the invoice it
// referred to.
export const invoiceChases = mysqlTable(
  "invoice_chases",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    invoiceId: varchar("invoice_id", { length: 24 })
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    // 1 | 2 | 3 — same dunning levels used by chase_l1/l2/l3 templates.
    // tinyint mirrors the cardinality without burning a varchar.
    level: tinyint("level").notNull(),
    sentAt: timestamp("sent_at").defaultNow().notNull(),
    // Nullable because a future system-driven chase (e.g. AI agent in
    // week 9) may have no human user to attribute. Operator-driven
    // chases populate this from the auth session.
    sentByUserId: varchar("sent_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    // Gmail message id from the send. Useful for cross-linking to
    // the email_log row. Nullable in case the send response shape
    // changes.
    emailMessageId: varchar("email_message_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // Composite covers the "MAX(sent_at) per invoice_id" hot path
    // used by the customer-detail Invoices tab. desc on sent_at so
    // the latest chase comes first without an extra sort step.
    invoiceSentAtIdx: index("idx_invoice_chases_invoice_sent_at").on(
      t.invoiceId,
      t.sentAt,
    ),
  }),
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;
export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
export type InvoiceChase = typeof invoiceChases.$inferSelect;
export type NewInvoiceChase = typeof invoiceChases.$inferInsert;
