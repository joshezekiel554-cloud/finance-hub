import {
  date,
  decimal,
  index,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { invoices } from "./invoices";

// Per-row credit memos. Previously the sync only aggregated unapplied credit
// per customer into customers.unapplied_credit_balance — origin was invisible.
// This table stores each memo so per-origin balances can net TJ credit against
// TJ invoices (and Feldart against Feldart) without ever crossing books.
//
// origin_source:
//   auto         — classified from DC####/returns-flow (feldart) or doc prefix
//   manual       — operator override (origin-review sweep); sync must not clobber
//   needs_review — prefix was ambiguous; surfaced in the one-time sweep UI
export const creditMemos = mysqlTable(
  "credit_memos",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    qbCreditMemoId: varchar("qb_credit_memo_id", { length: 64 })
      .notNull()
      .unique(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    docNumber: varchar("doc_number", { length: 64 }),
    total: decimal("total", { precision: 12, scale: 2 }).notNull().default("0"),
    // Unapplied balance — what actually reduces AR. Fully-applied memos sync to 0.
    balance: decimal("balance", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    origin: mysqlEnum("origin", ["feldart", "tj"]).notNull().default("feldart"),
    originSource: mysqlEnum("origin_source", ["auto", "manual", "needs_review"])
      .notNull()
      .default("auto"),
    // Set when QBO links the memo to a specific invoice (not populated in v1 —
    // the credit-memo fetch doesn't include LinkedTxn yet). Kept for forward use.
    appliedInvoiceId: varchar("applied_invoice_id", { length: 24 }).references(
      () => invoices.id,
      { onDelete: "set null" },
    ),
    txnDate: date("txn_date"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_credit_memos_customer_id").on(t.customerId),
    originIdx: index("idx_credit_memos_origin").on(t.origin),
  }),
);

export type CreditMemo = typeof creditMemos.$inferSelect;
export type NewCreditMemo = typeof creditMemos.$inferInsert;
