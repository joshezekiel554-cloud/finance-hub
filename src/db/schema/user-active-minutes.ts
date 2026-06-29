import { index, int, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";
import { users } from "./auth";

// Heartbeat → active-time source. One row per distinct UTC epoch-minute a
// user was demonstrably active (tab visible + recent input). Set semantics:
// the (userId, minuteUtc) PK makes every heartbeat insert idempotent, so a
// minute is counted once no matter how many pings land inside it.
//
// `minuteUtc` = floor(unixSeconds / 60). Active minutes for a range are the
// distinct minuteUtc ints in [from, to); the Team Activity report unions this
// set with the inbox's equivalent set (deduping minutes a user was active in
// both apps) to compute combined active time. Forward-only — no backfill.
export const userActiveMinutes = mysqlTable(
  "user_active_minutes",
  {
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    minuteUtc: int("minute_utc").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.minuteUtc] }),
    userMinuteIdx: index("idx_user_active_minutes_user_minute").on(
      t.userId,
      t.minuteUtc,
    ),
  }),
);

export type UserActiveMinute = typeof userActiveMinutes.$inferSelect;
export type NewUserActiveMinute = typeof userActiveMinutes.$inferInsert;
