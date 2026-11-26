// "Promised to pay by …" → link to the email the promise came from. PURE.
//
// The ONLY place the hub inbox deep-link format lives (it may change once
// the inbox agent confirms the route): change promiseEmailUrl() and nothing
// else. Opened with target="_top" (Hold Orders runs framed inside the hub).

function toYmd(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
  const s = v.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export const HUB_INBOX_URL = "https://hub.feldart.com/inbox";

/** Hub inbox deep link for a Gmail thread. */
export function promiseEmailUrl(gmailThreadId: string): string {
  return `${HUB_INBOX_URL}?p=${encodeURIComponent(`/inbox/by-gmail/${gmailThreadId}`)}`;
}

export type PromiseScanCandidate = {
  activityId: string;
  emailAt: Date | string;
  promisedDate: string | Date | null;
  // activities.meta (email_in rows carry threadId + gmailMessageId).
  meta: Record<string, unknown> | null;
};

export function threadIdFromMeta(meta: Record<string, unknown> | null | undefined): string | null {
  const t = meta?.threadId;
  return typeof t === "string" && t.trim() !== "" ? t.trim() : null;
}

function ms(d: Date | string): number {
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * The scan the customer's promise came from: the newest result='promise'
 * scan whose promised date equals customers.promised_pay_by. Callers pass
 * only that customer's result='promise' scans. No scan with that date (e.g. a
 * promise typed by hand in the hub, or a different date than any email
 * said) → null → no link; we never guess with an older email. A matching
 * scan without a Gmail thread id → no link either.
 */
export function pickPromiseSource(
  scans: readonly PromiseScanCandidate[],
  payBy: string | null,
): { activityId: string; threadId: string; url: string } | null {
  const want = toYmd(payBy);
  if (!want || scans.length === 0) return null;
  const newestFirst = [...scans].sort((a, b) => ms(b.emailAt) - ms(a.emailAt));
  const chosen = newestFirst.find((s) => toYmd(s.promisedDate) === want);
  if (!chosen) return null;
  const threadId = threadIdFromMeta(chosen.meta);
  if (!threadId) return null;
  return { activityId: chosen.activityId, threadId, url: promiseEmailUrl(threadId) };
}
