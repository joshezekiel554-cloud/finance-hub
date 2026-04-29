// Customers API. List + filter + bulk-tag for the B2B sweep, plus a
// per-customer GET that the detail page (Task #5) extends with related
// data (recent activities, open invoices, tasks).
//
// All routes require auth. Mutations write to audit_log via the existing
// pattern from invoicing routes — we don't have a transaction wrapper
// helper yet so writes are sequential, not atomic. Acceptable for now;
// audit-log atomicity gets a dedicated pass in week 8 alongside
// notifications fan-out.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { activities } from "../../db/schema/crm.js";
import { auditLog } from "../../db/schema/audit.js";
import { nanoid } from "nanoid";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.customers" });

const listQuerySchema = z.object({
  q: z.string().max(100).optional(),
  customerType: z.enum(["b2b", "b2c", "uncategorized", "all"]).default("b2b"),
  holdStatus: z.enum(["active", "hold", "all"]).default("all"),
  withBalance: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === true || v === "true"),
  sort: z
    .enum(["displayName", "balance", "overdueBalance", "lastSyncedAt"])
    .default("displayName"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const bulkTagBodySchema = z.object({
  ids: z.array(z.string().min(1).max(24)).min(1).max(2500),
  customerType: z.enum(["b2b", "b2c"]).nullable(),
});

const patchBodySchema = z.object({
  customerType: z.enum(["b2b", "b2c"]).nullable().optional(),
  holdStatus: z.enum(["active", "hold"]).optional(),
  internalNotes: z.string().max(10_000).optional(),
});

const customersRoute: FastifyPluginAsync = async (app) => {
  // GET /api/customers — paginated list with search + filters. The
  // shape is hand-tuned for the customers table page: includes
  // counts for the filter chips and the uncategorized banner so the
  // page only needs one round trip on initial load.
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { q, customerType, holdStatus, withBalance, sort, dir, limit, offset } =
      parse.data;

    const filters = [];
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      filters.push(
        or(like(customers.displayName, term), like(customers.primaryEmail, term)),
      );
    }
    if (customerType === "b2b") filters.push(eq(customers.customerType, "b2b"));
    else if (customerType === "b2c") filters.push(eq(customers.customerType, "b2c"));
    else if (customerType === "uncategorized") filters.push(isNull(customers.customerType));
    // "all" → no filter

    if (holdStatus !== "all") {
      filters.push(eq(customers.holdStatus, holdStatus));
    }
    if (withBalance) {
      filters.push(gt(customers.balance, "0"));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const sortCol = {
      displayName: customers.displayName,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
      lastSyncedAt: customers.lastSyncedAt,
    }[sort];
    const orderFn = dir === "asc" ? asc : desc;

    const rowsPromise = db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        primaryEmail: customers.primaryEmail,
        balance: customers.balance,
        overdueBalance: customers.overdueBalance,
        holdStatus: customers.holdStatus,
        customerType: customers.customerType,
        paymentTerms: customers.paymentTerms,
        lastSyncedAt: customers.lastSyncedAt,
      })
      .from(customers)
      .where(where)
      .orderBy(orderFn(sortCol), asc(customers.id))
      .limit(limit + 1) // +1 to detect hasMore without a separate count
      .offset(offset);

    // Counts for the filter chips. Done in parallel with the rows query.
    const totalsPromise = db
      .select({
        b2b: sql<number>`SUM(CASE WHEN customer_type = 'b2b' THEN 1 ELSE 0 END)`,
        b2c: sql<number>`SUM(CASE WHEN customer_type = 'b2c' THEN 1 ELSE 0 END)`,
        uncategorized: sql<number>`SUM(CASE WHEN customer_type IS NULL THEN 1 ELSE 0 END)`,
        all: sql<number>`COUNT(*)`,
      })
      .from(customers);

    const [rowsRaw, totalsRaw] = await Promise.all([rowsPromise, totalsPromise]);
    const rows = rowsRaw.slice(0, limit);
    const hasMore = rowsRaw.length > limit;
    const totals = totalsRaw[0] ?? { b2b: 0, b2c: 0, uncategorized: 0, all: 0 };

    return reply.send({
      rows,
      hasMore,
      totals: {
        b2b: Number(totals.b2b ?? 0),
        b2c: Number(totals.b2c ?? 0),
        uncategorized: Number(totals.uncategorized ?? 0),
        all: Number(totals.all ?? 0),
      },
    });
  });

  // PATCH /api/customers/bulk-tag — set customer_type for many at once.
  // Used by the sweep UI. Audit-logs each change individually so we can
  // trace who tagged whom.
  app.patch("/bulk-tag", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = bulkTagBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { ids, customerType } = parse.data;

    const before = await db
      .select({ id: customers.id, customerType: customers.customerType })
      .from(customers)
      .where(inArray(customers.id, ids));

    await db
      .update(customers)
      .set({ customerType })
      .where(inArray(customers.id, ids));

    // Bulk audit-log insert. One row per customer changed (skip rows
    // where the value didn't actually change — saves audit noise).
    const auditRows = before
      .filter((r) => r.customerType !== customerType)
      .map((r) => ({
        id: nanoid(24),
        userId: user.id,
        action: "customer.bulk_tag" as const,
        entityType: "customer" as const,
        entityId: r.id,
        before: { customerType: r.customerType },
        after: { customerType },
      }));
    if (auditRows.length > 0) {
      await db.insert(auditLog).values(auditRows);
    }

    log.info(
      { userId: user.id, count: ids.length, changed: auditRows.length, customerType },
      "bulk-tagged customers",
    );

    return reply.send({ updated: auditRows.length, total: ids.length });
  });

  // GET /api/customers/:id — full record for the detail page. Returns
  // the customer plus a few related rollups: recent activities, open
  // invoice summary, open task count. Detail page can request more via
  // /api/customers/:id/activities (paginated).
  app.get("/:id", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const rows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const customer = rows[0];
    if (!customer) return reply.code(404).send({ error: "customer not found" });

    // Recent activities — first 50, sorted newest first. The full
    // timeline UI paginates via cursor; this is the seed.
    const recentActivities = await db
      .select()
      .from(activities)
      .where(eq(activities.customerId, id))
      .orderBy(desc(activities.occurredAt))
      .limit(50);

    return reply.send({ customer, recentActivities });
  });

  // PATCH /api/customers/:id — single-customer update. Used from the
  // detail page header (hold toggle, terms edit, customer_type flip)
  // and from the customers list row-level "Mark B2B" actions.
  app.patch("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const updates = parse.data;
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "no fields to update" });
    }

    const beforeRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "customer not found" });

    await db.update(customers).set(updates).where(eq(customers.id, id));

    const afterRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const after = afterRows[0]!;

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "customer.update",
      entityType: "customer",
      entityId: id,
      before,
      after,
    });

    return reply.send({ customer: after });
  });
};

export default customersRoute;
