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
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { orders } from "./catalog";

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
    sentAt: timestamp("sent_at"),
    sentVia: varchar("sent_via", { length: 32 }),
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

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;
export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
