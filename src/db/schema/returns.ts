import {
  boolean,
  date,
  decimal,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { users } from "./auth";

export const RMA_STATUSES = [
  "draft",
  "approved",
  "awaiting_warehouse_number",
  "sent_to_warehouse",
  "received",
  "completed",
  "denied",
  "cancelled",
] as const;
export type RmaStatus = (typeof RMA_STATUSES)[number];

export const RMA_RETURN_TYPES = ["damage", "seasonal", "non_seasonal"] as const;
export type RmaReturnType = (typeof RMA_RETURN_TYPES)[number];

export const RMA_RESOLUTION_TYPES = ["credit", "replacement"] as const;
export type RmaResolutionType = (typeof RMA_RESOLUTION_TYPES)[number];

export const rmas = mysqlTable(
  "rmas",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    rmaNumber: varchar("rma_number", { length: 64 }).unique(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id),
    qbCustomerId: varchar("qb_customer_id", { length: 64 }),
    returnType: mysqlEnum("return_type", RMA_RETURN_TYPES).notNull(),
    status: mysqlEnum("status", RMA_STATUSES).notNull().default("draft"),
    seasonId: varchar("season_id", { length: 24 }),
    totalValue: decimal("total_value", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    eligibleAmount: decimal("eligible_amount", { precision: 12, scale: 2 }),
    returnPercentage: decimal("return_percentage", { precision: 6, scale: 2 }),
    eligibilityDetails: json("eligibility_details"),
    thresholdOverridden: boolean("threshold_overridden").notNull().default(false),
    overrideReason: text("override_reason"),
    overrideByUserId: varchar("override_by_user_id", { length: 255 }).references(
      () => users.id,
    ),
    denialReason: text("denial_reason"),
    denialPdfDriveId: varchar("denial_pdf_drive_id", { length: 255 }),
    qboCreditMemoId: varchar("qbo_credit_memo_id", { length: 64 }),
    creditMemoDocNumber: varchar("credit_memo_doc_number", { length: 64 }),
    shippingDeductionAmount: decimal("shipping_deduction_amount", {
      precision: 12,
      scale: 2,
    }),
    restockingFeeAmount: decimal("restocking_fee_amount", {
      precision: 12,
      scale: 2,
    }),
    extensivRef: varchar("extensiv_ref", { length: 255 }),
    extensivTxNumber: varchar("extensiv_tx_number", { length: 64 }),
    extensivExportGeneratedAt: timestamp("extensiv_export_generated_at"),
    createdViaReceipt: boolean("created_via_receipt").notNull().default(false),
    originalEmail: text("original_email"),
    parsedConfidence: decimal("parsed_confidence", { precision: 3, scale: 2 }),
    notes: text("notes"),
    resolutionType: mysqlEnum("resolution_type", RMA_RESOLUTION_TYPES),
    createdByUserId: varchar("created_by_user_id", { length: 255 })
      .notNull()
      .references(() => users.id),
    approvedByUserId: varchar("approved_by_user_id", { length: 255 }).references(
      () => users.id,
    ),
    approvedAt: timestamp("approved_at"),
    sentToWarehouseAt: timestamp("sent_to_warehouse_at"),
    receivedAtWarehouseAt: timestamp("received_at_warehouse_at"),
    completedAt: timestamp("completed_at"),
    deniedAt: timestamp("denied_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdx: index("idx_rmas_customer").on(t.customerId),
    statusIdx: index("idx_rmas_status").on(t.status),
    typeCreatedIdx: index("idx_rmas_type_created").on(t.returnType, t.createdAt),
    extensivRefIdx: index("idx_rmas_extensiv_ref").on(t.extensivRef),
    rmaNumberIdx: index("idx_rmas_rma_number").on(t.rmaNumber),
  }),
);

export type Rma = typeof rmas.$inferSelect;
export type NewRma = typeof rmas.$inferInsert;
