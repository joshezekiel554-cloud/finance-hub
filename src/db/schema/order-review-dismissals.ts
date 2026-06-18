import { mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";
import { orders } from "./catalog";
import { users } from "./auth";

// An operator "Dismiss" on an overdue-balance row of the dashboard "Orders to
// review" widget. Permanent per-order hide (mirrors chase_dismissals): once a
// row is here, listFlaggedOverdueOrders filters it out for good. Hold rows are
// NOT dismissed this way — they resolve via good-to-send / cancel.
export const orderReviewDismissals = mysqlTable("order_review_dismissals", {
  orderId: varchar("order_id", { length: 24 })
    .primaryKey()
    .references(() => orders.id, { onDelete: "cascade" }),
  dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
  dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }).references(
    () => users.id,
    { onDelete: "set null" },
  ),
});

export type OrderReviewDismissal = typeof orderReviewDismissals.$inferSelect;
export type NewOrderReviewDismissal = typeof orderReviewDismissals.$inferInsert;
