import type { BuiltPrompt, DraftContext } from "../voice.js";

export const TOOL_NAME = "create_admin_notification";

type CronFailSummary = {
  jobKind:
    | "qb_full"
    | "qb_incremental"
    | "gmail_poll"
    | "shopify_full"
    | "shopify_incremental"
    | "monday_mirror";
  lastFailureAt: string;
  lastErrorExcerpt: string;
};

const INVESTIGATION_HINTS: Record<CronFailSummary["jobKind"], string> = {
  qb_full: "Check QBO OAuth token — it may have expired or been revoked.",
  qb_incremental:
    "Check QBO OAuth token — it may have expired or been revoked.",
  gmail_poll: "Check Gmail OAuth token — it may have expired or been revoked.",
  shopify_full:
    "Check Shopify Admin API credentials and rate-limit headers in logs.",
  shopify_incremental:
    "Check Shopify Admin API credentials and rate-limit headers in logs.",
  monday_mirror:
    "Check Monday.com API token; this job is feature-flagged — confirm it is still enabled.",
};

const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /too many requests/i,
  /throttl/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
];

function isLikelyTransient(excerpt: string): boolean {
  return TRANSIENT_PATTERNS.some((re) => re.test(excerpt));
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
  const diffHrs = Math.round(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs !== 1 ? "s" : ""} ago`;
  const diffDays = Math.round(diffHrs / 24);
  return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
}

export function buildPrompt(
  summary: Record<string, unknown>,
  _context: DraftContext,
): BuiltPrompt {
  const s = summary as CronFailSummary;
  const hint = INVESTIGATION_HINTS[s.jobKind];
  const when = relativeTime(s.lastFailureAt);
  const transientNote = isLikelyTransient(s.lastErrorExcerpt)
    ? "\n\nNote: the error pattern looks potentially transient (rate limit / network reset). You MAY skip with reason if you believe it will self-resolve."
    : "";

  const user = `You are an ops assistant monitoring background cron jobs.

Job: ${s.jobKind}
Failed twice in a row. Last failure: ${when} (${s.lastFailureAt})
Error excerpt (first 500 chars):
---
${s.lastErrorExcerpt}
---
${transientNote}

Call the \`${TOOL_NAME}\` tool with:
  - title: "[Cron] ${s.jobKind} failed twice"
  - message: a 2-3 sentence summary covering which job failed, since when, the key part of the error, and this suggested next step: "${hint}"
  - severity: "warning"

Failed crons almost always warrant a notification. Only skip if the error is clearly transient and very likely to self-resolve on the next run.

If you decide to skip: respond with plain JSON only — no tool call:
  {"skip": true, "reason": "<one sentence>"}

Do not explain your reasoning outside of the skip reason. Act directly.`;

  return { system: "", user };
}
