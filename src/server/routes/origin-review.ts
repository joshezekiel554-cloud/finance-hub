// Origin-review sweep.
//
// Invoices classify reliably from the docNumber prefix, but credit memos don't
// (TJ and Feldart memos can share a leading digit), so the sync flags ambiguous
// ones as origin_source='needs_review'. This route lists those for a one-time
// human pass and lets an operator override any invoice or credit memo's origin.
// Manual overrides set origin_source='manual', which the sync never clobbers.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { requireAuth } from "../lib/auth.js";

const overrideSchema = z.object({
  kind: z.enum(["invoice", "credit_memo"]),
  id: z.string().min(1).max(24),
  origin: z.enum(["feldart", "tj"]),
});

const originReviewRoute: FastifyPluginAsync = async (app) => {
  // GET /api/origin-review/needs-review — credit memos the classifier couldn't
  // confidently place. Joined to the customer name for display.
  app.get("/needs-review", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select({
        id: creditMemos.id,
        qbCreditMemoId: creditMemos.qbCreditMemoId,
        docNumber: creditMemos.docNumber,
        balance: creditMemos.balance,
        total: creditMemos.total,
        origin: creditMemos.origin,
        customerId: creditMemos.customerId,
        customerName: customers.displayName,
      })
      .from(creditMemos)
      .leftJoin(customers, eq(customers.id, creditMemos.customerId))
      .where(eq(creditMemos.originSource, "needs_review"));
    return reply.send({ creditMemos: rows });
  });

  // POST /api/origin-review/override — set an invoice or credit memo's origin
  // manually. origin_source becomes 'manual' so the sync stops re-deriving it.
  app.post("/override", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = overrideSchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { kind, id, origin } = parse.data;

    if (kind === "invoice") {
      const existing = await db
        .select({ origin: invoices.origin, originSource: invoices.originSource })
        .from(invoices)
        .where(eq(invoices.id, id))
        .limit(1);
      if (!existing[0]) return reply.code(404).send({ error: "invoice not found" });
      await db
        .update(invoices)
        .set({ origin, originSource: "manual" })
        .where(eq(invoices.id, id));
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "origin_review.invoice.override",
        entityType: "invoice",
        entityId: id,
        before: { origin: existing[0].origin, originSource: existing[0].originSource },
        after: { origin, originSource: "manual" },
      });
      return reply.send({ ok: true });
    }

    const existing = await db
      .select({
        origin: creditMemos.origin,
        originSource: creditMemos.originSource,
      })
      .from(creditMemos)
      .where(eq(creditMemos.id, id))
      .limit(1);
    if (!existing[0])
      return reply.code(404).send({ error: "credit memo not found" });
    await db
      .update(creditMemos)
      .set({ origin, originSource: "manual" })
      .where(eq(creditMemos.id, id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "origin_review.credit_memo.override",
      entityType: "credit_memo",
      entityId: id,
      before: { origin: existing[0].origin, originSource: existing[0].originSource },
      after: { origin, originSource: "manual" },
    });
    return reply.send({ ok: true });
  });
};

export default originReviewRoute;
