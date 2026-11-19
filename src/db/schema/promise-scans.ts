import {
  date,
  index,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { customers } from "./customers";

// One row per inbound customer email (activities kind=email_in) the promise
// extractor has read — so each email is analysed exactly once. A row with a
// promised_date is a "promise-suggested" candidate for the hub's Chief of
// Staff panel (modules/promises/promise-extractor.ts). Kept in its own table
// rather than activities.meta so the timeline rows (and their audit trail)
// are never rewritten.
export const PROMISE_SCAN_RESULTS = ["promise", "none", "invalid"] as const;

export const promiseScans = mysqlTable(
  "promise_scans",
  {
    // activities.id of the email_in row. No FK: the scan record is a cache
    // and must not block activity deletes.
    activityId: varchar("activity_id", { length: 24 }).primaryKey(),
    customerId: varchar("customer_id", { length: 24 })
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    // Gmail message id when the activity carries one (signal key suffix).
    messageId: varchar("message_id", { length: 128 }),
    emailAt: timestamp("email_at").notNull(),
    result: mysqlEnum("result", PROMISE_SCAN_RESULTS).notNull(),
    promisedDate: date("promised_date", { mode: "string" }),
    quote: varchar("quote", { length: 200 }),
    model: varchar("model", { length: 64 }),
    scannedAt: timestamp("scanned_at").defaultNow().notNull(),
  },
  (t) => ({
    customerIdx: index("idx_promise_scans_customer").on(t.customerId),
    emailAtIdx: index("idx_promise_scans_email_at").on(t.emailAt),
  }),
);

export type PromiseScan = typeof promiseScans.$inferSelect;
export type NewPromiseScan = typeof promiseScans.$inferInsert;
