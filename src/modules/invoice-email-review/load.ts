// The Email review query, shared by GET /api/invoicing/email-review and the
// Feldart AI `invoice_email_issues` tool so both always show the same lists.
// The SQL is only a cheap superset pre-filter and MUST use the same window
// floor as the classifier; the rules live in select.ts / bucket.ts.

import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/auth.js";
import { customers } from "../../db/schema/customers.js";
import { invoiceEmailDismissals } from "../../db/schema/invoice-email-dismissals.js";
import { invoices } from "../../db/schema/invoices.js";
import { bucketEmailReviewRows, iso, type EmailReviewResponse } from "./bucket.js";
import { emailReviewWindowStart, NOT_EMAILED_STATUSES } from "./select.js";

export async function loadEmailReview(now: Date = new Date()): Promise<EmailReviewResponse> {
  // Same floor the classifier uses — never CURDATE(), which would be
  // evaluated in the MySQL server timezone.
  const windowStartDay = emailReviewWindowStart(now);

  const rows = await db
    .select({
      invoiceId: invoices.id,
      qbInvoiceId: invoices.qbInvoiceId,
      docNumber: invoices.docNumber,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      origin: invoices.origin,
      // DATE_FORMAT → plain 'YYYY-MM-DD'. mysql2 hands DATE columns back as
      // local-midnight Date objects, which would shift the day on a
      // non-UTC host; the classifier's contract is a string day.
      issueDate: sql<string | null>`DATE_FORMAT(${invoices.issueDate}, '%Y-%m-%d')`,
      createdAt: invoices.createdAt,
      total: invoices.total,
      balance: invoices.balance,
      status: invoices.status,
      emailStatus: invoices.emailStatus,
      deliveryTime: invoices.deliveryTime,
      deliveryError: invoices.deliveryError,
      invoiceToEmails: customers.invoiceToEmails,
      invoiceCcEmails: customers.invoiceCcEmails,
      dismissReason: invoiceEmailDismissals.reason,
      dismissNote: invoiceEmailDismissals.reasonNote,
      dismissedAt: invoiceEmailDismissals.dismissedAt,
      dismissedBy: users.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(invoiceEmailDismissals, eq(invoiceEmailDismissals.invoiceId, invoices.id))
    .leftJoin(users, eq(users.id, invoiceEmailDismissals.dismissedByUserId))
    .where(
      and(
        sql`${invoices.issueDate} >= ${windowStartDay}`,
        or(inArray(invoices.emailStatus, [...NOT_EMAILED_STATUSES]), isNotNull(invoices.deliveryError)),
      ),
    )
    .orderBy(asc(invoices.issueDate), desc(invoices.balance));

  const syncedRows = await db
    .select({ syncedAt: sql<string | Date | null>`MAX(${invoices.lastSyncedAt})` })
    .from(invoices);

  return { ...bucketEmailReviewRows(rows, now), syncedAt: iso(syncedRows[0]?.syncedAt ?? null) };
}
