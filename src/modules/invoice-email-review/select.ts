// Single rule set for the Email review section on Invoicing Today.
//
// The route fetches a superset of candidates with SQL (issue-date window +
// "NotSet/NeedToSend or has delivery error") and runs every row through
// classifyForEmailReview so the SQL only has to be a cheap pre-filter and
// the exact contract lives here, unit-tested.
//
// Buckets:
//   never_emailed  — QBO says the invoice was never emailed and it is still
//                    open and old enough to have left today's normal queue.
//   delivery_failed — QBO accepted the send but later recorded a
//                    DeliveryErrorType (Bounced Email / Undeliverable).

export const EMAIL_REVIEW_WINDOW_DAYS = 90;
export const EMAIL_REVIEW_GRACE_HOURS = 24;

// QBO EmailStatus values that mean "not emailed".
export const NOT_EMAILED_STATUSES = ["NotSet", "NeedToSend"] as const;

export type EmailReviewBucket = "never_emailed" | "delivery_failed";

export type EmailReviewCandidate = {
  emailStatus: string | null;
  deliveryError: string | null;
  // invoices.status enum value (or null on very old rows).
  status: string | null;
  // decimal(12,2) strings as Drizzle returns them.
  total: string;
  balance: string;
  // invoices.issue_date — Drizzle may hand back a Date or a YYYY-MM-DD string.
  issueDate: string | Date | null;
  createdAt: string | Date;
  dismissed: boolean;
};

// YYYY-MM-DD in UTC for a Date, or the first 10 chars of a string.
function isoDay(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : v.slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function classifyForEmailReview(
  c: EmailReviewCandidate,
  now: Date = new Date(),
): EmailReviewBucket | null {
  if (c.dismissed) return null;
  if (c.status === "void") return null;
  if (!c.issueDate) return null;

  const today = isoDay(now);
  const issued = isoDay(c.issueDate);
  if (issued > today) return null; // placeholder / future-dated
  if (issued < addDays(today, -EMAIL_REVIEW_WINDOW_DAYS)) return null;

  if (c.deliveryError) return "delivery_failed";

  const notEmailed = (NOT_EMAILED_STATUSES as readonly string[]).includes(
    c.emailStatus ?? "",
  );
  if (!notEmailed) return null;
  if (Number(c.total) <= 0) return null;
  if (Number(c.balance) <= 0) return null;

  const createdMs = new Date(c.createdAt).getTime();
  if (now.getTime() - createdMs < EMAIL_REVIEW_GRACE_HOURS * 60 * 60 * 1000) {
    return null;
  }
  return "never_emailed";
}
