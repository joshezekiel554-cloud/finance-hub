// Cross-customer statements audit log. Backs the /statements page —
// every row in statement_sends, joined to customers + users so the
// table can render names without a follow-up fetch.
//
// Two endpoints:
//   GET /api/statement-sends            — paginated list with filters
//   GET /api/statement-sends/senders    — distinct user list for the
//                                          sender filter dropdown
//
// Filters:
//   fromDate / toDate — ISO date range on sentAt (toDate is exclusive
//                       so callers can pass YYYY-MM-DD without
//                       worrying about the day boundary)
//   customerId        — narrow to one customer
//   sentByUserId      — narrow to one operator
//   statementType     — open_items / balance_forward / all (default all)
//
// Sorting is fixed to sentAt DESC — this is an audit trail, not a
// tunable list view. Pagination via limit/offset.
//
// Auth-gated like every other admin endpoint.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { statementSends } from "../../db/schema/crm.js";
import { customers } from "../../db/schema/customers.js";
import { users } from "../../db/schema/auth.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.statement-sends" });

const listQuerySchema = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customerId: z.string().min(1).max(24).optional(),
  sentByUserId: z.string().min(1).max(255).optional(),
  statementType: z
    .enum(["open_items", "balance_forward", "all"])
    .default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const statementSendsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { fromDate, toDate, customerId, sentByUserId, statementType, limit, offset } =
      parse.data;

    const filters = [];
    if (fromDate) {
      filters.push(gte(statementSends.sentAt, new Date(`${fromDate}T00:00:00Z`)));
    }
    if (toDate) {
      // Exclusive upper bound: toDate=2026-04-30 → up to (not including)
      // 2026-05-01T00:00 UTC. Lets the UI treat the picker as inclusive.
      const upper = new Date(`${toDate}T00:00:00Z`);
      upper.setUTCDate(upper.getUTCDate() + 1);
      filters.push(lt(statementSends.sentAt, upper));
    }
    if (customerId) filters.push(eq(statementSends.customerId, customerId));
    if (sentByUserId) filters.push(eq(statementSends.sentByUserId, sentByUserId));
    if (statementType !== "all") {
      filters.push(eq(statementSends.statementType, statementType));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: statementSends.id,
          sentAt: statementSends.sentAt,
          statementNumber: statementSends.statementNumber,
          statementType: statementSends.statementType,
          sentToEmail: statementSends.sentToEmail,
          customerId: statementSends.customerId,
          customerName: customers.displayName,
          sentByUserId: statementSends.sentByUserId,
          sentByName: users.name,
          sentByEmail: users.email,
        })
        .from(statementSends)
        .leftJoin(customers, eq(statementSends.customerId, customers.id))
        .leftJoin(users, eq(statementSends.sentByUserId, users.id))
        .where(where)
        .orderBy(desc(statementSends.sentAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(statementSends)
        .where(where),
    ]);

    const total = Number(totalRows[0]?.count ?? 0);

    return reply.send({
      rows: rows.map((r) => ({
        id: r.id,
        sentAt: r.sentAt.toISOString(),
        statementNumber: r.statementNumber,
        statementType: r.statementType,
        sentToEmail: r.sentToEmail,
        customerId: r.customerId,
        customerName: r.customerName,
        sentByUserId: r.sentByUserId,
        sentByName: r.sentByName,
        sentByEmail: r.sentByEmail,
      })),
      total,
      limit,
      offset,
    });
  });

  // Distinct senders — drives the sender dropdown filter on the page.
  // Done as a DB-side DISTINCT so we never ship one row per send across
  // the wire just to populate a small list.
  app.get("/senders", async (req, reply) => {
    await requireAuth(req);
    try {
      const rows = await db
        .selectDistinct({
          userId: statementSends.sentByUserId,
          name: users.name,
          email: users.email,
        })
        .from(statementSends)
        .leftJoin(users, eq(statementSends.sentByUserId, users.id))
        .orderBy(users.name);
      return reply.send({
        senders: rows
          .filter((r) => r.userId !== null)
          .map((r) => ({
            id: r.userId as string,
            name: r.name,
            email: r.email,
          })),
      });
    } catch (err) {
      log.error({ err }, "senders fetch failed");
      return reply.code(500).send({ error: "senders fetch failed" });
    }
  });
};

export default statementSendsRoute;
