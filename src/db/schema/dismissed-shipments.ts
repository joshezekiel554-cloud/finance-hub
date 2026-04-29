import {
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

// Per-Gmail-message dismissal record. When a row exists for a given
// gmail_id, the /api/invoicing/today route hides that shipment from the
// active view. Used for non-Feldart-customer shipments (Etsy, Faire, B2C
// paid upfront) that shouldn't trigger a QB invoice update flow.
//
// gmail_id is the primary key — Google's IDs are stable per-account, so
// once dismissed a shipment stays dismissed across page reloads forever
// (or until the user explicitly restores it).
export const dismissedShipments = mysqlTable(
  "dismissed_shipments",
  {
    gmailId: varchar("gmail_id", { length: 64 }).primaryKey(),
    // Categorical reason. UI presents these three; "other" is paired with
    // a free-text reasonNote field for context.
    reason: mysqlEnum("reason", ["b2c_paid_upfront", "etsy_faire", "other"]).notNull(),
    reasonNote: text("reason_note"),
    dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
    // Optional FK to users — when auth is fully wired, populate this. For
    // now everyone shows up as null since we're not gating /invoicing
    // behind requireAuth yet.
    dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }),
  },
  (t) => ({
    dismissedAtIdx: index("idx_dismissed_shipments_dismissed_at").on(
      t.dismissedAt,
    ),
  }),
);

export type DismissedShipment = typeof dismissedShipments.$inferSelect;
export type NewDismissedShipment = typeof dismissedShipments.$inferInsert;
export const DISMISS_REASONS = [
  "b2c_paid_upfront",
  "etsy_faire",
  "other",
] as const satisfies ReadonlyArray<DismissedShipment["reason"]>;
