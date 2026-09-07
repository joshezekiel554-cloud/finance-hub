// Bucketing for the Email review section: takes the raw candidate rows the
// route's SELECT returns and splits them into the three lists the UI renders,
// converting DB values to the wire shape on the way.
//
// Separate from select.ts on purpose: select.ts answers "does this row
// qualify, and as what", this answers "which list does it show up in, and
// what does the client see". Both are pure so the route stays a query plus a
// call, and neither needs a DB or a Fastify harness to test.

import type { EmailReviewDismissReason } from "../../db/schema/invoice-email-dismissals.js";
import {
  classifyForEmailReview,
  isDismissalActive,
  type EmailReviewBucket,
} from "./select.js";

// Exactly what the route's SELECT projects. JSON columns arrive as `unknown`
// because the driver does not validate them.
export type EmailReviewSourceRow = {
  invoiceId: string;
  qbInvoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  origin: "feldart" | "tj";
  // Plain YYYY-MM-DD (DATE_FORMAT in the query) — see select.ts on why.
  issueDate: string | null;
  createdAt: string | Date;
  total: string;
  balance: string;
  status: string | null;
  emailStatus: string | null;
  deliveryTime: string | Date | null;
  deliveryError: string | null;
  invoiceToEmails: unknown;
  invoiceCcEmails: unknown;
  dismissReason: EmailReviewDismissReason | null;
  dismissNote: string | null;
  dismissedAt: string | Date | null;
  dismissedBy: string | null;
};

export type EmailReviewRow = {
  invoiceId: string;
  qbInvoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  origin: "feldart" | "tj";
  issueDate: string | null;
  createdAt: string;
  total: string;
  balance: string;
  status: string | null;
  emailStatus: string | null;
  deliveryTime: string | null;
  deliveryError: string | null;
  recipients: { to: string[]; cc: string[] };
  dismissal: {
    reason: EmailReviewDismissReason;
    reasonNote: string | null;
    dismissedAt: string;
    dismissedBy: string | null;
  } | null;
};

export type EmailReviewResponse = {
  neverEmailed: EmailReviewRow[];
  deliveryFailed: EmailReviewRow[];
  dismissed: EmailReviewRow[];
  syncedAt: string | null;
};

export type EmailReviewBuckets = Pick<
  EmailReviewResponse,
  "neverEmailed" | "deliveryFailed" | "dismissed"
>;

export function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function bucketEmailReviewRows(
  rows: EmailReviewSourceRow[],
  now: Date,
): EmailReviewBuckets {
  const out: EmailReviewBuckets = {
    neverEmailed: [],
    deliveryFailed: [],
    dismissed: [],
  };

  for (const r of rows) {
    // A dismissal only hides the row while it is newer than QBO's last
    // delivery attempt (isDismissalActive). Stale dismissals fall through to
    // the live buckets but keep their `dismissal` info for display.
    const dismissed =
      r.dismissReason !== null &&
      isDismissalActive(r.dismissedAt, r.deliveryTime, r.deliveryError);
    // Classify as if not dismissed so actively-dismissed rows that would
    // otherwise qualify land in the Dismissed tab (restore path); rows that no
    // longer qualify at all are dropped regardless of dismissal.
    const bucket: EmailReviewBucket | null = classifyForEmailReview(
      {
        emailStatus: r.emailStatus,
        deliveryError: r.deliveryError,
        status: r.status,
        total: r.total,
        balance: r.balance,
        issueDate: r.issueDate,
        createdAt: r.createdAt,
        dismissedAt: null,
        deliveryTime: r.deliveryTime,
      },
      now,
    );
    if (!bucket) continue;

    const row: EmailReviewRow = {
      invoiceId: r.invoiceId,
      qbInvoiceId: r.qbInvoiceId,
      docNumber: r.docNumber,
      customerId: r.customerId,
      customerName: r.customerName,
      origin: r.origin,
      issueDate: r.issueDate,
      createdAt: iso(r.createdAt) ?? now.toISOString(),
      total: r.total,
      balance: r.balance,
      status: r.status,
      emailStatus: r.emailStatus,
      deliveryTime: iso(r.deliveryTime),
      deliveryError: r.deliveryError,
      recipients: {
        to: strings(r.invoiceToEmails),
        cc: strings(r.invoiceCcEmails),
      },
      dismissal:
        r.dismissReason && r.dismissedAt
          ? {
              reason: r.dismissReason,
              reasonNote: r.dismissNote,
              dismissedAt: iso(r.dismissedAt) ?? now.toISOString(),
              dismissedBy: r.dismissedBy,
            }
          : null,
    };

    if (dismissed) out.dismissed.push(row);
    else if (bucket === "never_emailed") out.neverEmailed.push(row);
    else out.deliveryFailed.push(row);
  }

  return out;
}
