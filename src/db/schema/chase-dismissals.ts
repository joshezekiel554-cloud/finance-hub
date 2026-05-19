import { mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { users } from "./auth";

export const chaseDismissals = mysqlTable("chase_dismissals", {
  customerId: varchar("customer_id", { length: 24 })
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
  dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }).references(
    () => users.id,
    { onDelete: "set null" },
  ),
});

export type ChaseDismissal = typeof chaseDismissals.$inferSelect;
export type NewChaseDismissal = typeof chaseDismissals.$inferInsert;
