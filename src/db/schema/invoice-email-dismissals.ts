import {
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { invoices } from "./invoices";
import { users } from "./auth";

// Operator dismissal of an invoice from the Email review section on
// Invoicing Today ("never emailed" / "delivery failed"). Keyed by the hub
// invoice id so the QB sync — which owns invoices.email_status /
// delivery_* — never touches it. A dismissed invoice that QBO later marks
// EmailSent leaves the never-emailed set on its own; the row here just
// stops it re-appearing while it is still NotSet.
export const EMAIL_REVIEW_DISMISS_REASONS = [
  "sent_elsewhere",
  "no_invoice_needed",
  "other",
] as const;
export type EmailReviewDismissReason =
  (typeof EMAIL_REVIEW_DISMISS_REASONS)[number];

export const invoiceEmailDismissals = mysqlTable(
  "invoice_email_dismissals",
  {
    invoiceId: varchar("invoice_id", { length: 24 })
      .primaryKey()
      .references(() => invoices.id, { onDelete: "cascade" }),
    reason: mysqlEnum("reason", EMAIL_REVIEW_DISMISS_REASONS).notNull(),
    // Required by the route when reason === "other".
    reasonNote: text("reason_note"),
    dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
    dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
  },
  (t) => ({
    dismissedAtIdx: index("idx_invoice_email_dismissals_dismissed_at").on(
      t.dismissedAt,
    ),
  }),
);

export type InvoiceEmailDismissal = typeof invoiceEmailDismissals.$inferSelect;
export type NewInvoiceEmailDismissal = typeof invoiceEmailDismissals.$inferInsert;
