import {
  decimal,
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

export const products = mysqlTable(
  "products",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    sku: varchar("sku", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    retailPriceGbp: decimal("retail_price_gbp", { precision: 12, scale: 2 }),
    b2bPriceGbp: decimal("b2b_price_gbp", { precision: 12, scale: 2 }),
    shopifyProductId: varchar("shopify_product_id", { length: 64 }),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    shopifyIdIdx: index("idx_products_shopify_id").on(t.shopifyProductId),
    nameIdx: index("idx_products_name").on(t.name),
  }),
);

export type OrderLineItem = {
  sku: string;
  name?: string;
  qty: number;
  unitPrice?: string;
  total?: string;
};

export const orders = mysqlTable(
  "orders",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    shopifyOrderId: varchar("shopify_order_id", { length: 64 }).notNull().unique(),
    customerId: varchar("customer_id", { length: 24 }).references(() => customers.id, {
      onDelete: "set null",
    }),
    orderNumber: varchar("order_number", { length: 64 }),
    orderDate: timestamp("order_date"),
    // The address the order was placed under — used to match the order to a
    // finance customer (and shown on the Orders tab).
    email: varchar("email", { length: 255 }),
    notesRaw: text("notes_raw"),
    lineItems: json("line_items").$type<OrderLineItem[]>(),
    total: decimal("total", { precision: 12, scale: 2 }),
    itemCount: int("item_count"),
    status: mysqlEnum("status", [
      "pending",
      "paid",
      "shipped",
      "fulfilled",
      "cancelled",
      "refunded",
    ]),
    // PAYMENT status — Shopify financial_status verbatim (pending, authorized,
    // paid, partially_paid, refunded, partially_refunded, voided). Drives the
    // payment-upfront-but-pending alert + the Orders tab payment column.
    financialStatus: varchar("financial_status", { length: 32 }),
    // FULFILMENT status — Shopify fulfillment_status (null=unfulfilled, partial,
    // fulfilled, restocked). Normalized null → "unfulfilled" on read.
    fulfillmentStatus: varchar("fulfillment_status", { length: 32 }),
    // Tracking, from the order's fulfilments (best-effort — only present once a
    // fulfilment with tracking exists).
    trackingNumber: varchar("tracking_number", { length: 128 }),
    trackingUrl: varchar("tracking_url", { length: 512 }),
    trackingCompany: varchar("tracking_company", { length: 128 }),
    // Carrier-reported shipment state (in_transit, out_for_delivery, delivered,
    // …) from the fulfilment, when the carrier reports it. "delivered" here is
    // what surfaces the Delivered state on the Orders tab.
    shipmentStatus: varchar("shipment_status", { length: 32 }),
    cancelledAt: timestamp("cancelled_at"),
    // Set the first time a hold / payment-upfront-unpaid alert email is sent for
    // this order, so the alert fires at-most-once even though the orders-sync
    // job re-evaluates recent orders every run. NULL = not yet alerted.
    holdAlertedAt: timestamp("hold_alerted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_orders_customer_id").on(t.customerId),
    orderDateIdx: index("idx_orders_order_date").on(t.orderDate),
    statusIdx: index("idx_orders_status").on(t.status),
    emailIdx: index("idx_orders_email").on(t.email),
  }),
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
