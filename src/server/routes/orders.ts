// Order hold actions (order-hold-lifecycle Phase 3). Mounted at /api/orders.
//   POST /:id/good-to-send   — release the hold + email warehouse "OK to ship"
//   POST /:id/place-on-hold  — manually put an overdue-review order on hold
//   POST /:id/manual-hold    — operator-initiated hold (internal-only by default)
//   POST /:id/cancel         — cancel in Shopify + void the QBO invoice
//   POST /:id/dismiss-review — permanently hide an overdue-review row
//   GET  /:id/hold-history   — the order's hold audit trail

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
import {
  releaseHold,
  placeOnHold,
  manualHold,
  cancelHoldOrder,
  dismissOrderReview,
  getHoldHistory,
} from "../../modules/orders/hold-actions.js";

const manualHoldBody = z.object({
  note: z.string().trim().max(500).optional(),
  customerLadder: z.boolean().optional(),
});

const ordersRoute: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>("/:id/good-to-send", async (req, reply) => {
    const user = await requireAuth(req);
    const result = await releaseHold(req.params.id, user.id);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 409;
      return reply.code(code).send({ error: result.reason });
    }
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/:id/place-on-hold", async (req, reply) => {
    const user = await requireAuth(req);
    const result = await placeOnHold(req.params.id, user.id);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 409;
      return reply.code(code).send({ error: result.reason });
    }
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/:id/manual-hold", async (req, reply) => {
    const user = await requireAuth(req);
    const parsed = manualHoldBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const result = await manualHold(req.params.id, user.id, {
      note: parsed.data.note,
      customerLadder: parsed.data.customerLadder,
    });
    if (!result.ok) {
      const code =
        result.reason === "not_found"
          ? 404
          : result.reason === "already_on_hold"
            ? 409
            : 400;
      return reply.code(code).send({ error: result.reason });
    }
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/:id/cancel", async (req, reply) => {
    const user = await requireAuth(req);
    const result = await cancelHoldOrder(req.params.id, user.id);
    if (!result.ok) {
      const code =
        result.reason === "not_found"
          ? 404
          : result.reason === "shopify_cancel_failed"
            ? 502
            : 409;
      return reply.code(code).send({ error: result.reason });
    }
    return reply.send(result);
  });

  app.post<{ Params: { id: string } }>("/:id/dismiss-review", async (req, reply) => {
    const user = await requireAuth(req);
    const result = await dismissOrderReview(req.params.id, user.id);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 409;
      return reply.code(code).send({ error: result.reason });
    }
    return reply.send({ ok: true });
  });

  app.get<{ Params: { id: string } }>("/:id/hold-history", async (req, reply) => {
    await requireAuth(req);
    const rows = await getHoldHistory(req.params.id);
    return reply.send({ rows });
  });
};

export default ordersRoute;
