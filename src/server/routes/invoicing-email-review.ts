// Email review — the two blind spots behind "customers say they never got
// the invoice" (see docs/superpowers/invoice-delivery-audit-2026-09-07.md):
//
//   GET  /            → { neverEmailed, deliveryFailed, dismissed, syncedAt }
//   POST /dismiss     → hide an invoice from the lists (reason required)
//   POST /restore     → un-hide
//
// Data comes from invoices.email_status / delivery_* which the QB sync
// mirrors every 30 min; no live QBO call here. Rules live in
// modules/invoice-email-review/select.ts; the SQL below is only a cheap
// superset pre-filter and MUST use the same window floor.

import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { users } from "../../db/schema/auth.js";
import { customers } from "../../db/schema/customers.js";
import {
  EMAIL_REVIEW_DISMISS_REASONS,
  invoiceEmailDismissals,
} from "../../db/schema/invoice-email-dismissals.js";
import { invoices } from "../../db/schema/invoices.js";
import { createLogger } from "../../lib/logger.js";
import {
  classifyForEmailReview,
  emailReviewWindowStart,
  isDismissalActive,
  NOT_EMAILED_STATUSES,
  type EmailReviewBucket,
} from "../../modules/invoice-email-review/select.js";
import { requireAuth } from "../lib/auth.js";

const log = createLogger({ component: "invoicing-email-review-route" });

export const dismissBodySchema = z
  .object({
    invoiceId: z.string().min(1).max(24),
    reason: z.enum(EMAIL_REVIEW_DISMISS_REASONS),
    reasonNote: z.string().max(500).optional(),
  })
  .refine((b) => b.reason !== "other" || (b.reasonNote ?? "").trim().length > 0, {
    message: "a note is required when reason is 'other'",
    path: ["reasonNote"],
  });

export const restoreBodySchema = z.object({
  invoiceId: z.string().min(1).max(24),
});

export type EmailReviewRow = {
  invoiceId: string;
  qbInvoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  origin: "feldart" | "tj";
  issueDate: string | null;
  createdAt: string;
  total: string;
  balance: string;
  status: string | null;
  emailStatus: string | null;
  deliveryTime: string | null;
  deliveryError: string | null;
  recipients: { to: string[]; cc: string[] };
  dismissal: {
    reason: (typeof EMAIL_REVIEW_DISMISS_REASONS)[number];
    reasonNote: string | null;
    dismissedAt: string;
    dismissedBy: string | null;
  } | null;
};

export type EmailReviewResponse = {
  neverEmailed: EmailReviewRow[];
  deliveryFailed: EmailReviewRow[];
  dismissed: EmailReviewRow[];
  syncedAt: string | null;
};

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const emailReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const now = new Date();
    // Same floor the classifier uses — never CURDATE(), which would be
    // evaluated in the MySQL server timezone.
    const windowStartDay = emailReviewWindowStart(now);

    const rows = await db
      .select({
        invoiceId: invoices.id,
        qbInvoiceId: invoices.qbInvoiceId,
        docNumber: invoices.docNumber,
        customerId: invoices.customerId,
        customerName: customers.displayName,
        origin: invoices.origin,
        // DATE_FORMAT → plain 'YYYY-MM-DD'. mysql2 hands DATE columns back as
        // local-midnight Date objects, which would shift the day on a
        // non-UTC host; the classifier's contract is a string day.
        issueDate: sql<string | null>`DATE_FORMAT(${invoices.issueDate}, '%Y-%m-%d')`,
        createdAt: invoices.createdAt,
        total: invoices.total,
        balance: invoices.balance,
        status: invoices.status,
        emailStatus: invoices.emailStatus,
        deliveryTime: invoices.deliveryTime,
        deliveryError: invoices.deliveryError,
        invoiceToEmails: customers.invoiceToEmails,
        invoiceCcEmails: customers.invoiceCcEmails,
        dismissReason: invoiceEmailDismissals.reason,
        dismissNote: invoiceEmailDismissals.reasonNote,
        dismissedAt: invoiceEmailDismissals.dismissedAt,
        dismissedBy: users.name,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .leftJoin(invoiceEmailDismissals, eq(invoiceEmailDismissals.invoiceId, invoices.id))
      .leftJoin(users, eq(users.id, invoiceEmailDismissals.dismissedByUserId))
      .where(
        and(
          sql`${invoices.issueDate} >= ${windowStartDay}`,
          or(
            inArray(invoices.emailStatus, [...NOT_EMAILED_STATUSES]),
            isNotNull(invoices.deliveryError),
          ),
        ),
      )
      .orderBy(asc(invoices.issueDate), desc(invoices.balance));

    const syncedRows = await db
      .select({ syncedAt: sql<string | Date | null>`MAX(${invoices.lastSyncedAt})` })
      .from(invoices);

    const out: EmailReviewResponse = {
      neverEmailed: [],
      deliveryFailed: [],
      dismissed: [],
      syncedAt: iso(syncedRows[0]?.syncedAt ?? null),
    };

    for (const r of rows) {
      // A dismissal only hides the row while it is newer than QBO's last
      // delivery attempt (isDismissalActive). Stale dismissals fall through
      // to the live buckets but keep their `dismissal` info for display.
      const dismissed =
        r.dismissReason !== null && isDismissalActive(r.dismissedAt, r.deliveryTime);
      // Classify as if not dismissed so actively-dismissed rows that would
      // otherwise qualify land in the Dismissed tab (restore path); rows
      // that no longer qualify at all are dropped regardless of dismissal.
      const bucket: EmailReviewBucket | null = classifyForEmailReview(
        {
          emailStatus: r.emailStatus,
          deliveryError: r.deliveryError,
          status: r.status,
          total: r.total,
          balance: r.balance,
          issueDate: r.issueDate,
          createdAt: r.createdAt,
          dismissedAt: null,
          deliveryTime: r.deliveryTime,
        },
        now,
      );
      if (!bucket) continue;

      const row: EmailReviewRow = {
        invoiceId: r.invoiceId,
        qbInvoiceId: r.qbInvoiceId,
        docNumber: r.docNumber,
        customerId: r.customerId,
        customerName: r.customerName,
        origin: r.origin,
        issueDate: r.issueDate,
        createdAt: iso(r.createdAt) ?? now.toISOString(),
        total: r.total,
        balance: r.balance,
        status: r.status,
        emailStatus: r.emailStatus,
        deliveryTime: iso(r.deliveryTime),
        deliveryError: r.deliveryError,
        recipients: {
          to: strings(r.invoiceToEmails),
          cc: strings(r.invoiceCcEmails),
        },
        dismissal:
          r.dismissReason && r.dismissedAt
            ? {
                reason: r.dismissReason,
                reasonNote: r.dismissNote,
                dismissedAt: iso(r.dismissedAt) ?? now.toISOString(),
                dismissedBy: r.dismissedBy,
              }
            : null,
      };

      if (dismissed) out.dismissed.push(row);
      else if (bucket === "never_emailed") out.neverEmailed.push(row);
      else out.deliveryFailed.push(row);
    }

    return reply.send(out);
  });

  app.post("/dismiss", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = dismissBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { invoiceId, reason } = parse.data;
    const reasonNote = parse.data.reasonNote?.trim() || null;

    const invoiceRows = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!invoiceRows[0]) return reply.code(404).send({ error: "invoice not found" });

    const beforeRows = await db
      .select()
      .from(invoiceEmailDismissals)
      .where(eq(invoiceEmailDismissals.invoiceId, invoiceId))
      .limit(1);
    const before = beforeRows[0] ?? null;

    const dismissedAt = new Date();
    await db
      .insert(invoiceEmailDismissals)
      .values({ invoiceId, reason, reasonNote, dismissedAt, dismissedByUserId: user.id })
      .onDuplicateKeyUpdate({
        set: { reason, reasonNote, dismissedAt, dismissedByUserId: user.id },
      });

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "invoice_email_review.dismiss",
      entityType: "invoice",
      entityId: invoiceId,
      before: before ? ({ ...before } as Record<string, unknown>) : null,
      after: {
        invoiceId,
        reason,
        reasonNote,
        dismissedAt: dismissedAt.toISOString(),
        dismissedByUserId: user.id,
      },
    });

    log.info({ invoiceId, reason, userId: user.id }, "email-review dismissed");
    return reply.send({ ok: true });
  });

  app.post("/restore", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = restoreBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { invoiceId } = parse.data;

    const beforeRows = await db
      .select()
      .from(invoiceEmailDismissals)
      .where(eq(invoiceEmailDismissals.invoiceId, invoiceId))
      .limit(1);
    const before = beforeRows[0] ?? null;
    if (!before) return reply.code(404).send({ error: "no dismissal to restore" });

    await db
      .delete(invoiceEmailDismissals)
      .where(eq(invoiceEmailDismissals.invoiceId, invoiceId));

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "invoice_email_review.restore",
      entityType: "invoice",
      entityId: invoiceId,
      before: { ...before } as Record<string, unknown>,
      after: null,
    });

    log.info({ invoiceId, userId: user.id }, "email-review dismissal restored");
    return reply.send({ ok: true });
  });
};

export default emailReviewRoutes;
