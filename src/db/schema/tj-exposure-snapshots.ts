import { date, decimal, mysqlTable } from "drizzle-orm/mysql-core";

// Daily snapshots of total Torah Judaica net exposure (Σ per-customer net TJ
// owed, credits netted per-origin, floored at 0 — same figure the /chase TJ
// wind-down panel headlines). Self-populating: the wind-down endpoint upserts
// today's row on every read (no cron), giving the "vs ~1 month ago" delta its
// history. One row per UTC day; exposure is overwritten on repeat reads so the
// row always reflects the latest computation for that day.
export const tjExposureSnapshots = mysqlTable("tj_exposure_snapshots", {
  // mode: "string" — 'YYYY-MM-DD', avoids TZ day-rolls and makes the
  // ≤ today−28d cutoff a plain lexicographic compare.
  snapDate: date("snap_date", { mode: "string" }).primaryKey(),
  exposure: decimal("exposure", { precision: 12, scale: 2 }).notNull(),
});

export type TjExposureSnapshot = typeof tjExposureSnapshots.$inferSelect;
export type NewTjExposureSnapshot = typeof tjExposureSnapshots.$inferInsert;
