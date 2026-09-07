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
  // invoices.issue_date as a plain YYYY-MM-DD string. The route selects it
  // with DATE_FORMAT on purpose: mysql2 returns DATE columns as LOCAL-midnight
  // Date objects, so reading them back as a UTC day shifts by one on any host
  // ahead of UTC. A string keeps this module host-timezone independent.
  issueDate: string | null;
  createdAt: string | Date;
  // invoice_email_dismissals.dismissed_at (null = never dismissed) and
  // invoices.delivery_time (QBO's last delivery attempt). A dismissal only
  // counts while it is newer than the last attempt — see isDismissalActive.
  dismissedAt: string | Date | null;
  deliveryTime: string | Date | null;
};

// YYYY-MM-DD in UTC for `now`; strings are taken as already-formatted days.
function isoDay(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : v.slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function ms(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

// First issue day still inside the window (inclusive). Exported so the
// route's SQL pre-filter uses the SAME floor as the classifier — a
// CURDATE()-based floor evaluated in the MySQL server timezone could be a day
// narrower than this UTC-day computation and silently drop rows.
export function emailReviewWindowStart(now: Date = new Date()): string {
  return addDays(isoDay(now), -EMAIL_REVIEW_WINDOW_DAYS);
}

// A dismissal hides an invoice only until QBO records a NEWER delivery
// attempt. QBO moves DeliveryInfo.DeliveryTime on every send (observed in
// prod 2026-09-06: eight invoices re-sent from the QBO UI all carry the same
// new DeliveryTime), so "dismissed while NotSet, later sent and bounced" and
// "dismissed bounce, re-sent, bounced again" both re-surface — otherwise the
// invisible-bounce failure this feature exists to catch would survive it.
// A bounce with NO usable DeliveryTime (QBO omitted it, or the sync could not
// parse it) can't prove the dismissal came later, so it is never hidden.
export function isDismissalActive(
  dismissedAt: string | Date | null,
  deliveryTime: string | Date | null,
  deliveryError: string | null,
): boolean {
  if (!dismissedAt) return false;
  if (!deliveryTime) return !deliveryError;
  return ms(dismissedAt) > ms(deliveryTime);
}

export function classifyForEmailReview(
  c: EmailReviewCandidate,
  now: Date = new Date(),
): EmailReviewBucket | null {
  if (isDismissalActive(c.dismissedAt, c.deliveryTime, c.deliveryError)) return null;
  if (c.status === "void") return null;
  if (!c.issueDate) return null;

  const today = isoDay(now);
  const issued = isoDay(c.issueDate);
  // Both buckets: future-dated rows (the 2030-01-01 placeholders) and rows
  // older than the window are out, bounce or not.
  if (issued > today) return null;
  if (issued < emailReviewWindowStart(now)) return null;

  if (c.deliveryError) return "delivery_failed";

  const notEmailed = NOT_EMAILED_STATUSES.some((s) => s === c.emailStatus);
  if (!notEmailed) return null;
  // decimal(12,2) NOT NULL columns, so NaN means corrupt data — fail closed.
  const total = Number(c.total);
  const balance = Number(c.balance);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(balance) || balance <= 0) return null;

  // created_at is NOT NULL; an unparsable value is corrupt data — fail closed.
  const createdMs = ms(c.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  if (now.getTime() - createdMs < EMAIL_REVIEW_GRACE_HOURS * 60 * 60 * 1000) {
    return null;
  }
  return "never_emailed";
}
