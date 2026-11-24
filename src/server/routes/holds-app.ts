// Hold Orders API — mounted at /api/holds. Served on every host, but built
// for holdorders.feldart.com. Auth: finance session + Hold Orders role
// (requireHoldsAccess); holds-only accounts (HOLDORDERS_EMAILS) can use
// these and nothing else in finance.
//
//   GET    /me                          who am I + role + permissions (200 even signed-out)
//   GET    /                            board rows (?status=&search=&cursor=&limit=) + counts
//   GET    /find?q=                     find any order by number (to hold manually)
//   GET    /rules                       list explicit customer rules
//   GET    /rules/customers?q=          customer search for the rules editor   [editRules]
//   POST   /rules/preview               {customerId, rule} → orders it'd hold    [editRules]
//   GET    /rules/:customerId           one customer's rule (or null)
//   PUT    /rules/:customerId           set rule                                 [editRules]
//   DELETE /rules/:customerId           remove rule                              [editRules]
//   GET    /:orderId                    one row + history timeline
//   GET    /:orderId/preview            exactly who an action would email
//   POST   /:orderId/hold               {reason, note?, startLadder, mode}
//   POST   /:orderId/release            {mode, paidOutsideQbo?, note?}
//   POST   /:orderId/pause              {until: YYYY-MM-DD, note?}
//   DELETE /:orderId/pause              resume the ladder now
//   POST   /:orderId/note               {note}

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { like, or, eq, desc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { env } from "../../lib/env.js";
import { requireHoldsAccess, holdsRoleForUser } from "../lib/holds-auth.js";
import { getCurrentUser } from "../lib/auth.js";
import { HOLDS_ROLE_PERMISSIONS, can } from "../../modules/hold-orders/permissions.js";
import { loadHoldBoard } from "../../modules/hold-orders/board.js";
import { HOLD_TABS, decodeCursor, matchesSearch } from "../../modules/hold-orders/board-classify.js";
import { getHoldTimeline } from "../../modules/hold-orders/timeline.js";
import {
  addHoldNote,
  holdOrder,
  pauseOrder,
  previewAction,
  releaseOrder,
  type ActionResult,
} from "../../modules/hold-orders/actions.js";
import { HOLD_RULE_PRESETS, resolveHoldRule } from "../../modules/hold-orders/presets.js";
import { deleteRule, getRule, listRules, previewRule, upsertRule } from "../../modules/hold-orders/rules-store.js";
import { endOfDayNewYork } from "../../modules/hold-orders/dates.js";

const modeSchema = z.enum(["notify", "record_only"]);

const holdBody = z.object({
  reason: z.enum(["manual", "overdue_non_communicating"]).default("manual"),
  note: z.string().trim().max(500).optional(),
  startLadder: z.boolean().default(false),
  mode: modeSchema,
});

const releaseBody = z.object({
  mode: modeSchema,
  note: z.string().trim().max(500).optional(),
  paidOutsideQbo: z
    .object({
      method: z.enum(["cheque", "stripe", "bank", "other"]),
      note: z.string().trim().min(1, "Say how it was paid").max(500),
    })
    .optional(),
});

const pauseBody = z.object({
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  note: z.string().trim().max(300).optional(),
});

const noteBody = z.object({ note: z.string().trim().min(1).max(1000) });

const ruleBody = z.object({
  preset: z.enum(HOLD_RULE_PRESETS),
  termsDays: z.number().int().nullable().optional(),
  holdWhenInvoiceDaysOver: z.number().int().nullable().optional(),
  minBalance: z.number().nullable().optional(),
  autoStartLadder: z.boolean().default(false),
  autoReleaseOnPayment: z.boolean().default(true),
  notifyWarehouse: z.boolean().default(true),
  note: z.string().max(500).nullable().optional(),
});

const previewQuery = z.object({
  action: z.enum(["hold", "release"]),
  mode: modeSchema,
  reason: z.enum(["manual", "overdue_non_communicating"]).default("manual"),
  startLadder: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  note: z.string().max(500).optional(),
});

const listQuery = z.object({
  status: z.enum(HOLD_TABS).default("held"),
  search: z.string().max(100).optional(),
  cursor: z.string().max(12).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function sendResult(reply: FastifyReply, r: ActionResult) {
  if (r.ok) return reply.send(r);
  const code = r.reason === "not_found" ? 404 : r.reason.endsWith("_required") || r.reason === "empty_note" || r.reason === "pause_date_in_past" ? 400 : 409;
  return reply.code(code).send({ error: r.reason });
}

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({ error: "invalid body", details: err.flatten() });
}

const holdsAppRoute: FastifyPluginAsync = async (app) => {
  app.get("/me", async (req, reply) => {
    const user = await getCurrentUser(req);
    const role = holdsRoleForUser(user);
    return reply.send({
      user: user ? { id: user.id, email: user.email, name: user.name, image: user.image } : null,
      role,
      permissions: role ? HOLDS_ROLE_PERMISSIONS[role] : null,
      hubUrl: env.HUB_PARENT_ORIGIN,
      financeUrl: role && can(role, "financeLinks") ? env.PUBLIC_URL : null,
      shadowMode: env.SHADOW_MODE,
    });
  });

  app.get("/", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "view");
    if (!access) return;
    const q = listQuery.safeParse(req.query);
    if (!q.success) return badRequest(reply, q.error);
    const board = await loadHoldBoard({
      seeBalances: can(access.role, "seeBalances"),
      financeLinks: can(access.role, "financeLinks"),
    });
    const filtered = board.rows
      .filter((r) => r.tabs.includes(q.data.status))
      .filter((r) => matchesSearch(r, q.data.search ?? ""));
    const start = decodeCursor(q.data.cursor);
    const page = filtered.slice(start, start + q.data.limit);
    const next = start + q.data.limit < filtered.length ? String(start + q.data.limit) : null;
    return reply.send({
      rows: page,
      total: filtered.length,
      nextCursor: next,
      counts: board.counts,
      generatedAt: board.generatedAt,
    });
  });

  app.get<{ Querystring: { q?: string } }>("/find", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "view");
    if (!access) return;
    const raw = (req.query.q ?? "").trim().replace(/^#/, "");
    if (raw.length < 2) return reply.send({ orders: [] });
    const rows = await db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        shopifyOrderId: orders.shopifyOrderId,
        orderDate: orders.orderDate,
        total: orders.total,
        holdState: orders.holdState,
        customerName: customers.displayName,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .where(or(like(orders.orderNumber, `%${raw}%`), eq(orders.shopifyOrderId, raw)))
      .orderBy(desc(orders.orderDate))
      .limit(10);
    return reply.send({ orders: rows });
  });

  // ---- rules ---------------------------------------------------------------

  app.get("/rules", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "view");
    if (!access) return;
    return reply.send({ rules: await listRules(), canEdit: can(access.role, "editRules") });
  });

  app.get<{ Querystring: { q?: string } }>("/rules/customers", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "editRules");
    if (!access) return;
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return reply.send({ customers: [] });
    const rows = await db
      .select({
        id: customers.id,
        name: customers.displayName,
        paymentTerms: customers.paymentTerms,
        balance: customers.balance,
        overdueBalance: customers.overdueBalance,
        holdStatus: customers.holdStatus,
      })
      .from(customers)
      .where(like(customers.displayName, `%${q}%`))
      .orderBy(customers.displayName)
      .limit(20);
    return reply.send({ customers: rows });
  });

  app.post("/rules/preview", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "editRules");
    if (!access) return;
    const parsed = z
      .object({ customerId: z.string().min(1).max(24), rule: ruleBody })
      .safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const resolved = resolveHoldRule(parsed.data.rule);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    const preview = await previewRule(parsed.data.customerId, resolved.rule);
    return reply.send({ rule: resolved.rule, ...preview });
  });

  app.get<{ Params: { customerId: string } }>("/rules/:customerId", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "view");
    if (!access) return;
    return reply.send({ rule: await getRule(req.params.customerId), canEdit: can(access.role, "editRules") });
  });

  app.put<{ Params: { customerId: string } }>("/rules/:customerId", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "editRules");
    if (!access) return;
    const parsed = ruleBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const resolved = resolveHoldRule(parsed.data);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    const r = await upsertRule({
      customerId: req.params.customerId,
      rule: resolved.rule,
      userId: access.user.id,
      actorEmail: access.user.email,
    });
    if (!r.ok) return reply.code(404).send({ error: r.reason });
    return reply.send({ ok: true, rule: await getRule(req.params.customerId) });
  });

  app.delete<{ Params: { customerId: string } }>("/rules/:customerId", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "editRules");
    if (!access) return;
    const r = await deleteRule({
      customerId: req.params.customerId,
      userId: access.user.id,
      actorEmail: access.user.email,
    });
    return reply.send(r);
  });

  // ---- one order -------------------------------------------------------------

  app.get<{ Params: { orderId: string } }>("/:orderId", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "view");
    if (!access) return;
    const board = await loadHoldBoard({
      seeBalances: can(access.role, "seeBalances"),
      financeLinks: can(access.role, "financeLinks"),
      extraOrderIds: [req.params.orderId],
    });
    const row = board.rows.find((r) => r.orderId === req.params.orderId);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.send({ row, timeline: await getHoldTimeline(req.params.orderId) });
  });

  app.get<{ Params: { orderId: string } }>("/:orderId/preview", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "view");
    if (!access) return;
    const q = previewQuery.safeParse(req.query);
    if (!q.success) return badRequest(reply, q.error);
    const result = await previewAction(
      req.params.orderId,
      q.data.action === "hold"
        ? {
            action: "hold",
            opts: {
              reason: q.data.reason,
              note: q.data.note ?? null,
              startLadder: q.data.startLadder,
              mode: q.data.mode,
            },
          }
        : { action: "release", mode: q.data.mode },
    );
    if (!result) return reply.code(404).send({ error: "not_found" });
    return reply.send(result);
  });

  app.post<{ Params: { orderId: string } }>("/:orderId/hold", async (req, reply) => {
    const parsed = holdBody.safeParse(req.body);
    const access = await requireHoldsAccess(req, reply, "hold");
    if (!access) return;
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (parsed.data.mode === "record_only" && !can(access.role, "recordOnly")) {
      return reply.code(403).send({ error: "forbidden", permission: "recordOnly" });
    }
    const r = await holdOrder(
      req.params.orderId,
      { userId: access.user.id, email: access.user.email },
      { ...parsed.data, note: parsed.data.note ?? null },
    );
    return sendResult(reply, r);
  });

  app.post<{ Params: { orderId: string } }>("/:orderId/release", async (req, reply) => {
    const parsed = releaseBody.safeParse(req.body);
    const access = await requireHoldsAccess(req, reply, "release");
    if (!access) return;
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (parsed.data.mode === "record_only" && !can(access.role, "recordOnly")) {
      return reply.code(403).send({ error: "forbidden", permission: "recordOnly" });
    }
    const r = await releaseOrder(
      req.params.orderId,
      { userId: access.user.id, email: access.user.email },
      {
        mode: parsed.data.mode,
        note: parsed.data.note ?? null,
        paidOutsideQbo: parsed.data.paidOutsideQbo ?? null,
      },
    );
    return sendResult(reply, r);
  });

  app.post<{ Params: { orderId: string } }>("/:orderId/pause", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "pause");
    if (!access) return;
    const parsed = pauseBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const until = endOfDayNewYork(parsed.data.until);
    if (!until) return reply.code(400).send({ error: "invalid date" });
    const r = await pauseOrder(
      req.params.orderId,
      { userId: access.user.id, email: access.user.email },
      { until, note: parsed.data.note ?? null },
    );
    return sendResult(reply, r);
  });

  app.delete<{ Params: { orderId: string } }>("/:orderId/pause", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "pause");
    if (!access) return;
    const r = await pauseOrder(
      req.params.orderId,
      { userId: access.user.id, email: access.user.email },
      { until: null },
    );
    return sendResult(reply, r);
  });

  app.post<{ Params: { orderId: string } }>("/:orderId/note", async (req, reply) => {
    const access = await requireHoldsAccess(req, reply, "note");
    if (!access) return;
    const parsed = noteBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const r = await addHoldNote(
      req.params.orderId,
      { userId: access.user.id, email: access.user.email },
      parsed.data.note,
    );
    return sendResult(reply, r);
  });
};

export default holdsAppRoute;
