// Tool registry — the canonical surface for autopilot's approved-action
// execution. Each tool is a thin shim: Zod args schema + an execute()
// that calls existing route/module logic and tags downstream rows with
// the originating ai_proposal_id for the AI provenance badge.
//
// v0 contains 5 tools wired to the 5 v0 proposal categories. The
// eventual /agent chat will extend this registry incrementally.

import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog } from "../../db/schema/crm.js";
import { chaseLog } from "../../db/schema/audit.js";
import { notifications } from "../../db/schema/notifications.js";
import { statementSends } from "../../db/schema/crm.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { appendSignatures } from "../email-compose/signatures.js";
import { sendStatement } from "../statements/send.js";
import { autoActionPriorInbounds } from "../crm/auto-action-emails.js";
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
  argsSchema: z.ZodType<A>;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>;
};

// ── send_chase_email ───────────────────────────────────────────────────
const SendChaseEmailArgs = z.object({
  customerId: z.string().min(1).max(24),
  tier: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
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
        notes: `Autopilot chase ${args.tier}`,
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
  nudge_warehouse_email: nudgeWarehouseEmailTool as Tool,
  create_admin_notification: createAdminNotificationTool as Tool,
};

export function getToolByName(name: string): Tool | null {
  return TOOLS[name] ?? null;
}

export function listTools(): string[] {
  return Object.keys(TOOLS);
}
