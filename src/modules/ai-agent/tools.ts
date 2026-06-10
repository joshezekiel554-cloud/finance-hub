// Tool registry — the canonical surface for autopilot's approved-action
// execution. Each tool is a thin shim: Zod args schema + an execute()
// that calls existing route/module logic and tags downstream rows with
// the originating ai_proposal_id for the AI provenance badge.
//
// v0 contains 5 tools wired to the 5 v0 proposal categories. The
// eventual /agent chat will extend this registry incrementally.

import { z } from "zod";
import { nanoid } from "nanoid";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { emailLog } from "../../db/schema/crm.js";
import { auditLog, chaseLog } from "../../db/schema/audit.js";
import { notifications } from "../../db/schema/notifications.js";
import { statementSends } from "../../db/schema/crm.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { appendSignatures } from "../email-compose/signatures.js";
import { sendStatement } from "../statements/send.js";
import { loadAppSettings } from "../statements/settings.js";
import { autoActionPriorInbounds } from "../crm/auto-action-emails.js";
import { linkBookkeeperThread } from "../../server/lib/bookkeeper-thread-link.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "ai-agent.tools" });

export type ToolContext = {
  userId: string;
  proposalId: string;
};

export type ToolResult = { ok: true } | { ok: false; error: string };

export type Tool<A = unknown> = {
  name: string;
  description: string;
  // Input type is `unknown` (third param) so schemas with defaults
  // (ZodDefault — e.g. send_chase_email's origin) typecheck: their input
  // type is wider than their output type A.
  argsSchema: z.ZodType<A, z.ZodTypeDef, unknown>;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>;
};

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
      if (!customer || !customer.primaryEmail) {
        return { ok: false, error: "customer or primary email missing" };
      }
      const aliasEmail = "accounts@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      const result = await sendEmail({
        to: customer.primaryEmail,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
      });
      // Insert email_log row with ai_proposal_id linkage.
      // (sendEmail itself doesn't write to email_log — that's done by the
      // gmail poller's outbound classification. We pre-write here so the
      // AI provenance badge lights up immediately on the customer page.)
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
        toAddress: customer.primaryEmail,
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
      // chase_log row — drives the 7-day-no-chase dedup in chase-next
      // candidate finder.
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
      if (!customer || !customer.primaryEmail) {
        return { ok: false, error: "customer or primary email missing" };
      }
      const aliasEmail = "accounts@feldart.com";
      const finalHtml = await appendSignatures(db, {
        bodyHtml: args.body,
        userId: ctx.userId,
        aliasEmail,
      });
      const result = await sendEmail({
        to: customer.primaryEmail,
        subject: args.subject,
        html: finalHtml,
        alias: aliasEmail,
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
        toAddress: customer.primaryEmail,
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

      // Pre-write the email_log row (the gmail poller would also pick it up
      // later). Besides lighting up the AI provenance badge, this row is
      // what resets the dispute-nudge silence clock immediately — the
      // candidate finder reads latest email_log per bookkeeper thread.
      const sentAt = new Date();
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

// ── Registry ───────────────────────────────────────────────────────────
const TOOLS: Record<string, Tool> = {
  send_chase_email: sendChaseEmailTool as Tool,
  send_statement: sendStatementTool as Tool,
  send_check_in_email: sendCheckInEmailTool as Tool,
  send_bookkeeper_email: sendBookkeeperEmailTool as Tool,
  nudge_warehouse_email: nudgeWarehouseEmailTool as Tool,
  create_admin_notification: createAdminNotificationTool as Tool,
};

export function getToolByName(name: string): Tool | null {
  return TOOLS[name] ?? null;
}

export function listTools(): string[] {
  return Object.keys(TOOLS);
}
