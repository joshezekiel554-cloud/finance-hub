// Notifications API. Backs the bell dropdown on the app header.
//
// Endpoints (all auth-gated, all scoped to the current user):
//   GET  /api/notifications              — list (filterable by unread)
//   GET  /api/notifications/unread-count — bell badge value
//   POST /api/notifications/mark-read    — { id?: string }
//                                          omit id to mark all read
//
// Sorted newest first. The list is generally short (an operator clears
// it daily) so we cap at 50 by default; clients can request up to 200.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { notifications } from "../../db/schema/notifications.js";
import { requireAuth } from "../lib/auth.js";

const listQuerySchema = z.object({
  filter: z.enum(["unread", "all"]).default("unread"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const markReadBodySchema = z.object({
  id: z.string().min(1).max(24).optional(),
});

const notificationsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { filter, limit } = parse.data;

    const filters = [eq(notifications.userId, user.id)];
    if (filter === "unread") filters.push(isNull(notifications.readAt));

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return reply.send({
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        customerId: r.customerId,
        refType: r.refType,
        refId: r.refId,
        payload: r.payload,
        readAt: r.readAt ? r.readAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });

  app.get("/unread-count", async (req, reply) => {
    const user = await requireAuth(req);
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(eq(notifications.userId, user.id), isNull(notifications.readAt)),
      );
    return reply.send({ count: Number(rows[0]?.count ?? 0) });
  });

  app.post("/mark-read", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = markReadBodySchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { id } = parse.data;

    const now = new Date();
    if (id) {
      // Single-row mark. Match on user too so an operator can't mark
      // someone else's notification read by guessing an id.
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.userId, user.id),
            isNull(notifications.readAt),
          ),
        );
    } else {
      // Mark-all. Single UPDATE — bounded by the user's unread set.
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.userId, user.id),
            isNull(notifications.readAt),
          ),
        );
    }
    return reply.send({ ok: true });
  });
};

export default notificationsRoute;
