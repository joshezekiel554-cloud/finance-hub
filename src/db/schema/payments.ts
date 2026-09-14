import {
  date,
  decimal,
  index,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";

// Per-row QBO payments. Until 2026-09-14 payments only existed as
// `qbo_payment` activities (amount + date, no book). The dashboard's
// "received in the last 30 days" must split Feldart / Torah Judaica, which
// needs each payment attributed to the invoices it paid down — see
// integrations/qb/payment-allocation.ts. Amounts are decimal strings like
// every other money column.
export const payments = mysqlTable(
  "payments",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    qbPaymentId: varchar("qb_payment_id", { length: 64 }).notNull().unique(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    docNumber: varchar("doc_number", { length: 64 }),
    txnDate: date("txn_date"),
    total: decimal("total", { precision: 12, scale: 2 }).notNull().default("0"),
    // Split of `total` by the book of the invoices this payment was applied
    // to. unallocated = unapplied credit + lines linked to unknown txns.
    feldartAmount: decimal("feldart_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    tjAmount: decimal("tj_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    unallocatedAmount: decimal("unallocated_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    paymentMethod: varchar("payment_method", { length: 64 }),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_payments_customer_id").on(t.customerId),
    txnDateIdx: index("idx_payments_txn_date").on(t.txnDate),
  }),
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
