// GET /auth/hub?ht=<token>&next=<path>&hub=1 — sign-in handoff from
// hub.feldart.com (hub phase-1 spec §4).
//
// Google's consent screen won't render inside an iframe, so the hub does the
// one interactive sign-in and hands us a 300 s HMAC token. We verify it
// (shared secret, exp, aud === "finance"), then apply finance's OWN
// ALLOWED_EMAILS gate, create the same database session Auth.js would after
// a Google callback, set the same cookie, and 302 to `next`.

import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sessions, users } from "../../db/schema/auth.js";
import { env } from "../../lib/env.js";
import { verifyHubToken } from "../../lib/hub-token.js";
import { createLogger } from "../../lib/logger.js";
import {
  ConsumedJtiGuard,
  buildHubEmbeddedCookie,
  buildSessionCookie,
  isEmailAllowed,
  renderHandoffErrorPage,
  safeNextPath,
  sessionExpiry,
} from "../lib/hub-handoff.js";

const log = createLogger({ component: "routes.hub-auth" });

// Replay guard — see ConsumedJtiGuard. Retention comfortably exceeds the
// hub's token TTL (60–300 s).
const consumedJti = new ConsumedJtiGuard(600);

type Query = { ht?: string; next?: string; hub?: string };

const hubAuthRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Query }>("/hub", async (req, reply) => {
    // Refusals render a small page (this lands inside the hub's iframe)
    // rather than JSON, with the "open in a new tab" escape hatch.
    const refuse = (status: number, reason: string) =>
      reply
        .code(status)
        .header("content-type", "text/html; charset=utf-8")
        .send(renderHandoffErrorPage({ reason, publicUrl: env.PUBLIC_URL }));

    const secret = env.HUB_SSO_SECRET;
    if (!secret) {
      return refuse(503, "Hub sign-in is not configured on this app.");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims = verifyHubToken(req.query.ht ?? "", {
      secret,
      aud: "finance",
      nowSeconds,
    });
    if (!claims || claims.scope !== "user") {
      log.warn({ ip: req.ip }, "hub handoff rejected: invalid token");
      return refuse(401, "The sign-in link from the hub is invalid or has expired. Go back to the hub and try again.");
    }
    if (!consumedJti.consume(claims.jti, nowSeconds)) {
      log.warn({ email: claims.email, jti: claims.jti, ip: req.ip }, "hub handoff rejected: token replayed");
      return refuse(401, "This sign-in link was already used. Go back to the hub and try again.");
    }
    if (!isEmailAllowed(claims.email, env.ALLOWED_EMAILS)) {
      log.warn({ email: claims.email, jti: claims.jti }, "hub handoff rejected: not on ALLOWED_EMAILS");
      return refuse(403, "This account is not allowed in Finance.");
    }

    // Same identity rule as the Google flow: one user row per email.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${claims.email}`)
      .limit(1);
    let userId = existing[0]?.id;
    if (!userId) {
      userId = randomUUID();
      await db.insert(users).values({ id: userId, email: claims.email, emailVerified: new Date() });
      log.info({ email: claims.email, userId }, "hub handoff created finance user");
    }

    const sessionToken = randomUUID();
    const expires = sessionExpiry();
    await db.insert(sessions).values({ sessionToken, userId, expires });

    const secure = env.PUBLIC_URL.startsWith("https://");
    const cookies = [buildSessionCookie({ token: sessionToken, expires, secure })];
    if (req.query.hub === "1") cookies.push(buildHubEmbeddedCookie(secure));
    reply.raw.setHeader("set-cookie", cookies);

    log.info({ email: claims.email, jti: claims.jti, embedded: req.query.hub === "1" }, "hub handoff session created");
    return reply.redirect(safeNextPath(req.query.next, env.PUBLIC_URL), 302);
  });

  // Convenience for the hub's "open in full tab" + a manual sanity check.
  app.get("/hub/ping", async () => ({ ok: true, app: "finance" }));
};

export default hubAuthRoute;
