// /api/ext/task-cards/:type/:id/:action — the service-token-guarded WRITE side
// of the finance queue cards (shared-tasks M3). The inbox board renders the
// cards from GET /api/ext/task-cards (see ext.ts) and POSTs here when an
// operator clicks a one-click action button.
//
// Direction + auth: same as the rest of /api/ext (inbox → finance, bearer
// FINANCE_SERVICE_TOKEN + inbox_integration_enabled flag via guardServiceRequest,
// nginx-denied on the public vhost). The action is clicked in the inbox board but
// runs the EXISTING finance action function — we only swap the auth layer
// (service-token + actor) for the human cookie session.
//
// Actor → audit attribution (finance-lane spec §6): the board passes
// {actorEmail, actorTeamMemberId}. We key on actorEmail (the §5 identity join
// key, reverse direction): lowercase-match it against the finance `user` table.
//   - match  → pass that finance userId to the action fn, so its native audit row
//              is attributed correctly + no extra lookup.
//   - no match (finance user lacks an account / email differs) → pass null to the
//              action fn (its userId columns are nullable) BUT always write a
//              standalone audit_log row stamping actorEmail + actorTeamMemberId so
//              attribution survives regardless.
// We write the standalone attribution row in BOTH cases so the cross-app actor
// (the inbox teamMemberId) is always recorded — finance `user` ids alone don't
// carry it.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/auth.js";
import { auditLog } from "../../db/schema/audit.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { guardServiceRequest } from "../lib/service-auth.js";
import {
  releaseHold,
  placeOnHold,
  cancelHoldOrder,
  dismissOrderReview,
} from "../../modules/orders/hold-actions.js";
import {
  approveProposalAndEnqueue,
  rejectProposal,
} from "../../modules/ai-agent/proposal-store.js";

const log = createLogger({ component: "routes.ext-actions" });

const extRateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

// Allowed (type, action) pairs — anything else is a 400. Link-only card types
// (chase, rma) expose NO api actions, so they never appear here.
export const ALLOWED = {
  hold: ["good-to-send", "cancel"],
  overdue_review: ["place-on-hold", "dismiss"],
  ai_proposal: ["approve", "reject"],
} as const satisfies Record<string, readonly string[]>;

export type ActionableType = keyof typeof ALLOWED;

// Is (type, action) an exposed one-click action? Widened so callers can pass an
// arbitrary string action (e.g. from the URL) against the literal allow-list.
export function isAllowedAction(type: ActionableType, action: string): boolean {
  return (ALLOWED[type] as readonly string[]).includes(action);
}

export const paramsSchema = z.object({
  type: z.enum(["hold", "overdue_review", "ai_proposal"]),
  id: z.string().min(1).max(64),
  action: z.string().min(1).max(32),
});

export const bodySchema = z.object({
  actorEmail: z.string().min(1).max(320),
  actorTeamMemberId: z.string().max(64).optional(),
});

// Result of the pure dispatcher — { status, body } the route forwards verbatim.
export type DispatchResult = { status: number; body: unknown };

// Pure action dispatcher (no auth, no audit) — maps a validated (type, action)
// onto the EXISTING action fn + translates its result into an HTTP status/body.
// Extracted so routing can be unit-tested without a Fastify harness. Assumes the
// (type, action) pair is already ALLOWED and the ai_proposal/approve null-actor
// guard has run (userId non-null for that case).
export async function dispatchTaskCardAction(
  type: ActionableType,
  id: string,
  action: string,
  userId: string | null,
): Promise<DispatchResult> {
  if (type === "hold" && action === "good-to-send") {
    const r = await releaseHold(id, userId);
    if (!r.ok) return { status: r.reason === "not_found" ? 404 : 409, body: { error: r.reason } };
    return { status: 200, body: { ok: true } };
  }
  if (type === "hold" && action === "cancel") {
    const r = await cancelHoldOrder(id, userId);
    if (!r.ok) {
      const status =
        r.reason === "not_found" ? 404 : r.reason === "shopify_cancel_failed" ? 502 : 409;
      return { status, body: { error: r.reason } };
    }
    return { status: 200, body: r };
  }
  if (type === "overdue_review" && action === "place-on-hold") {
    const r = await placeOnHold(id, userId);
    if (!r.ok) return { status: r.reason === "not_found" ? 404 : 409, body: { error: r.reason } };
    return { status: 200, body: { ok: true } };
  }
  if (type === "overdue_review" && action === "dismiss") {
    const r = await dismissOrderReview(id, userId);
    if (!r.ok) return { status: r.reason === "not_found" ? 404 : 409, body: { error: r.reason } };
    return { status: 200, body: { ok: true } };
  }
  if (type === "ai_proposal" && action === "approve") {
    const r = await approveProposalAndEnqueue(id, userId as string);
    if (!r.ok) {
      return {
        status: r.reason === "not_found" ? 404 : 409,
        body: { error: r.reason, ...(r.status ? { status: r.status } : {}) },
      };
    }
    return { status: 200, body: { ok: true } };
  }
  if (type === "ai_proposal" && action === "reject") {
    const r = await rejectProposal(id, userId);
    if (!r.ok) return { status: r.reason === "not_found" ? 404 : 409, body: { error: r.reason } };
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { error: "unhandled action" } };
}

// Resolve an actor email → finance user id (lowercased exact match), or null.
export async function resolveFinanceUserId(email: string): Promise<string | null> {
  const lc = email.trim().toLowerCase();
  if (!lc) return null;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.email}) = ${lc}`)
    .limit(1);
  return rows[0]?.id ?? null;
}

// Standalone cross-app attribution row. userId may be null (no finance account);
// the inbox teamMemberId + the raw actorEmail are always captured in `after`.
async function recordBoardActionAudit(args: {
  userId: string | null;
  actorEmail: string;
  actorTeamMemberId: string | null;
  type: string;
  action: string;
  entityId: string;
}): Promise<void> {
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId: args.userId,
    action: "tasks.board_action",
    entityType: args.type === "ai_proposal" ? "ai_proposal" : "order",
    entityId: args.entityId,
    before: {},
    after: {
      via: "inbox_board",
      cardType: args.type,
      cardAction: args.action,
      actorEmail: args.actorEmail,
      actorTeamMemberId: args.actorTeamMemberId,
      resolvedFinanceUserId: args.userId,
    },
  });
}

const extActionsRoute: FastifyPluginAsync = async (app) => {
  app.post("/task-cards/:type/:id/:action", { config: extRateLimit }, async (req, reply) => {
    if (!(await guardServiceRequest(req, reply, env.FINANCE_SERVICE_TOKEN)))
      return;

    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params" });
    }
    const { type, id, action } = params.data;

    if (!isAllowedAction(type, action)) {
      return reply
        .code(400)
        .send({ error: `action '${action}' not allowed for type '${type}'` });
    }

    const body = bodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "actorEmail required" });
    }
    const { actorEmail, actorTeamMemberId } = body.data;

    const userId = await resolveFinanceUserId(actorEmail);

    // ai_proposal/approve needs a real finance user (the AI execute job + cost
    // tracking require a non-null actor). Reject + the order actions tolerate
    // a null actor (their audit columns are nullable).
    if (type === "ai_proposal" && action === "approve" && !userId) {
      return reply.code(409).send({
        error:
          "approving an AI proposal requires a finance account for the actor — none matched actorEmail",
        code: "no_finance_user",
      });
    }

    // Attribution row first, so the cross-app actor is recorded even if the
    // action fn below fails.
    await recordBoardActionAudit({
      userId,
      actorEmail,
      actorTeamMemberId: actorTeamMemberId ?? null,
      type,
      action,
      entityId: id,
    });

    log.info(
      { type, id, action, actorEmail, actorTeamMemberId, resolvedFinanceUserId: userId },
      "ext task-card action",
    );

    // Dispatch to the EXISTING action function (business rules unchanged).
    const result = await dispatchTaskCardAction(type, id, action, userId);
    return reply.code(result.status).send(result.body);
  });
};

export default extActionsRoute;
