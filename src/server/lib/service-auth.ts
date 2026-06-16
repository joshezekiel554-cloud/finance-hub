// Service-to-service auth + feature gate for the Inbox↔Finance integration
// (/api/ext). This sits BESIDE the cookie-based requireAuth() — it does not
// touch the human-facing app. The sibling Inbox app (same VPS) sends
// `Authorization: Bearer <FINANCE_SERVICE_TOKEN>` on every request; we compare
// in constant time.
//
// Two gates, both must pass:
//   1. the bearer token matches env.FINANCE_SERVICE_TOKEN (fail-closed: when
//      the env is unset, NO caller is allowed);
//   2. the `inbox_integration_enabled` app_settings flag is "true" (so the API
//      stays fully dark until the operator flips it — nothing-live-until-nod).
//
// Defense-in-depth only: /api/ext is also expected to be nginx-denied on the
// public vhost so it's reachable solely over loopback (see the nginx config +
// the spec §3.2). The token is the inner wall, not the sole wall.

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";

// Pure, dependency-free token check so it can be unit-tested without Fastify.
// Returns true iff `expected` is a non-empty configured token AND the header is
// exactly `Bearer <expected>`. Comparison is constant-time once lengths match;
// a length mismatch short-circuits to false (the length itself is not secret).
export function checkBearerToken(
  authHeader: string | undefined,
  expected: string | undefined,
): boolean {
  // Fail-closed: no configured token ⇒ nobody is authorized.
  if (!expected) return false;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const provided = authHeader.slice("Bearer ".length);
  if (provided.length === 0) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Read the master feature flag. "true" = on; anything else (incl. unset) = off.
// Mirrors the autopilot_scan_cron_enabled read pattern.
export async function isInboxIntegrationEnabled(): Promise<boolean> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "inbox_integration_enabled"))
    .limit(1);
  return rows[0]?.value === "true";
}

// Fastify preHandler. Token first (so an unauthenticated caller always gets
// 401 and never learns the flag state), then the feature flag (404 when off,
// so a disabled API is indistinguishable from "route doesn't exist"). Returns
// `true` when the request may proceed; when it returns `false` it has already
// sent the response and the handler must not run.
export async function guardServiceRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  expectedToken: string | undefined,
): Promise<boolean> {
  if (!checkBearerToken(req.headers.authorization, expectedToken)) {
    await reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  if (!(await isInboxIntegrationEnabled())) {
    await reply.code(404).send({ error: "not found" });
    return false;
  }
  return true;
}
