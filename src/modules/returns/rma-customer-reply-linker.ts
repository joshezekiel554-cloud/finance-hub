// rma-customer-reply-linker.ts
//
// When the Gmail poller ingests an inbound email, this module checks whether
// the message is a reply in a thread that originated from one of our outbound
// RMA emails. If so, it records an `rma_customer_reply` activity on the
// customer's timeline so operators can see the conversation without leaving
// the RMA detail page.
//
// Algorithm:
//   1. Quick gate: confirm there is at least one outbound email_log row in
//      this thread (or matching the inReplyTo header). If not, the inbound
//      message can't be a reply to anything we sent — bail.
//   2. Look up an `rma` activity whose `meta.threadId` matches. The
//      rma-email-send path stores threadId in meta when it inserts the
//      activity, so this is the authoritative join.
//   3. If found, write an `rma_customer_reply` activity referencing the RMA.
//      Otherwise return { linked: false } — we deliberately do NOT fall back
//      to "any active RMA for the customer" to avoid false positives
//      (statement / invoice replies attaching to an unrelated open RMA).
//
// This module is intentionally side-effect-free on failure — all errors are
// returned as `{ linked: false }` to the caller, which logs and continues.

import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailLog } from "../../db/schema/crm.js";
import { activities } from "../../db/schema/crm.js";
import { rmas } from "../../db/schema/returns.js";
import { recordActivity } from "../crm/activity-ingester.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "rma-customer-reply-linker" });

export type LinkCustomerReplyInput = {
  gmailMessageId: string;
  threadId: string;
  inReplyTo?: string;
  from: string;
  subject: string;
  bodySnippet: string;
};

export type LinkCustomerReplyResult =
  | { linked: true; rmaId: string }
  | { linked: false };

export async function linkCustomerReplyIfRmaThread(
  input: LinkCustomerReplyInput,
): Promise<LinkCustomerReplyResult> {
  const { gmailMessageId, threadId, inReplyTo, from, subject, bodySnippet } = input;

  try {
    // Step 1: Find outbound email_log rows whose thread matches.
    // We match on thread_id = threadId OR gmail_message_id = inReplyTo
    // (the latter handles the case where threadId differs between sender/recipient).
    const threadCondition = inReplyTo
      ? or(
          eq(emailLog.threadId, threadId),
          eq(emailLog.gmailMessageId, inReplyTo),
        )
      : eq(emailLog.threadId, threadId);

    if (!threadCondition) return { linked: false };

    const outboundRows = await db
      .select({ id: emailLog.id })
      .from(emailLog)
      .where(and(threadCondition, eq(emailLog.direction, "outbound")))
      .limit(1);

    if (outboundRows.length === 0) return { linked: false };

    // Step 2: Look for an `rma` activity whose meta.threadId matches.
    // The rma-email-send path stores threadId in meta when the activity is
    // written, so this is the authoritative join. If nothing matches, the
    // inbound email is a reply on a thread that wasn't started by an RMA
    // email — return { linked: false } and let the caller continue.
    const rmaActivityByThread = await db
      .select({ refId: activities.refId, customerId: activities.customerId })
      .from(activities)
      .where(
        and(
          eq(activities.refType, "rma"),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${activities.meta}, '$.threadId')) = ${threadId}`,
        ),
      )
      .limit(1);

    const firstRmaActivityByThread = rmaActivityByThread[0];
    if (firstRmaActivityByThread?.refId) {
      const rmaId = firstRmaActivityByThread.refId;
      const customerId = firstRmaActivityByThread.customerId;
      return await _recordReplyActivity({
        rmaId,
        customerId,
        gmailMessageId,
        threadId,
        from,
        subject,
        bodySnippet,
      });
    }

    // No RMA activity references this thread → not a reply to one of our RMA
    // emails. We deliberately do NOT fall back to "any active RMA for the
    // customer" because that produces false positives — a customer who replies
    // to an unrelated thread (statement, invoice question) would have their
    // message attached to whatever RMA happened to be open.
    //
    // The previous fallback ran the same `meta.threadId = threadId` query a
    // second time, which by definition could never return rows when the first
    // returned none. It was dead code; removed in this change.
    return { linked: false };
  } catch (err) {
    log.error({ err, gmailMessageId, threadId }, "linkCustomerReplyIfRmaThread failed");
    return { linked: false };
  }
}

// ---------------------------------------------------------------------------
// Internal helper: verify RMA exists + record activity
// ---------------------------------------------------------------------------

async function _recordReplyActivity(input: {
  rmaId: string;
  customerId: string | null;
  gmailMessageId: string;
  threadId: string;
  from: string;
  subject: string;
  bodySnippet: string;
}): Promise<LinkCustomerReplyResult> {
  const { rmaId, gmailMessageId, threadId, from, subject, bodySnippet } = input;
  let { customerId } = input;

  // Verify RMA exists + get customerId if we don't have it.
  if (!customerId) {
    const rmaRows = await db
      .select({ customerId: rmas.customerId })
      .from(rmas)
      .where(eq(rmas.id, rmaId))
      .limit(1);
    if (rmaRows.length === 0) return { linked: false };
    customerId = rmaRows[0]?.customerId ?? null;
  }

  if (!customerId) return { linked: false };

  await recordActivity({
    customerId,
    kind: "rma_customer_reply",
    source: "gmail_poll",
    refType: "rma",
    refId: rmaId,
    subject,
    body: bodySnippet,
    meta: { gmailMessageId, threadId, from },
  });

  log.info({ rmaId, customerId, gmailMessageId, threadId }, "linked customer reply to RMA");
  return { linked: true, rmaId };
}
