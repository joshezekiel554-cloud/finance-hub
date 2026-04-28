// Chase digest job processor.
//
// Runs daily at 17:00 Europe/London. Builds the AI-generated chase digest,
// then emails it to env.CHASE_DIGEST_RECIPIENT via the Gmail send module.
//
// Shadow-mode short-circuit:
//   When env.SHADOW_MODE is true, we still build (or attempt to build) the
//   digest body for inspection in logs but DO NOT send any email. The
//   pattern:
//
//     if (env.SHADOW_MODE) {
//       log.info({ stage: "skipped", reason: "shadow_mode" }, "...");
//       return shadowResult;
//     }
//
//   This is the only outbound side-effect on the worker today, so it's the
//   first place the flag matters. When activity ingestion → QBO writes or
//   Shopify mutations land, they should follow the same shape.

import type { Job } from "bullmq";
import { sendEmail } from "../../integrations/gmail/send.js";
import { buildDailyDigest } from "../../modules/chase/digest.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.chase-digest" });

export type ChaseDigestJobData = {
  trigger?: "scheduled" | "manual";
};

export type ChaseDigestJobResult = {
  sent: boolean;
  reason: "shadow_mode" | "no_recipient" | "no_overdue" | "no_digest" | "sent";
  recipient?: string;
  messageId?: string;
  customerCount: number;
};

// Wrap the chase module's plain-text digest in an HTML envelope. Lightweight
// on purpose — the body is the AI prose; styling stays minimal so the email
// renders cleanly in any client.
function htmlEnvelope(digest: string): string {
  // Convert the AI's text digest to a paragraph-per-blank-line HTML block.
  // No HTML escaping is necessary because the generated content is from our
  // own Anthropic call, not user input. If that ever changes, escape here.
  const paragraphs = digest
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
  return `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">${paragraphs}</body></html>`;
}

const SUBJECT_PREFIX = "Daily chase digest";

export async function processChaseDigest(
  job: Job<ChaseDigestJobData>,
): Promise<ChaseDigestJobResult> {
  const jobLog = log.child({ jobId: job.id });
  jobLog.info(
    { stage: "started", trigger: job.data.trigger ?? "scheduled" },
    "chase-digest job started",
  );

  // Build digest first regardless of shadow mode — that way logs always show
  // what would have been sent. Helps the parity diff against 1.0.
  const built = await buildDailyDigest();
  const customerCount = built.overdueCustomers.length;

  if (built.error && !built.digest) {
    // Common case: "No overdue customers" — not an error, just nothing to do.
    jobLog.info(
      { stage: "skipped", reason: "no_overdue", note: built.error, customerCount },
      "chase-digest: nothing to send",
    );
    return {
      sent: false,
      reason: customerCount === 0 ? "no_overdue" : "no_digest",
      customerCount,
    };
  }

  if (env.SHADOW_MODE) {
    jobLog.info(
      {
        stage: "skipped",
        reason: "shadow_mode",
        customerCount,
        digestPreview: built.digest?.slice(0, 200) ?? null,
      },
      "chase-digest: shadow mode, no email sent",
    );
    return { sent: false, reason: "shadow_mode", customerCount };
  }

  const recipient = env.CHASE_DIGEST_RECIPIENT;
  if (!recipient) {
    jobLog.warn(
      { stage: "skipped", reason: "no_recipient", customerCount },
      "chase-digest: CHASE_DIGEST_RECIPIENT not configured; nothing to send",
    );
    return { sent: false, reason: "no_recipient", customerCount };
  }

  if (!built.digest) {
    jobLog.warn(
      { stage: "skipped", reason: "no_digest", error: built.error, customerCount },
      "chase-digest: AI returned no digest body, skipping send",
    );
    return { sent: false, reason: "no_digest", customerCount };
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = await sendEmail({
    to: recipient,
    subject: `${SUBJECT_PREFIX} — ${today}`,
    html: htmlEnvelope(built.digest),
    text: built.digest,
  });

  jobLog.info(
    {
      stage: "completed",
      recipient,
      messageId: result.messageId,
      customerCount,
    },
    "chase-digest sent",
  );

  return {
    sent: true,
    reason: "sent",
    recipient,
    messageId: result.messageId,
    customerCount,
  };
}
