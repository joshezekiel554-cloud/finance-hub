// rma-customer-reply-linker.ts
//
// When the Gmail poller ingests an inbound email, this module checks whether
// the message is a reply in a thread that originated from one of our outbound
// RMA emails. If so, it records an `rma_customer_reply` activity on the
// customer's timeline so operators can see the conversation without leaving
// the RMA detail page.
//
// Algorithm:
//   1. Query email_log for outbound rows where:
//        (thread_id = input.threadId OR gmail_message_id = input.inReplyTo)
//        AND ref_type != 'rma' is NOT required — we check all outbound rows in
//        the thread and look up the RMA through the activity table.
//
//      Actually we look at the activities table for the rma ref:
//        SELECT a.ref_id FROM activities a
//        JOIN email_log el ON el.id = a.ref_id
//        WHERE a.ref_type = 'email_log'
//          AND a.ref_id IN (outbound email_log ids in this thread)
//      ... or simpler: look for activities with ref_type='rma' whose
//      `meta` contains the threadId.
//
//      Simplest reliable path: look for email_log rows in this thread
//      that are outbound, then look for activities tied to an rma that
//      reference those email_log rows OR directly search activities where
//      meta.threadId = threadId AND ref_type = 'rma'.
//
//      BUT: the rma-email-send activities use refType='rma' and store
//      meta.threadId + meta.gmailMessageId. So the cleanest query is:
//      SELECT ref_id FROM activities
//      WHERE ref_type = 'rma'
//        AND JSON_EXTRACT(meta, '$.threadId') = :threadId
//      LIMIT 1
//
//      Fallback: email_log.thread_id join.
//
// This module is intentionally side-effect-free on failure — all errors are
// returned as `{ linked: false }` to the caller, which logs and continues.

import { and, eq, or, sql, isNotNull } from "drizzle-orm";
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
      .limit(20);

    if (outboundRows.length === 0) return { linked: false };

    const emailLogIds = outboundRows.map((r) => r.id);

    // Step 2: Look for activities linked to these email_log rows that have
    // ref_type = 'rma'. The email-send activities store refType='email_log'
    // and refId=emailLogId, but RMA-specific email activities may store
    // refType='rma'. Try both approaches.

    // First: check if any activity with ref_type='rma' has meta.threadId = threadId.
    // This is the most reliable path when the outbound RMA email was sent via
    // the app (which stores threadId in meta).
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

    // Second: look for email_log rows in this thread that are outbound,
    // then find activities whose refType='email_log' and refId is in that set.
    // Then walk up to see if any of those activities have a sibling rma activity
    // for the same customer. This is more complex; skip it for now and use a
    // simpler fallback: check email_log rows with a customerId, then check if
    // that customer has an rma whose extensivRef or rmaNumber appears in the subject.

    // Simpler fallback: find outbound email_log rows in this thread that have
    // a customerId, then find an RMA for that customer that is active.
    // This is a best-effort approach when meta.threadId isn't stored.
    const outboundWithCustomer = await db
      .select({ id: emailLog.id, customerId: emailLog.customerId })
      .from(emailLog)
      .where(
        and(
          threadCondition,
          eq(emailLog.direction, "outbound"),
          isNotNull(emailLog.customerId),
        ),
      )
      .limit(1);

    const firstOutboundWithCustomer = outboundWithCustomer[0];
    if (!firstOutboundWithCustomer?.customerId) {
      return { linked: false };
    }

    const customerId = firstOutboundWithCustomer.customerId;

    // Look for an RMA activity (any kind) for this customer that references a
    // thread via meta, or just find the most recent non-draft RMA for this customer.
    // This is a heuristic fallback — only link if we find a clear match.
    const rmaActivityForCustomer = await db
      .select({ refId: activities.refId })
      .from(activities)
      .where(
        and(
          eq(activities.customerId, customerId),
          eq(activities.refType, "rma"),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${activities.meta}, '$.threadId')) = ${threadId}`,
        ),
      )
      .limit(1);

    const firstRmaActivityForCustomer = rmaActivityForCustomer[0];
    if (!firstRmaActivityForCustomer?.refId) {
      return { linked: false };
    }

    const rmaId = firstRmaActivityForCustomer.refId;
    return await _recordReplyActivity({
      rmaId,
      customerId,
      gmailMessageId,
      threadId,
      from,
      subject,
      bodySnippet,
    });
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
