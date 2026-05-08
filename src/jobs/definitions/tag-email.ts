// Tag-email digest job processor.
//
// Three BullMQ jobs (tag-email-daily, tag-email-weekly, tag-email-monthly)
// all share this single handler. Each job payload carries `{ frequency }` so
// the handler knows which rows to query from tag_email_schedules.
//
// For every enabled schedule row:
//   1. Resolve customers whose `tags` JSON array contains the schedule's tag.
//   2. Compose an HTML + plain-text digest based on `contentType`.
//   3. Send via the Gmail send helper (same path as chase-digest).
//   4. Stamp `last_sent_at` on the schedule row.
//   5. Write an audit_log entry.
//
// Shadow-mode: respects env.SHADOW_MODE — composes the email but skips the
// actual Gmail call and lastSentAt update, consistent with other jobs.

import type { Job } from "bullmq";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { tagEmailSchedules, type TagEmailSchedule } from "../../db/schema/notifications.js";
import { auditLog } from "../../db/schema/audit.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.tag-email" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TagEmailJobData = {
  frequency: "daily" | "weekly" | "monthly";
};

export type TagEmailJobResult = {
  frequency: "daily" | "weekly" | "monthly";
  schedulesProcessed: number;
  scheduleResults: Array<{
    scheduleId: string;
    tag: string;
    recipientEmail: string;
    sent: boolean;
    customerCount: number;
    reason: "shadow_mode" | "sent" | "skipped_empty";
    messageId?: string;
  }>;
};

// ---------------------------------------------------------------------------
// HTML / text composition
// ---------------------------------------------------------------------------

type CustomerRow = {
  id: string;
  displayName: string;
  holdStatus: "active" | "hold" | "payment_upfront";
  balance: string | null;
};

/** Format a dollar amount string as "$1,234.56". Falls back to "$0.00". */
function formatBalance(raw: string | null): string {
  const n = parseFloat(raw ?? "0");
  return isNaN(n) ? "$0.00" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function holdLabel(status: "active" | "hold" | "payment_upfront"): string {
  if (status === "hold") return "On hold";
  if (status === "payment_upfront") return "Payment upfront";
  return status;
}

function buildHoldOrUpfrontHtml(
  tag: string,
  frequency: string,
  flagged: CustomerRow[],
): string {
  const heading =
    flagged.length === 0
      ? `No customers currently flagged`
      : `${flagged.length} customer${flagged.length === 1 ? "" : "s"} tagged '${tag}' currently on hold or payment-upfront.`;

  const tableRows = flagged
    .map(
      (c) => `    <tr>
      <td style="padding:6px 12px;border:1px solid #ddd">${escHtml(c.displayName)}</td>
      <td style="padding:6px 12px;border:1px solid #ddd">${holdLabel(c.holdStatus)}</td>
      <td style="padding:6px 12px;border:1px solid #ddd;text-align:right">${formatBalance(c.balance)}</td>
    </tr>`,
    )
    .join("\n");

  const table =
    flagged.length === 0
      ? ""
      : `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
  <thead>
    <tr style="background:#f5f5f5">
      <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Customer</th>
      <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Status</th>
      <th style="padding:6px 12px;border:1px solid #ddd;text-align:right">Open Balance</th>
    </tr>
  </thead>
  <tbody>
${tableRows}
  </tbody>
</table>`;

  return `<!doctype html>
<html>
<body style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">
  <p style="margin:0 0 8px"><strong>${escHtml(heading)}</strong></p>
  ${table}
  <p style="margin:16px 0 0;font-size:11px;color:#888">Finance Hub ${frequency} digest — tag: ${escHtml(tag)}</p>
</body>
</html>`;
}

function buildHoldOrUpfrontText(
  tag: string,
  frequency: string,
  flagged: CustomerRow[],
): string {
  if (flagged.length === 0) {
    return `[Finance Hub ${frequency} digest — tag: ${tag}]\n\nNo customers currently flagged.`;
  }
  const header = `${flagged.length} customer${flagged.length === 1 ? "" : "s"} tagged '${tag}' currently on hold or payment-upfront.\n`;
  const lines = flagged.map(
    (c) => `  ${c.displayName} — ${holdLabel(c.holdStatus)} — ${formatBalance(c.balance)}`,
  );
  return `[Finance Hub ${frequency} digest — tag: ${tag}]\n\n${header}\n${lines.join("\n")}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Per-schedule send
// ---------------------------------------------------------------------------

async function processSchedule(
  schedule: TagEmailSchedule,
  frequency: "daily" | "weekly" | "monthly",
  jobId: string | undefined,
): Promise<TagEmailJobResult["scheduleResults"][number]> {
  const schedLog = log.child({ jobId, scheduleId: schedule.id, tag: schedule.tag, recipient: schedule.recipientEmail });

  // 1. Resolve flagged customers for this tag.
  //    We load all customers then filter in JS — the tags column is JSON so
  //    a MySQL JSON_CONTAINS query would work but adds complexity; customer
  //    counts are small and this avoids a raw SQL dependency.
  const allTagged = await db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      holdStatus: customers.holdStatus,
      balance: customers.balance,
      tags: customers.tags,
    })
    .from(customers);

  const tag = schedule.tag.toLowerCase().trim();
  const flagged: CustomerRow[] = allTagged
    .filter(
      (c) =>
        Array.isArray(c.tags) &&
        c.tags.some((t: string) => t.toLowerCase().trim() === tag) &&
        (c.holdStatus === "hold" || c.holdStatus === "payment_upfront"),
    )
    .map((c) => ({
      id: c.id,
      displayName: c.displayName,
      holdStatus: c.holdStatus,
      balance: c.balance,
    }));

  schedLog.info({ flaggedCount: flagged.length }, "resolved flagged customers");

  // 2. Compose content.
  let html: string;
  let text: string;
  // Only "hold_or_upfront_summary" exists today; future contentTypes extend here.
  html = buildHoldOrUpfrontHtml(schedule.tag, frequency, flagged);
  text = buildHoldOrUpfrontText(schedule.tag, frequency, flagged);

  const freqLabel = frequency.charAt(0).toUpperCase() + frequency.slice(1);
  const subject = `[Finance Hub] '${schedule.tag}' ${freqLabel.toLowerCase()} summary`;

  // 3. Shadow-mode short-circuit.
  if (env.SHADOW_MODE) {
    schedLog.info(
      { stage: "skipped", reason: "shadow_mode", subject, customerCount: flagged.length },
      "tag-email: shadow_mode — skipping send",
    );
    return {
      scheduleId: schedule.id,
      tag: schedule.tag,
      recipientEmail: schedule.recipientEmail,
      sent: false,
      customerCount: flagged.length,
      reason: "shadow_mode",
    };
  }

  // 4. Send.
  const result = await sendEmail({ to: schedule.recipientEmail, subject, html, text });

  schedLog.info(
    { stage: "sent", messageId: result.messageId, customerCount: flagged.length },
    "tag-email sent",
  );

  // 5. Stamp lastSentAt.
  await db
    .update(tagEmailSchedules)
    .set({ lastSentAt: new Date() })
    .where(eq(tagEmailSchedules.id, schedule.id));

  // 6. Audit log.
  await db.insert(auditLog).values({
    id: nanoid(24),
    action: "tag_email_sent",
    entityType: "tag_email_schedule",
    entityId: schedule.id,
    before: null,
    after: {
      recipientEmail: schedule.recipientEmail,
      customerCount: flagged.length,
      customerIds: flagged.map((c) => c.id),
    },
  });

  return {
    scheduleId: schedule.id,
    tag: schedule.tag,
    recipientEmail: schedule.recipientEmail,
    sent: true,
    customerCount: flagged.length,
    reason: "sent",
    messageId: result.messageId,
  };
}

// ---------------------------------------------------------------------------
// Main processor — called by worker for all three cron jobs
// ---------------------------------------------------------------------------

export async function processTagEmail(
  job: Job<TagEmailJobData>,
): Promise<TagEmailJobResult> {
  const { frequency } = job.data;
  const jobLog = log.child({ jobId: job.id, frequency });

  jobLog.info({ stage: "started" }, "tag-email job started");

  // Load all enabled schedules for this frequency.
  const schedules = await db
    .select()
    .from(tagEmailSchedules)
    .where(and(eq(tagEmailSchedules.enabled, true), eq(tagEmailSchedules.frequency, frequency)));

  jobLog.info({ scheduleCount: schedules.length }, "loaded schedules");

  const scheduleResults: TagEmailJobResult["scheduleResults"] = [];
  for (const schedule of schedules) {
    try {
      const r = await processSchedule(schedule, frequency, job.id);
      scheduleResults.push(r);
    } catch (err) {
      jobLog.error(
        { scheduleId: schedule.id, err: (err as Error).message },
        "tag-email: schedule send failed — continuing to next",
      );
      scheduleResults.push({
        scheduleId: schedule.id,
        tag: schedule.tag,
        recipientEmail: schedule.recipientEmail,
        sent: false,
        customerCount: 0,
        reason: "skipped_empty",
      });
    }
  }

  jobLog.info(
    { stage: "completed", schedulesProcessed: schedules.length },
    "tag-email job completed",
  );

  return {
    frequency,
    schedulesProcessed: schedules.length,
    scheduleResults,
  };
}
