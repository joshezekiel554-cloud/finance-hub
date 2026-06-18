// Order hold actions (order-hold-lifecycle Phase 3). Mounted at /api/orders.
//   POST /:id/good-to-send  — release the hold + email warehouse "OK to ship"
//   POST /:id/place-on-hold — manually put an overdue-review order on hold
//   GET  /:id/hold-history  — the order's hold audit trail

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../lib/auth.js";
import {
  releaseHold,
  placeOnHold,
  cancelHoldOrder,
  getHoldHistory,
} from "../../modules/orders/hold-actions.js";

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

  app.get<{ Params: { id: string } }>("/:id/hold-history", async (req, reply) => {
    await requireAuth(req);
    const rows = await getHoldHistory(req.params.id);
    return reply.send({ rows });
  });
};

export default ordersRoute;
