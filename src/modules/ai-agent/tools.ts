// Tool registry — the canonical surface for autopilot's approved-action
// execution. Each tool is a thin shim: Zod args schema + an execute()
// that calls existing route/module logic and tags downstream rows with
// the originating ai_proposal_id for the AI provenance badge.
//
// v0 contains 5 tools wired to the 5 v0 proposal categories. The
// eventual /agent chat will extend this registry incrementally.

import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { emailLog, tasks } from "../../db/schema/crm.js";
import { auditLog, chaseLog } from "../../db/schema/audit.js";
import { notifications } from "../../db/schema/notifications.js";
import { statementSends } from "../../db/schema/crm.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import type { EmailAttachment } from "../../integrations/gmail/types.js";
import { QboClient } from "../../integrations/qb/client.js";
import { resolveRecipients } from "../customer-emails/recipients.js";
import { appendSignatures } from "../email-compose/signatures.js";
import {
  buildStatementPdfAttachment,
  recordAttachedStatement,
  sendStatement,
} from "../statements/send.js";
import { loadAppSettings } from "../statements/settings.js";
import { autoActionPriorInbounds } from "../crm/auto-action-emails.js";
import { linkBookkeeperThread } from "../../server/lib/bookkeeper-thread-link.js";
import { users } from "../../db/schema/auth.js";
import { recordActivity } from "../crm/index.js";
import {
  disputeClaimsPaid,
  disputeResolvePaid,
  disputeResolveUnpaid,
} from "../crm/dispute-actions.js";
import { applyHoldStatus } from "../holds/apply.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "ai-agent.tools" });

export type ToolContext = {
  userId: string;
  proposalId: string;
};

// `note` flags a degraded success: the side effect the operator cares about
// (the email) went out, but a post-send bookkeeping write failed and was only
// logged. The proposal still shows executed — see the at-most-once comments
// in the email tools below.
export type ToolResult =
  | { ok: true; note?: string }
  | { ok: false; error: string };

export type Tool<A = unknown> = {
  name: string;
  description: string;
  // Input type is `unknown` (third param) so schemas with defaults
  // (ZodDefault — e.g. send_chase_email's origin) typecheck: their input
  // type is wider than their output type A.
  argsSchema: z.ZodType<A, z.ZodTypeDef, unknown>;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>;
};

// ── shared send helpers ────────────────────────────────────────────────

// Recipients come from the canonical per-channel resolver (chase emails
// reuse the statement set by spec — see customer-emails/recipients.ts).
// primary_email is a legacy display field and only used as a last-resort
// fallback so a customer with no configured lists still gets a delivery,
// matching the statement-send behavior.
async function resolveSendRecipients(customer: {
  primaryEmail: string | null;
  billingEmails: unknown;
  invoiceToEmails: unknown;
  invoiceCcEmails: unknown;
  invoiceBccEmails: unknown;
  statementToEmails: unknown;
  statementCcEmails: unknown;
  statementBccEmails: unknown;
  tags: unknown;
}): Promise<{ to: string; cc?: string; bcc?: string } | null> {
  const resolved = await resolveRecipients("statement", {
    primaryEmail: customer.primaryEmail,
    billingEmails: customer.billingEmails as string[] | null,
    invoiceToEmails: customer.invoiceToEmails as string[] | null,
    invoiceCcEmails: customer.invoiceCcEmails as string[] | null,
    invoiceBccEmails: customer.invoiceBccEmails as string[] | null,
    statementToEmails: customer.statementToEmails as string[] | null,
    statementCcEmails: customer.statementCcEmails as string[] | null,
    statementBccEmails: customer.statementBccEmails as string[] | null,
    tags: customer.tags as string[] | null,
  });
  const to =
    resolved.to.length > 0
      ? resolved.to.join(", ")
      : (customer.primaryEmail ?? null);
  if (!to) return null;
  return {
    to,
    cc: resolved.cc.length > 0 ? resolved.cc.join(", ") : undefined,
    bcc: resolved.bcc.length > 0 ? resolved.bcc.join(", ") : undefined,
  };
}

// Attachment args shared by chase + check-in sends. Invoice PDFs come
// from QBO by docNumber (scoped to THIS customer — a docNumber belonging
// to anyone else is an error); the statement is built by the statements
// module. Any fetch failure aborts BEFORE the send: the operator asked
// for the attachment, so sending without it silently is worse than
// failing loudly.
const AttachmentArgs = {
  attachInvoiceDocNumbers: z.array(z.string().min(1).max(64)).max(5).optional(),
  attachStatement: z.boolean().optional(),
};

async function buildSendAttachments(args: {
  customerId: string;
  origin?: "feldart" | "tj";
  attachInvoiceDocNumbers?: string[];
  attachStatement?: boolean;
}): Promise<
  | {
      ok: true;
      attachments: EmailAttachment[];
      statementMeta?: { statementNumber: number; pdfBytes: number };
    }
  | { ok: false; error: string }
> {
  const attachments: EmailAttachment[] = [];
  let statementMeta: { statementNumber: number; pdfBytes: number } | undefined;
  if (args.attachInvoiceDocNumbers?.length) {
    const rows = await db
      .select({
        docNumber: invoices.docNumber,
        qbInvoiceId: invoices.qbInvoiceId,
        status: invoices.status,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.customerId, args.customerId),
          inArray(invoices.docNumber, args.attachInvoiceDocNumbers),
        ),
      );
    const byDoc = new Map(rows.map((r) => [r.docNumber, r]));
    const qb = new QboClient();
    for (const doc of args.attachInvoiceDocNumbers) {
      const inv = byDoc.get(doc);
      if (!inv) {
        return {
          ok: false,
          error: `invoice ${doc} not found on this customer — check the doc number`,
        };
      }
      try {
        const pdf = await qb.getPdf("invoice", inv.qbInvoiceId);
        attachments.push({
          filename: `Invoice-${doc}.pdf`,
          mimeType: "application/pdf",
          data: pdf,
        });
      } catch (err) {
        return {
          ok: false,
          error: `could not fetch the PDF for invoice ${doc} from QuickBooks: ${err instanceof Error ? err.message : "fetch failed"}`,
        };
      }
    }
  }
  if (args.attachStatement) {
    try {
      const built = await buildStatementPdfAttachment(
        args.customerId,
        args.origin,
      );
      attachments.push({
        filename: built.filename,
        mimeType: "application/pdf",
        data: built.buffer,
      });
      statementMeta = {
        statementNumber: built.statementNumber,
        pdfBytes: built.buffer.byteLength,
      };
    } catch (err) {
      return {
        ok: false,
        error: `could not build the statement PDF: ${err instanceof Error ? err.message : "build failed"}`,
      };
    }
  }
  return { ok: true, attachments, statementMeta };
}

// ── send_chase_email ───────────────────────────────────────────────────
const SendChaseEmailArgs = z.object({
  customerId: z.string().min(1).max(24),
  tier: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  // Which book is being chased. tj_chase drafts pass "tj" (instructed by
  // prompts/tj-chase.ts); chase_next drafts default to "feldart". Recorded
  // in the chase_log provenance note — the send mechanics are identical.
  origin: z.enum(["feldart", "tj"]).default("feldart"),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
  ...AttachmentArgs,
});

const tierToChaseSeverity = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;

const sendChaseEmailTool: Tool<z.infer<typeof SendChaseEmailArgs>> = {
  name: "send_chase_email",
  description: "Send a chase email at the specified tier to a customer.",
  argsSchema: SendChaseEmailArgs,
  execute: async (args, ctx) => {
    try {
      const rows = await db
        .select()
        .from(customers)
        .where(eq(customers.id, args.customerId))
        .limit(1);
      const customer = rows[0];
      if (!customer) {
        return {
          ok: false,
          error: `customer ${args.customerId} not found — the id must come from search_customers/get_customer`,
        };
      }
      const recipients = await resolveSendRecipients(customer);
      if (!recipients) {
        return {
          ok: false,
          error: "no statement/chase recipients configured for this customer",
        };
      }
      const built = await buildSendAttachments({
        customerId: customer.id,
        origin: args.origin,
        attachInvoiceDocNumbers: args.attachInvoiceDocNumbers,
        attachStatement: args.attachStatement,
      });
      if (!built.ok) return { ok: false, error: built.error };
      const aliasEmail = "accounts@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      const result = await sendEmail({
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
        attachments: built.attachments.length ? built.attachments : undefined,
      });
      // ── Post-send bookkeeping: NEVER fatal past this point. ───────────
      // The execute queue retries failed jobs (attempts: 3 in queues.ts),
      // so returning ok:false after the email has left Gmail would re-send
      // the chase — a duplicate dunning email is unrecoverable, while a
      // missed bookkeeping row is recoverable from the error log. At-most-
      // once send beats at-least-once bookkeeping: once we hold a
      // messageId, write failures are logged + surfaced via `note`, and
      // the tool still reports success.
      const sentAt = new Date();
      let stage = "email_log insert";
      try {
        // email_log row with ai_proposal_id linkage. (sendEmail itself
        // doesn't write to email_log — the gmail poller's outbound
        // classification does, later. We pre-write so the AI provenance
        // badge lights up immediately on the customer page.)
        await db.insert(emailLog).values({
          id: nanoid(24),
          gmailMessageId: result.messageId,
          threadId: result.threadId || null,
          customerId: customer.id,
          userId: ctx.userId,
          direction: "outbound",
          aliasUsed: aliasEmail,
          fromAddress: aliasEmail,
          toAddress: recipients.to,
          subject: args.subject,
          snippet: args.body.slice(0, 200).replace(/<[^>]+>/g, " ").trim(),
          emailDate: sentAt,
          aiProposalId: ctx.proposalId,
        });
        stage = "auto-action prior inbounds";
        await autoActionPriorInbounds({
          customerId: customer.id,
          threadId: result.threadId || null,
          sentAt,
        });
        // chase_log row — drives the 7-day-no-chase dedup in the chase
        // candidate finders. If THIS write is the one that failed, the
        // cooldown is lost and the customer may be re-proposed inside the
        // window — visible in the queue and far cheaper than a duplicate.
        stage = "chase_log insert";
        await db.insert(chaseLog).values({
          id: nanoid(24),
          customerId: customer.id,
          userId: ctx.userId,
          method: "email",
          severity: tierToChaseSeverity[args.tier],
          aiProposalId: ctx.proposalId,
          notes:
            args.origin === "tj"
              ? `Autopilot TJ chase ${args.tier}`
              : `Autopilot chase ${args.tier}`,
        });
        if (built.statementMeta) {
          stage = "attached-statement bookkeeping";
          await recordAttachedStatement({
            customerId: customer.id,
            statementNumber: built.statementMeta.statementNumber,
            userId: ctx.userId,
            sentToEmail: recipients.to,
            origin: args.origin,
            pdfBytes: built.statementMeta.pdfBytes,
            messageId: result.messageId,
            threadId: result.threadId || null,
          });
        }
      } catch (err) {
        log.error(
          {
            err,
            proposalId: ctx.proposalId,
            messageId: result.messageId,
            customerId: customer.id,
            failedWrite: stage,
          },
          "send_chase_email: email sent but post-send bookkeeping failed",
        );
        return {
          ok: true,
          note: `email sent (messageId ${result.messageId}) but post-send bookkeeping failed at: ${stage} — see error log`,
        };
      }
      return { ok: true };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "send_chase_email failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── send_statement ─────────────────────────────────────────────────────
const SendStatementArgs = z.object({
  customerId: z.string().min(1).max(24),
  coverNote: z.string().max(2000).optional(),
});

const sendStatementTool: Tool<z.infer<typeof SendStatementArgs>> = {
  name: "send_statement",
  description: "Send a statement of open invoices to a customer.",
  argsSchema: SendStatementArgs,
  execute: async (args, ctx) => {
    try {
      await sendStatement({
        customerId: args.customerId,
        userId: ctx.userId,
        // Automated path with no book context: default to the living
        // (Feldart) book. Wave 2 makes AI proposals origin-aware.
        origin: "feldart",
        overrides: args.coverNote ? { body: args.coverNote } : {},
      });
      // Best-effort proposal linkage: stamp the most recent statement_sends
      // row for this customer. Tighten by extending sendStatement to
      // return the new row id in a follow-up.
      await db
        .update(statementSends)
        .set({ aiProposalId: ctx.proposalId })
        .where(
          sql`${statementSends.customerId} = ${args.customerId}
              AND ${statementSends.aiProposalId} IS NULL
              AND ${statementSends.sentAt} >= NOW() - INTERVAL 5 MINUTE`,
        );
      return { ok: true };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "send_statement failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── send_check_in_email ────────────────────────────────────────────────
const SendCheckInEmailArgs = z.object({
  customerId: z.string().min(1).max(24),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
  ...AttachmentArgs,
});

const sendCheckInEmailTool: Tool<z.infer<typeof SendCheckInEmailArgs>> = {
  name: "send_check_in_email",
  description: "Send a warm check-in email to a customer who has gone silent.",
  argsSchema: SendCheckInEmailArgs,
  execute: async (args, ctx) => {
    try {
      const rows = await db
        .select()
        .from(customers)
        .where(eq(customers.id, args.customerId))
        .limit(1);
      const customer = rows[0];
      if (!customer) {
        return {
          ok: false,
          error: `customer ${args.customerId} not found — the id must come from search_customers/get_customer`,
        };
      }
      const recipients = await resolveSendRecipients(customer);
      if (!recipients) {
        return {
          ok: false,
          error: "no statement/chase recipients configured for this customer",
        };
      }
      const built = await buildSendAttachments({
        customerId: customer.id,
        attachInvoiceDocNumbers: args.attachInvoiceDocNumbers,
        attachStatement: args.attachStatement,
      });
      if (!built.ok) return { ok: false, error: built.error };
      const aliasEmail = "accounts@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      const result = await sendEmail({
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
        attachments: built.attachments.length ? built.attachments : undefined,
      });
      const sentAt = new Date();
      await db.insert(emailLog).values({
        id: nanoid(24),
        gmailMessageId: result.messageId,
        threadId: result.threadId || null,
        customerId: customer.id,
        userId: ctx.userId,
        direction: "outbound",
        aliasUsed: aliasEmail,
        fromAddress: aliasEmail,
        toAddress: recipients.to,
        subject: args.subject,
        snippet: args.body.slice(0, 200).replace(/<[^>]+>/g, " ").trim(),
        emailDate: sentAt,
        aiProposalId: ctx.proposalId,
      });
      await autoActionPriorInbounds({
        customerId: customer.id,
        threadId: result.threadId || null,
        sentAt,
      });
      if (built.statementMeta) {
        await recordAttachedStatement({
          customerId: customer.id,
          statementNumber: built.statementMeta.statementNumber,
          userId: ctx.userId,
          sentToEmail: recipients.to,
          // check-in is origin-less; attached statements default to the
          // feldart book (matches buildSendAttachments' default).
          origin: "feldart",
          pdfBytes: built.statementMeta.pdfBytes,
          messageId: result.messageId,
          threadId: result.threadId || null,
        });
      }
      return { ok: true };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "send_check_in_email failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── send_bookkeeper_email ──────────────────────────────────────────────
// Executes approved tj_dispute_nudge proposals: an email to the Torah
// Judaica BOOKKEEPER (never the customer) about a verifying dispute.
//
// Recipient is resolved from app_settings.tj_bookkeeper_email at EXECUTION
// time — it is deliberately not part of the drafted args, so the AI can
// never redirect the email and a settings change between draft and approve
// is honoured. Unset setting → clean execution_failed with a pointer to
// Settings → Torah Judaica.
//
// Threading: when the invoice already has a linked bookkeeper thread, the
// send replies onto it (threadId + best-effort In-Reply-To from the latest
// email_log row). When it doesn't — the "needs first bookkeeper email"
// nudge — the resulting Gmail threadId is linked onto the invoice via the
// same helper the dispute compose flow uses (W2 T2), so subsequent nudges
// and the silence clock pick it up.
const SendBookkeeperEmailArgs = z.object({
  invoiceId: z.string().min(1).max(24),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
});

const sendBookkeeperEmailTool: Tool<z.infer<typeof SendBookkeeperEmailArgs>> = {
  name: "send_bookkeeper_email",
  description:
    "Send a TJ-dispute verification email to the Torah Judaica bookkeeper (recipient from settings, never the customer).",
  argsSchema: SendBookkeeperEmailArgs,
  execute: async (args, ctx) => {
    try {
      const rows = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, args.invoiceId))
        .limit(1);
      const invoice = rows[0];
      if (!invoice) {
        return { ok: false, error: "invoice not found" };
      }
      if (invoice.origin !== "tj") {
        return {
          ok: false,
          error: "bookkeeper emails are TJ-only; invoice is not a Torah Judaica invoice",
        };
      }

      const settings = await loadAppSettings();
      const bookkeeperEmail = settings.tj_bookkeeper_email.trim();
      if (!bookkeeperEmail) {
        return {
          ok: false,
          error:
            "tj_bookkeeper_email is not configured (Settings → Torah Judaica) — cannot send bookkeeper email",
        };
      }

      const aliasEmail = "accounts@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });

      // Reply onto the existing bookkeeper thread when one is linked.
      // In-Reply-To is best-effort (latest Message-ID header on the thread)
      // so non-Gmail clients thread the nudge too.
      let inReplyTo: string | undefined;
      if (invoice.bookkeeperThreadId) {
        const latest = await db
          .select({ messageIdHeader: emailLog.messageIdHeader })
          .from(emailLog)
          .where(eq(emailLog.threadId, invoice.bookkeeperThreadId))
          .orderBy(desc(emailLog.emailDate))
          .limit(1);
        inReplyTo = latest[0]?.messageIdHeader ?? undefined;
      }

      const result = await sendEmail({
        to: bookkeeperEmail,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
        threadId: invoice.bookkeeperThreadId ?? undefined,
        inReplyTo,
      });

      // ── Post-send bookkeeping: NEVER fatal past this point. ───────────
      // Same at-most-once tradeoff as send_chase_email: the execute queue
      // retries failed jobs, so a throw after the email left Gmail would
      // re-send the bookkeeper nudge. A missed email_log row (silence
      // clock) or thread link is recoverable from the error log; a
      // duplicate email is not. Once we hold a messageId, write failures
      // are logged + surfaced via `note`, and the tool reports success.
      const sentAt = new Date();
      let stage = "email_log insert";
      try {
        // Pre-write the email_log row (the gmail poller would also pick it
        // up later). Besides lighting up the AI provenance badge, this row
        // is what resets the dispute-nudge silence clock immediately — the
        // candidate finder reads latest email_log per bookkeeper thread.
        await db.insert(emailLog).values({
          id: nanoid(24),
          gmailMessageId: result.messageId,
          threadId: result.threadId || null,
          customerId: invoice.customerId,
          userId: ctx.userId,
          direction: "outbound",
          aliasUsed: aliasEmail,
          fromAddress: aliasEmail,
          toAddress: bookkeeperEmail,
          subject: args.subject,
          snippet: args.body.slice(0, 200).replace(/<[^>]+>/g, " ").trim(),
          emailDate: sentAt,
          aiProposalId: ctx.proposalId,
        });

        // First bookkeeper email on this dispute → link the thread onto the
        // invoice (same mechanism + audit action as the dispute compose flow).
        if (!invoice.bookkeeperThreadId) {
          if (result.threadId) {
            stage = "bookkeeper thread link";
            await linkBookkeeperThread(
              {
                updateThreadId: async (invoiceId, newThreadId) => {
                  await db
                    .update(invoices)
                    .set({ bookkeeperThreadId: newThreadId })
                    .where(eq(invoices.id, invoiceId));
                },
                insertAudit: async (row) => {
                  await db.insert(auditLog).values(row);
                },
              },
              {
                invoice: {
                  id: invoice.id,
                  origin: invoice.origin,
                  bookkeeperThreadId: invoice.bookkeeperThreadId,
                },
                threadId: result.threadId,
                userId: ctx.userId,
              },
            );
          } else {
            log.warn(
              { invoiceId: invoice.id, messageId: result.messageId },
              "gmail send returned no threadId; bookkeeper thread not linked",
            );
          }
        }
      } catch (err) {
        log.error(
          {
            err,
            proposalId: ctx.proposalId,
            messageId: result.messageId,
            invoiceId: invoice.id,
            failedWrite: stage,
          },
          "send_bookkeeper_email: email sent but post-send bookkeeping failed",
        );
        return {
          ok: true,
          note: `email sent (messageId ${result.messageId}) but post-send bookkeeping failed at: ${stage} — see error log`,
        };
      }

      return { ok: true };
    } catch (err) {
      log.error(
        { err, proposalId: ctx.proposalId },
        "send_bookkeeper_email failed",
      );
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── nudge_warehouse_email ──────────────────────────────────────────────
const NudgeWarehouseEmailArgs = z.object({
  rmaId: z.string().min(1).max(24),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
});

const WAREHOUSE_EMAIL = "warehouse@feldart.com";

const nudgeWarehouseEmailTool: Tool<z.infer<typeof NudgeWarehouseEmailArgs>> = {
  name: "nudge_warehouse_email",
  description: "Send a nudge to the warehouse about a stalled RMA.",
  argsSchema: NudgeWarehouseEmailArgs,
  execute: async (args, ctx) => {
    try {
      const aliasEmail = "warehouse@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      await sendEmail({
        to: WAREHOUSE_EMAIL,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
      });
      return { ok: true };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "nudge_warehouse_email failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── create_admin_notification ──────────────────────────────────────────
const CreateAdminNotificationArgs = z.object({
  title: z.string().min(1).max(255),
  message: z.string().min(1).max(2000),
  severity: z.enum(["info", "warning", "error"]),
});

const createAdminNotificationTool: Tool<
  z.infer<typeof CreateAdminNotificationArgs>
> = {
  name: "create_admin_notification",
  description: "Create an admin notification visible to the team.",
  argsSchema: CreateAdminNotificationArgs,
  execute: async (args, ctx) => {
    try {
      await db.insert(notifications).values({
        id: nanoid(24),
        userId: ctx.userId,
        kind: "ai_proposal",
        refType: "ai_proposal",
        refId: ctx.proposalId,
      } as never);
      return { ok: true };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "create_admin_notification failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── Wave B tools (agent doer; spec 2026-06-11 §3) ──────────────────────
// Proposal-gated like everything in this registry: the agent loop
// proposalizes write tool_use calls; the BullMQ executor runs these on
// operator approve.

const CreateTaskArgs = z.object({
  title: z.string().min(1).max(512),
  body: z.string().max(8000).optional(),
  customerId: z.string().max(64).optional(),
  // Team member to assign; resolved to a user id at EXECUTION time so the
  // model never addresses an id directly. Unknown email = clean error.
  assigneeEmail: z.string().email().optional(),
  // Concrete ISO date/datetime; the MODEL converts natural language
  // ("the 15th") to ISO at draft time — the executor accepts only dates.
  dueAtIso: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
});
type CreateTaskArgsT = z.infer<typeof CreateTaskArgs>;

const createTaskTool: Tool<CreateTaskArgsT> = {
  name: "create_task",
  description:
    "Create a team task, optionally linked to a customer, assigned to a team member (by email) with a due date.",
  argsSchema: CreateTaskArgs,
  execute: async (args, ctx) => {
    try {
      let assigneeUserId: string | null = null;
      if (args.assigneeEmail) {
        const u = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, args.assigneeEmail))
          .limit(1);
        if (!u[0]) {
          return {
            ok: false,
            error: `no team member with email ${args.assigneeEmail}`,
          };
        }
        assigneeUserId = u[0].id;
      }
      let dueAt: Date | null = null;
      if (args.dueAtIso) {
        const d = new Date(args.dueAtIso);
        if (Number.isNaN(d.getTime())) {
          return { ok: false, error: `invalid dueAtIso: ${args.dueAtIso}` };
        }
        dueAt = d;
      }
      const id = nanoid(24);
      await db.insert(tasks).values({
        id,
        title: args.title,
        body: args.body ?? null,
        customerId: args.customerId ?? null,
        assigneeUserId: assigneeUserId ?? ctx.userId,
        createdByUserId: ctx.userId,
        dueAt,
        priority: args.priority ?? "normal",
        aiProposed: true,
      });
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: ctx.userId,
        action: "task.create",
        entityType: "task",
        entityId: id,
        before: null,
        after: {
          title: args.title,
          dueAt: args.dueAtIso ?? null,
          aiProposalId: ctx.proposalId,
        },
      });
      if (args.customerId) {
        await recordActivity({
          customerId: args.customerId,
          kind: "task_created",
          source: "ai_agent",
          userId: ctx.userId,
          subject: `Task created: ${args.title}`,
          refType: "task",
          refId: id,
          meta: { aiProposalId: ctx.proposalId },
        });
      }
      return { ok: true, note: `task ${id} created` };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "create_task failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const CompleteTaskArgs = z.object({ taskId: z.string().max(64) });
type CompleteTaskArgsT = z.infer<typeof CompleteTaskArgs>;

const completeTaskTool: Tool<CompleteTaskArgsT> = {
  name: "complete_task",
  description: "Mark an open task as completed.",
  argsSchema: CompleteTaskArgs,
  execute: async (args, ctx) => {
    try {
      const rows = await db
        .select({ id: tasks.id, status: tasks.status, title: tasks.title })
        .from(tasks)
        .where(eq(tasks.id, args.taskId))
        .limit(1);
      const t = rows[0];
      if (!t) return { ok: false, error: "task not found" };
      if (t.status !== "open") {
        return { ok: false, error: `task is ${t.status}, not open` };
      }
      await db
        .update(tasks)
        .set({
          status: "completed",
          completedAt: new Date(),
          completedByUserId: ctx.userId,
        })
        .where(eq(tasks.id, args.taskId));
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: ctx.userId,
        action: "task.complete",
        entityType: "task",
        entityId: args.taskId,
        before: { status: t.status },
        after: { status: "completed", aiProposalId: ctx.proposalId },
      });
      return { ok: true, note: `task "${t.title}" completed` };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "complete_task failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const UpdateCustomerContextArgs = z.object({
  customerId: z.string().max(64),
  // Appended, never replacing — operator context is preserved and the
  // addition is attributed to the agent with a date stamp.
  append: z.string().min(1).max(4000),
});
type UpdateCustomerContextArgsT = z.infer<typeof UpdateCustomerContextArgs>;

const updateCustomerContextTool: Tool<UpdateCustomerContextArgsT> = {
  name: "update_customer_context",
  description:
    "Append a durable fact to the customer's AI context (visible and editable on the customer page). Appends with attribution; never replaces existing context.",
  argsSchema: UpdateCustomerContextArgs,
  execute: async (args, ctx) => {
    try {
      const rows = await db
        .select({ ctx: customers.aiCustomerContext })
        .from(customers)
        .where(eq(customers.id, args.customerId))
        .limit(1);
      if (rows.length === 0) return { ok: false, error: "customer not found" };
      const existing = rows[0]!.ctx?.trim() ?? "";
      const stamp = new Date().toISOString().slice(0, 10);
      const next = `${existing ? existing + "\n\n" : ""}[agent ${stamp}] ${args.append.trim()}`;
      await db
        .update(customers)
        .set({ aiCustomerContext: next })
        .where(eq(customers.id, args.customerId));
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: ctx.userId,
        action: "customer.ai_context_append",
        entityType: "customer",
        entityId: args.customerId,
        before: { length: existing.length },
        after: {
          appended: args.append.slice(0, 500),
          aiProposalId: ctx.proposalId,
        },
      });
      return { ok: true };
    } catch (err) {
      log.error(
        { err, proposalId: ctx.proposalId },
        "update_customer_context failed",
      );
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const RecordInteractionArgs = z.object({
  customerId: z.string().max(64),
  channel: z.enum(["whatsapp", "phone", "in_person", "other"]),
  summary: z.string().min(1).max(8000),
  occurredAtIso: z.string().optional(),
});
type RecordInteractionArgsT = z.infer<typeof RecordInteractionArgs>;

const recordInteractionTool: Tool<RecordInteractionArgsT> = {
  name: "record_interaction",
  description:
    "Log an out-of-band customer interaction (WhatsApp, phone outside the system, in person) on the customer's activity timeline, as dictated by the operator.",
  argsSchema: RecordInteractionArgs,
  execute: async (args, ctx) => {
    try {
      let occurredAt: Date | undefined;
      if (args.occurredAtIso) {
        const d = new Date(args.occurredAtIso);
        if (!Number.isNaN(d.getTime())) occurredAt = d;
      }
      const channelLabel =
        args.channel === "in_person" ? "in person" : args.channel;
      const activityId = await recordActivity({
        customerId: args.customerId,
        kind: "manual_note",
        source: "ai_agent",
        userId: ctx.userId,
        occurredAt,
        subject: `Operator-logged ${channelLabel} interaction`,
        body: args.summary,
        meta: { channel: args.channel, aiProposalId: ctx.proposalId },
      });
      if (!activityId) return { ok: false, error: "customer not found" };
      return { ok: true, note: "logged to the customer timeline" };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "record_interaction failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const SetHoldStatusArgs = z.object({
  customerId: z.string().max(64),
  targetState: z.enum(["active", "hold", "payment_upfront"]),
});
type SetHoldStatusArgsT = z.infer<typeof SetHoldStatusArgs>;

const setHoldStatusTool: Tool<SetHoldStatusArgsT> = {
  name: "set_hold_status",
  description:
    "Put a customer on hold, release them, or set payment-upfront. Flips the Shopify B2B tags atomically and mirrors locally (same path as the customer page's Hold button).",
  argsSchema: SetHoldStatusArgs,
  execute: async (args, ctx) => {
    const result = await applyHoldStatus(
      args.customerId,
      args.targetState,
      ctx.userId,
    );
    if (result.kind === "ok") {
      return { ok: true, note: `now ${result.holdStatus}` };
    }
    return { ok: false, error: result.message };
  },
};

const SetPaymentTermsArgs = z.object({
  customerId: z.string().max(64),
  terms: z.string().min(1).max(64),
});
type SetPaymentTermsArgsT = z.infer<typeof SetPaymentTermsArgs>;

const setPaymentTermsTool: Tool<SetPaymentTermsArgsT> = {
  name: "set_payment_terms",
  description:
    'Change the payment terms on a customer record (e.g. "Net 30", "Prepay"). Local CRM field; does not write to QuickBooks.',
  argsSchema: SetPaymentTermsArgs,
  execute: async (args, ctx) => {
    try {
      const rows = await db
        .select({ terms: customers.paymentTerms })
        .from(customers)
        .where(eq(customers.id, args.customerId))
        .limit(1);
      if (rows.length === 0) return { ok: false, error: "customer not found" };
      const before = rows[0]!.terms;
      await db
        .update(customers)
        .set({ paymentTerms: args.terms })
        .where(eq(customers.id, args.customerId));
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: ctx.userId,
        action: "customer.terms_change",
        entityType: "customer",
        entityId: args.customerId,
        before: { paymentTerms: before },
        after: { paymentTerms: args.terms, aiProposalId: ctx.proposalId },
      });
      await recordActivity({
        customerId: args.customerId,
        kind: "terms_changed",
        source: "ai_agent",
        userId: ctx.userId,
        subject: `Payment terms: ${before ?? "(none)"} -> ${args.terms}`,
        meta: { aiProposalId: ctx.proposalId },
      });
      return { ok: true };
    } catch (err) {
      log.error({ err, proposalId: ctx.proposalId }, "set_payment_terms failed");
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const DisputeTransitionArgs = z.object({
  invoiceId: z.string().max(64),
  action: z.enum(["claims_paid", "not_paid", "paid_void"]),
  note: z.string().max(2000).optional(),
});
type DisputeTransitionArgsT = z.infer<typeof DisputeTransitionArgs>;

const disputeTransitionTool: Tool<DisputeTransitionArgsT> = {
  name: "dispute_transition",
  description:
    "Move a Torah Judaica invoice through the dispute flow: claims_paid (park for bookkeeper verification), not_paid (resume chasing), or paid_void (VOIDS the invoice in QuickBooks - irreversible; requires the operator's typed confirmation).",
  argsSchema: DisputeTransitionArgs,
  execute: async (args, ctx) => {
    const result =
      args.action === "claims_paid"
        ? await disputeClaimsPaid(args.invoiceId, ctx.userId, args.note)
        : args.action === "not_paid"
          ? await disputeResolveUnpaid(args.invoiceId, ctx.userId)
          : await disputeResolvePaid(args.invoiceId, ctx.userId);
    if (result.kind === "ok") {
      return { ok: true, note: `dispute state: ${result.disputeState}` };
    }
    return { ok: false, error: result.message };
  },
};


// ── Registry ───────────────────────────────────────────────────────────
const TOOLS: Record<string, Tool> = {
  send_chase_email: sendChaseEmailTool as Tool,
  send_statement: sendStatementTool as Tool,
  send_check_in_email: sendCheckInEmailTool as Tool,
  send_bookkeeper_email: sendBookkeeperEmailTool as Tool,
  nudge_warehouse_email: nudgeWarehouseEmailTool as Tool,
  create_admin_notification: createAdminNotificationTool as Tool,
  create_task: createTaskTool as Tool,
  complete_task: completeTaskTool as Tool,
  update_customer_context: updateCustomerContextTool as Tool,
  record_interaction: recordInteractionTool as Tool,
  set_hold_status: setHoldStatusTool as Tool,
  set_payment_terms: setPaymentTermsTool as Tool,
  dispute_transition: disputeTransitionTool as Tool,
};

export function getToolByName(name: string): Tool | null {
  return TOOLS[name] ?? null;
}

export function listTools(): string[] {
  return Object.keys(TOOLS);
}
