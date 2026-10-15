// Shared gate for hub → finance server-to-server reads (/api/ext/hub-summary,
// /api/ext/reports/*): `Authorization: Bearer <hub token>` with aud
// "finance" + scope "service", minted by the hub for the signed-in member.
// The member must also be on finance's own ALLOWED_EMAILS — staff only, so
// hub guests are refused here even if the hub ever let one through.

import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../lib/env.js";
import { verifyHubToken, type HubTokenClaims } from "../../lib/hub-token.js";
import { isEmailAllowed } from "./hub-handoff.js";

export type HubServiceAuthResult =
  | { ok: true; claims: HubTokenClaims }
  | { ok: false; status: 401 | 403 | 503; error: string };

export function checkHubServiceAuth(
  authorization: string | undefined,
  opts: { secret: string | undefined; allowedEmails: string; nowSeconds: number },
): HubServiceAuthResult {
  if (!opts.secret) return { ok: false, status: 503, error: "hub not configured" };
  const header = authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const claims = verifyHubToken(token, {
    secret: opts.secret,
    aud: "finance",
    nowSeconds: opts.nowSeconds,
  });
  if (!claims || claims.scope !== "service") {
    return { ok: false, status: 401, error: "invalid hub service token" };
  }
  if (!isEmailAllowed(claims.email, opts.allowedEmails)) {
    return { ok: false, status: 403, error: "not allowed" };
  }
  return { ok: true, claims };
}

/** Route glue: replies with the refusal and returns null, or returns the claims. */
export function requireHubService(
  req: FastifyRequest,
  reply: FastifyReply,
): HubTokenClaims | null {
  const res = checkHubServiceAuth(req.headers.authorization, {
    secret: env.HUB_SSO_SECRET,
    allowedEmails: env.ALLOWED_EMAILS,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!res.ok) {
    void reply.code(res.status).send({ error: res.error });
    return null;
  }
  return res.claims;
}
