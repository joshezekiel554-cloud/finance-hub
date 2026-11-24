// GET /api/ext/holdorders/access — does the hub show the Hold Orders tile?
// Auth: hub service token (aud "finance", scope "service"), like the other
// hub → finance calls. Unlike requireHubService the membership list is the
// Hold Orders one (ADMIN_EMAILS ∪ HOLDORDERS_EMAILS), not ALLOWED_EMAILS —
// the salesman is the whole point. A valid token for anyone else gets a 200
// with allowed:false (the hub just hides the tile).
//   → { allowed: boolean, role: "admin" | "holds" | null }
// Loopback-only behind nginx like the rest of /api/ext.

import type { FastifyPluginAsync } from "fastify";
import { env } from "../../lib/env.js";
import { checkHubServiceAuth, hubSecrets } from "../lib/hub-service-auth.js";
import { holdsRoleFor, type HoldsRole } from "../../modules/hold-orders/permissions.js";

export type HoldOrdersAccessResponse = { allowed: boolean; role: HoldsRole | null };

const extHoldOrdersRoute: FastifyPluginAsync = async (app) => {
  app.get("/holdorders/access", async (req, reply) => {
    const res = checkHubServiceAuth(req.headers.authorization, {
      secrets: hubSecrets(),
      allowedEmails: [env.ADMIN_EMAILS, env.HOLDORDERS_EMAILS].filter(Boolean).join(","),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!res.ok) {
      // 403 = the token was valid but the member isn't on either list.
      if (res.status === 403) {
        const body: HoldOrdersAccessResponse = { allowed: false, role: null };
        return reply.send(body);
      }
      return reply.code(res.status).send({ error: res.error });
    }
    const role = holdsRoleFor(res.claims.email, {
      adminEmails: env.ADMIN_EMAILS,
      holdsEmails: env.HOLDORDERS_EMAILS,
    });
    const body: HoldOrdersAccessResponse = { allowed: role !== null, role };
    return reply.send(body);
  });
};

export default extHoldOrdersRoute;
