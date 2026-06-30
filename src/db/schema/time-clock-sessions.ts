import { index, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";
import { users } from "./auth";

// A manual clock-in / clock-out timesheet row (Time Clock feature, enabled for
// an app_settings allow-list — Hillel today). One row per clock-in; the matching
// clock-out stamps `clockOutAt`. At most one OPEN (clockOutAt IS NULL) session
// per user is enforced in app logic (clockIn refuses when one is open; clockOut
// closes it) — there is intentionally no DB-level unique-open constraint since
// MySQL can't express "unique where null".
//
// This is DECLARED timesheet time, kept entirely separate from the heartbeat-
// derived `user_active_minutes` active-time signal. A forgotten clock-out is
// never auto-closed: the open session stays open and is FLAGGED stale (open
// across a Europe/London midnight, or open longer than the stale window).
export const timeClockSessions = mysqlTable(
  "time_clock_sessions",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clockInAt: timestamp("clock_in_at").notNull(),
    clockOutAt: timestamp("clock_out_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    userClockInIdx: index("idx_time_clock_sessions_user_clock_in").on(
      t.userId,
      t.clockInAt,
    ),
  }),
);

export type TimeClockSession = typeof timeClockSessions.$inferSelect;
export type NewTimeClockSession = typeof timeClockSessions.$inferInsert;
