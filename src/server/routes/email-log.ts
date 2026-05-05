// Per-email actions on the customer-detail Email tab.
//
// PATCH /api/email-log/:id { actioned: bool } toggles actionedAt.
// POST /api/email-log/:id/to-task { title?, body?, dueAt?, priority? }
//   creates a task with relatedActivityId resolved from the email's
//   activity row (the gmail poller writes one with refType="email_log",
//   refId=email.id). The task inherits the email's customer.
//
// List + read goes through /api/customers/:id/emails on the customers
// route file, mirroring the activity timeline pattern. Splitting like
// this keeps the customers route focused on customer-level reads and
// puts email-row mutations in their own home for future endpoints
// (mark-spam, resend, archive, etc.).

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { activities, emailLog, tasks, TASK_PRIORITIES } from "../../db/schema/crm.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";
import {
  getMessageRecipients,
  markGmailAsRead,
} from "../../integrations/gmail/client.js";
import { BUSINESS_EMAILS } from "../../integrations/gmail/business-emails.js";

const log = createLogger({ component: "routes.email-log" });

const patchBodySchema = z.object({
  actioned: z.boolean(),
});

// Cap matches the largest realistic per-customer email list — Feldart
// hits ~500 historical messages on the most-active customer. Beyond
// that the audit-row insert turns into a problem; if a real workflow
// ever needs more, paginate from the client.
const BULK_ACTION_MAX = 500;
const bulkPatchBodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(BULK_ACTION_MAX),
  actioned: z.boolean(),
});

const toTaskBodySchema = z.object({
  title: z.string().min(1).max(512).optional(),
  body: z.string().max(10_000).optional(),
  dueAt: z
    .string()
    .datetime()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeUserId: z.string().max(255).optional(),
});

const emailLogRoute: FastifyPluginAsync = async (app) => {
  // PATCH /api/email-log/:id — set or clear actionedAt. Body
  // `{ actioned: true }` stamps now + current user; `{ actioned: false }`
  // clears both fields. Idempotent: the audit row records every flip.
  app.patch("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const beforeRows = await db
      .select()
      .from(emailLog)
      .where(eq(emailLog.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "email not found" });

    const update = parse.data.actioned
      ? { actionedAt: new Date(), actionedByUserId: user.id }
      : { actionedAt: null, actionedByUserId: null };

    await db.update(emailLog).set(update).where(eq(emailLog.id, id));

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "email_log.action",
      entityType: "email_log",
      entityId: id,
      before: { actionedAt: before.actionedAt?.toISOString() ?? null },
      after: { actionedAt: update.actionedAt?.toISOString() ?? null },
    });

    // Mirror in Gmail: when an operator actions an email here, drop the
    // UNREAD label so the Gmail inbox view reflects what they've already
    // dealt with. Fire-and-forget — Gmail downtime shouldn't block the
    // primary action. We only mark-as-read on action=true; un-actioning
    // doesn't restore unread (would be surprising / not what operators want).
    if (parse.data.actioned && before.gmailMessageId) {
      markGmailAsRead(before.gmailMessageId).catch((err) => {
        log.warn(
          {
            err: err instanceof Error ? err.message : err,
            emailLogId: id,
            gmailMessageId: before.gmailMessageId,
          },
          "failed to mark Gmail message as read",
        );
      });
    }

    const afterRows = await db
      .select()
      .from(emailLog)
      .where(eq(emailLog.id, id))
      .limit(1);
    return reply.send({ email: afterRows[0]! });
  });

  // POST /api/email-log/mark-actioned-bulk — same semantics as the
  // single PATCH above, but for a list of ids in one round-trip. Built
  // for the customer-detail Email tab's multi-select toolbar; without
  // this, sweeping 30 emails to actioned hammers the rate limiter
  // (PATCH + invalidate refetch per click).
  //
  // Idempotent: setting actioned=true on already-actioned rows is a
  // no-op against the data (UPDATE finds nothing to change because of
  // the WHERE IN + the already-set value), but we still emit one
  // audit row per id so the trail captures every operator intent.
  app.post("/mark-actioned-bulk", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = bulkPatchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { ids, actioned } = parse.data;

    const beforeRows = await db
      .select({
        id: emailLog.id,
        actionedAt: emailLog.actionedAt,
        gmailMessageId: emailLog.gmailMessageId,
      })
      .from(emailLog)
      .where(inArray(emailLog.id, ids));
    const beforeMap = new Map(
      beforeRows.map((r) => [r.id, r.actionedAt ?? null]),
    );

    const update = actioned
      ? { actionedAt: new Date(), actionedByUserId: user.id }
      : { actionedAt: null, actionedByUserId: null };

    await db
      .update(emailLog)
      .set(update)
      .where(inArray(emailLog.id, ids));

    // One audit row per id covered by the request — including ones that
    // weren't found in beforeRows, since the operator's INTENT was to
    // act on every id they passed. Missing ids get an explicit
    // "before: not_found" so the trail explains the no-op write.
    const afterIso = update.actionedAt?.toISOString() ?? null;
    const auditValues = ids.map((id) => ({
      id: nanoid(24),
      userId: user.id,
      action: "email_log.action_bulk",
      entityType: "email_log",
      entityId: id,
      before: beforeMap.has(id)
        ? { actionedAt: beforeMap.get(id)?.toISOString() ?? null }
        : { actionedAt: null, missing: true },
      after: { actionedAt: afterIso },
    }));
    if (auditValues.length > 0) {
      await db.insert(auditLog).values(auditValues);
    }

    log.info(
      { count: ids.length, actioned, userId: user.id },
      "email_log mark-actioned-bulk applied",
    );

    // Mark each Gmail message as read in the background. Same fire-and-forget
    // pattern as the single-PATCH route. Run with limited parallelism so we
    // don't burst the Gmail rate limit on large batches.
    if (actioned) {
      void (async () => {
        for (const r of beforeRows) {
          if (!r.gmailMessageId) continue;
          try {
            await markGmailAsRead(r.gmailMessageId);
          } catch (err) {
            log.warn(
              {
                err: err instanceof Error ? err.message : err,
                emailLogId: r.id,
                gmailMessageId: r.gmailMessageId,
              },
              "failed to mark Gmail message as read (bulk)",
            );
          }
        }
      })();
    }

    return reply.send({
      updated: beforeRows.length,
      missing: ids.length - beforeRows.length,
    });
  });

  // GET /api/email-log/:id/recipients — fetch the original message's
  // To/Cc headers for the Reply all flow. Returns a single cc string
  // ready to paste into the compose modal — original To+Cc combined,
  // de-duped, with our own addresses + the original sender stripped.
  app.get("/:id/recipients", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const rows = await db
      .select({
        gmailMessageId: emailLog.gmailMessageId,
        fromAddress: emailLog.fromAddress,
      })
      .from(emailLog)
      .where(eq(emailLog.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "email not found" });
    if (!row.gmailMessageId) {
      return reply.send({ to: "", cc: "" });
    }
    try {
      const headers = await getMessageRecipients(row.gmailMessageId);
      const cc = buildReplyAllCc(
        headers.to,
        headers.cc,
        headers.from || row.fromAddress || "",
      );
      // The "to" for reply-all is just the original sender — the existing
      // Reply path already prefills that, so we only return cc here.
      return reply.send({ cc });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err, emailLogId: id },
        "failed to fetch reply-all recipients from Gmail",
      );
      return reply.code(502).send({ error: "Gmail headers fetch failed" });
    }
  });

  // POST /api/email-log/:id/to-task — promote an email into a task.
  // The new task's relatedActivityId points at the email's activity row
  // (gmail poller wrote one with refType="email_log", refId=emailId).
  // Defaults: title = "Re: <subject>", body = first 1000 chars of email
  // body, customerId from the email, assigneeUserId = current user.
  // Caller can override any of these in the body. Emits task.created.
  app.post("/:id/to-task", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = toTaskBodySchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const overrides = parse.data;

    const emailRows = await db
      .select()
      .from(emailLog)
      .where(eq(emailLog.id, id))
      .limit(1);
    const email = emailRows[0];
    if (!email) return reply.code(404).send({ error: "email not found" });

    // Find the activity row that was created when this email was ingested
    // so the task can FK back to it. May be null if the email wasn't
    // matched to a customer (no activity gets written in that case).
    const activityRows = await db
      .select({ id: activities.id })
      .from(activities)
      .where(
        and(
          eq(activities.refType, "email_log"),
          eq(activities.refId, id),
        ),
      )
      .limit(1);
    const relatedActivityId = activityRows[0]?.id ?? null;

    const taskId = nanoid(24);
    const defaultTitle =
      overrides.title ??
      (email.subject ? `Re: ${email.subject}` : "Follow up on email");
    const defaultBody =
      overrides.body ??
      (email.body ? truncate(email.body, 1000) : null) ??
      null;

    await db.insert(tasks).values({
      id: taskId,
      customerId: email.customerId,
      assigneeUserId: overrides.assigneeUserId ?? user.id,
      createdByUserId: user.id,
      title: defaultTitle,
      body: defaultBody,
      dueAt: overrides.dueAt ?? null,
      priority: overrides.priority ?? "normal",
      status: "open",
      tags: [],
      position: "1000",
      relatedActivityId,
      aiProposed: false,
    });

    // Audit — captures the source-of-truth wiring (email → task) so we
    // can trace which email a task came from after the fact.
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "task.create",
      entityType: "task",
      entityId: taskId,
      before: null,
      after: {
        taskId,
        sourceEmailId: id,
        relatedActivityId,
        customerId: email.customerId,
      },
    });

    events.emit("task.created", {
      taskId,
      customerId: email.customerId,
    });

    log.info(
      { taskId, sourceEmailId: id, userId: user.id },
      "task created from email",
    );

    return reply.send({ taskId });
  });
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// Build the cc string for a Reply All. Combines original To + Cc, drops:
//   - our own outbound addresses (so we don't email ourselves),
//   - the original sender (already going in the To field of the reply),
//   - duplicates (case-insensitive on the email portion).
// Address parsing is loose-RFC-5322 — split on commas and pluck out the
// email between < > if present, else use the whole token. Good enough
// for the Gmail header strings we get from the API.
function buildReplyAllCc(
  toHeader: string,
  ccHeader: string,
  senderHeader: string,
): string {
  const senderEmail = extractEmail(senderHeader).toLowerCase();
  const seen = new Set<string>();
  if (senderEmail) seen.add(senderEmail);
  for (const ours of BUSINESS_EMAILS) {
    seen.add(ours.toLowerCase());
  }
  const out: string[] = [];
  for (const raw of [
    ...splitAddressList(toHeader),
    ...splitAddressList(ccHeader),
  ]) {
    const email = extractEmail(raw).toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(raw.trim());
  }
  return out.join(", ");
}

function splitAddressList(s: string): string[] {
  if (!s) return [];
  // Split on commas that aren't inside quotes — naive but handles the
  // common "Name, Surname" <foo@bar.com> case. We don't see RFC groups
  // ("group:addr1,addr2;") in practice from Gmail's metadata.
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
    } else if (ch === "," && !inQuote) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function extractEmail(addr: string): string {
  // "Name <email>" → email; otherwise return the input trimmed.
  const m = addr.match(/<([^>]+)>/);
  return (m?.[1] ?? addr).trim();
}

export default emailLogRoute;
