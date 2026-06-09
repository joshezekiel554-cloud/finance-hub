// TJ dispute lifecycle endpoints.
//
// A TJ invoice a customer claims to have paid is parked (dispute_state=
// 'verifying') out of the active chase while we check with the Torah Judaica
// bookkeeper. Resolution is either "confirmed unpaid" (resume chasing) or
// "confirmed paid" (void it in QBO, which zeroes the balance and stamps the
// doc Voided). Local-only state except the eventual QBO void.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { invoices } from "../../db/schema/invoices.js";
import { QboClient } from "../../integrations/qb/client.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.disputes" });

const claimsPaidSchema = z.object({
  note: z.string().max(2000).optional(),
});

async function loadInvoice(id: string) {
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return rows[0] ?? null;
}

const disputesRoute: FastifyPluginAsync = async (app) => {
  // POST /:id/dispute/claims-paid — park a TJ invoice for verification.
  app.post("/:id/dispute/claims-paid", async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    const parse = claimsPaidSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const inv = await loadInvoice(id);
    if (!inv) return reply.code(404).send({ error: "invoice not found" });
    if (inv.origin !== "tj") {
      return reply.code(400).send({
        error: "dispute flow is TJ-only",
        code: "not_tj",
      });
    }
    if (inv.status === "void" || inv.disputeState === "confirmed_paid") {
      return reply
        .code(409)
        .send({ error: "invoice already resolved/void", code: "already_resolved" });
    }

    const now = new Date();
    await db
      .update(invoices)
      .set({
        disputeState: "verifying",
        disputeClaimedAt: now,
        disputeNote: parse.data.note ?? null,
        disputeUpdatedBy: user.id,
      })
      .where(eq(invoices.id, id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "dispute.claims_paid",
      entityType: "invoice",
      entityId: id,
      before: { disputeState: inv.disputeState },
      after: { disputeState: "verifying", disputeNote: parse.data.note ?? null },
    });
    return reply.send({ ok: true, disputeState: "verifying" });
  });

  // POST /:id/dispute/resolve-unpaid — confirmed still owed; resume chasing.
  app.post("/:id/dispute/resolve-unpaid", async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    const inv = await loadInvoice(id);
    if (!inv) return reply.code(404).send({ error: "invoice not found" });
    if (inv.status === "void" || inv.disputeState === "confirmed_paid") {
      return reply
        .code(409)
        .send({ error: "invoice already resolved/void", code: "already_resolved" });
    }

    await db
      .update(invoices)
      .set({ disputeState: "confirmed_unpaid", disputeUpdatedBy: user.id })
      .where(eq(invoices.id, id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "dispute.resolve_unpaid",
      entityType: "invoice",
      entityId: id,
      before: { disputeState: inv.disputeState },
      after: { disputeState: "confirmed_unpaid" },
    });
    return reply.send({ ok: true, disputeState: "confirmed_unpaid" });
  });

  // POST /:id/dispute/resolve-paid — confirmed paid to TJ; void it in QBO,
  // then soft-void locally + stamp confirmed_paid. If the QBO write fails we
  // leave all state untouched and surface a 502 so the operator can retry.
  app.post("/:id/dispute/resolve-paid", async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    const inv = await loadInvoice(id);
    if (!inv) return reply.code(404).send({ error: "invoice not found" });
    if (inv.status === "void") {
      return reply.code(400).send({ error: "invoice already void" });
    }
    // The spec flow voids out of 'verifying' (claims-paid first). Refuse to
    // void an invoice that was never parked, so the QBO write only ever
    // happens off a deliberate dispute.
    if (inv.disputeState !== "verifying") {
      return reply.code(409).send({
        error: "invoice is not parked for verification",
        code: "not_verifying",
      });
    }
    if (!inv.syncToken) {
      return reply.code(409).send({
        error: "invoice missing syncToken; run a QB sync first",
        code: "no_sync_token",
      });
    }

    let voidedSyncToken = inv.syncToken;
    try {
      const qb = new QboClient();
      const voided = await qb.voidInvoice(inv.qbInvoiceId, inv.syncToken);
      // Persist QBO's new SyncToken so a write before the next sync won't 409.
      if (voided?.SyncToken) voidedSyncToken = voided.SyncToken;
    } catch (err) {
      log.error(
        { invoice_id: id, qb_invoice_id: inv.qbInvoiceId, err: (err as Error).message },
        "QBO void failed during dispute resolution",
      );
      return reply.code(502).send({
        error: "QuickBooks void failed; nothing changed. Try again.",
        code: "qbo_void_failed",
      });
    }

    await db
      .update(invoices)
      .set({
        status: "void",
        balance: "0",
        disputeState: "confirmed_paid",
        disputeUpdatedBy: user.id,
        syncToken: voidedSyncToken,
        lastSyncedAt: new Date(),
      })
      .where(eq(invoices.id, id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "dispute.void_qbo",
      entityType: "invoice",
      entityId: id,
      before: {
        status: inv.status,
        balance: inv.balance,
        disputeState: inv.disputeState,
      },
      after: { status: "void", balance: "0", disputeState: "confirmed_paid" },
    });
    return reply.send({ ok: true, disputeState: "confirmed_paid" });
  });
};

export default disputesRoute;
