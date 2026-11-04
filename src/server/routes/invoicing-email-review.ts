// Email review — the two blind spots behind "customers say they never got
// the invoice" (see docs/superpowers/invoice-delivery-audit-2026-09-07.md):
//
//   GET  /            → { neverEmailed, deliveryFailed, dismissed, syncedAt }
//   POST /dismiss     → hide an invoice from the lists (reason required).
//                       Returns { ok, hidden } — `hidden` is false when the
//                       dismissal cannot take effect yet (an undated bounce
//                       can never be hidden, see isDismissalActive).
//   POST /restore     → un-hide. Idempotent: { ok, restored } is
//                       { ok: true, restored: false } when there was nothing
//                       to restore, and no audit row is written.
//
// Data comes from invoices.email_status / delivery_* which the QB sync
// mirrors every 30 min; no live QBO call here. Rules live in
// modules/invoice-email-review/ — classification in select.ts, bucketing in
// bucket.ts — so this file is a query plus a call. The SQL below is only a
// cheap superset pre-filter and MUST use the same window floor.

import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  EMAIL_REVIEW_DISMISS_REASONS,
  invoiceEmailDismissals,
} from "../../db/schema/invoice-email-dismissals.js";
import { invoices } from "../../db/schema/invoices.js";
import { createLogger } from "../../lib/logger.js";
import { isDismissalActive } from "../../modules/invoice-email-review/index.js";
import { loadEmailReview } from "../../modules/invoice-email-review/load.js";
import { requireAuth } from "../lib/auth.js";

export type {
  EmailReviewResponse,
  EmailReviewRow,
} from "../../modules/invoice-email-review/index.js";

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

const emailReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    return reply.send(await loadEmailReview(new Date()));
  });

  app.post("/dismiss", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = dismissBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { invoiceId, reason } = parse.data;
    const reasonNote = parse.data.reasonNote?.trim() || null;

    // deliveryTime/deliveryError come back with the existence check so the
    // response can tell the operator whether the dismissal actually hides
    // the row (an undated bounce never can).
    const invoiceRows = await db
      .select({
        id: invoices.id,
        deliveryTime: invoices.deliveryTime,
        deliveryError: invoices.deliveryError,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    const invoice = invoiceRows[0];
    if (!invoice) return reply.code(404).send({ error: "invoice not found" });

    const dismissedAt = new Date();
    await db.transaction(async (tx) => {
      const beforeRows = await tx
        .select()
        .from(invoiceEmailDismissals)
        .where(eq(invoiceEmailDismissals.invoiceId, invoiceId))
        .limit(1);
      const before = beforeRows[0] ?? null;

      await tx
        .insert(invoiceEmailDismissals)
        .values({ invoiceId, reason, reasonNote, dismissedAt, dismissedByUserId: user.id })
        .onDuplicateKeyUpdate({
          set: { reason, reasonNote, dismissedAt, dismissedByUserId: user.id },
        });

      await tx.insert(auditLog).values({
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
    });

    const hidden = isDismissalActive(
      dismissedAt,
      invoice.deliveryTime,
      invoice.deliveryError,
    );
    log.info({ invoiceId, reason, hidden, userId: user.id }, "email-review dismissed");
    return reply.send({ ok: true, hidden });
  });

  app.post("/restore", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = restoreBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { invoiceId } = parse.data;

    // Idempotent: a second Restore (or one racing another operator's) is a
    // no-op, not a 404 — and writes no audit row, since nothing changed.
    const restored = await db.transaction(async (tx) => {
      const beforeRows = await tx
        .select()
        .from(invoiceEmailDismissals)
        .where(eq(invoiceEmailDismissals.invoiceId, invoiceId))
        .limit(1);
      const before = beforeRows[0] ?? null;
      if (!before) return false;

      await tx
        .delete(invoiceEmailDismissals)
        .where(eq(invoiceEmailDismissals.invoiceId, invoiceId));

      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "invoice_email_review.restore",
        entityType: "invoice",
        entityId: invoiceId,
        before: { ...before } as Record<string, unknown>,
        after: null,
      });
      return true;
    });

    log.info({ invoiceId, restored, userId: user.id }, "email-review dismissal restored");
    return reply.send({ ok: true, restored });
  });
};

export default emailReviewRoutes;
