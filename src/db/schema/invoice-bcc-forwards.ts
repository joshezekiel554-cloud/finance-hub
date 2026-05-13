import { mysqlTable, mysqlEnum, varchar, timestamp, uniqueIndex } from "drizzle-orm/mysql-core";

// Tracking table for BCC-forward emails sent by finance-hub as a
// workaround for QBO's broken per-invoice BillEmailBcc field. One row
// per (doc, target_email) — the unique index prevents double-sends if
// the post-send hook fires twice or the manual catch-up endpoint
// retries.
export const invoiceBccForwards = mysqlTable(
  "invoice_bcc_forwards",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    docType: mysqlEnum("doc_type", ["invoice", "salesreceipt"]).notNull(),
    docId: varchar("doc_id", { length: 64 }).notNull(),
    customerId: varchar("customer_id", { length: 24 }).notNull(),
    targetEmail: varchar("target_email", { length: 255 }).notNull(),
    forwardedAt: timestamp("forwarded_at").defaultNow().notNull(),
    gmailMessageId: varchar("gmail_message_id", { length: 128 }),
  },
  (t) => ({
    uniqDocTarget: uniqueIndex("uniq_invoice_bcc_forwards_doc_target").on(
      t.docType,
      t.docId,
      t.targetEmail,
    ),
  }),
);

export type InvoiceBccForward = typeof invoiceBccForwards.$inferSelect;
