// Hold Orders access: host detection + the /api/holds/* gate.
//
// The session is the same Auth.js database session finance uses (cookie is
// host-scoped, so a holdorders.feldart.com session never reaches
// finance.feldart.com and vice versa). The ROLE is computed per request from
// the email (ADMIN_EMAILS → admin, HOLDORDERS_EMAILS → holds), so editing the
// env lists takes effect without touching sessions.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../../db/schema/auth.js";
import { env } from "../../lib/env.js";
import { getCurrentUser } from "./auth.js";
import {
  can,
  holdsRoleFor,
  type HoldsPermission,
  type HoldsRole,
} from "../../modules/hold-orders/permissions.js";

export function holdsRoleForUser(user: Pick<User, "email"> | null): HoldsRole | null {
  return holdsRoleFor(user?.email ?? null, {
    adminEmails: env.ADMIN_EMAILS,
    holdsEmails: env.HOLDORDERS_EMAILS,
  });
}

export type HoldsAccess = { user: User; role: HoldsRole };

/** Route glue: replies 401/403 and returns null, or returns user + role. */
export async function requireHoldsAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  perm: HoldsPermission = "view",
): Promise<HoldsAccess | null> {
  const user = await getCurrentUser(req);
  if (!user) {
    void reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const role = holdsRoleForUser(user);
  if (!role) {
    void reply.code(403).send({ error: "no_hold_orders_access" });
    return null;
  }
  if (!can(role, perm)) {
    void reply.code(403).send({ error: "forbidden", permission: perm });
    return null;
  }
  return { user, role };
}
