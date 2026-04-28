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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    customerIdIdx: index("idx_orders_customer_id").on(t.customerId),
    orderDateIdx: index("idx_orders_order_date").on(t.orderDate),
    statusIdx: index("idx_orders_status").on(t.status),
  }),
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
