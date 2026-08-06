// Order hold actions (order-hold-lifecycle Phase 3). Mounted at /api/orders.
//   POST /:id/good-to-send   — release the hold + email warehouse "OK to ship"
//   POST /:id/place-on-hold  — manually put an overdue-review order on hold
//   POST /:id/manual-hold    — operator-initiated hold (internal-only by default)
//   POST /:id/pause-ladder   — stop chasing this order until a date (or resume)
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
  pauseHoldLadder,
} from "../../modules/orders/hold-actions.js";

const manualHoldBody = z.object({
  note: z.string().trim().max(500).optional(),
  customerLadder: z.boolean().optional(),
});

// "Stop chasing this order until <date>" — null resumes immediately.
// The date is a plain YYYY-MM-DD from the picker; we pause until the END of
// that day in New York (where the warehouse is), so "paying Wednesday" means
// nothing goes out on Wednesday itself.
const pauseLadderBody = z.object({
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .nullable(),
  note: z.string().trim().max(300).optional(),
});

function endOfDayNewYork(ymd: string): Date | null {
  // -04:00 in summer, -05:00 in winter. Using 23:59 local means the pause
  // covers the whole promised day either way; an hour of DST slop at the
  // boundary costs nothing here (worst case the ladder resumes an hour late).
  const d = new Date(`${ymd}T23:59:00-04:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

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

  // Pause / resume the customer chase ladder on a held order.
  app.post<{ Params: { id: string } }>("/:id/pause-ladder", async (req, reply) => {
    const user = await requireAuth(req);
    const parsed = pauseLadderBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const until = parsed.data.until ? endOfDayNewYork(parsed.data.until) : null;
    if (parsed.data.until && !until) {
      return reply.code(400).send({ error: "invalid_date" });
    }
    const result = await pauseHoldLadder(req.params.id, user.id, {
      until,
      note: parsed.data.note,
    });
    if (!result.ok) {
      const code =
        result.reason === "not_found"
          ? 404
          : result.reason === "not_on_hold"
            ? 409
            : 400;
      return reply.code(code).send({ error: result.reason });
    }
    return reply.send({ ok: true, pausedUntil: until?.toISOString() ?? null });
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
