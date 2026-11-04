// Shared gate for hub → finance server-to-server calls (/api/ext/hub-summary,
// /api/ext/reports/*, /api/ext/tools/*, /api/ext/proposals/*):
// `Authorization: Bearer <hub token>` with aud "finance", minted by the hub
// for the signed-in member. The member must also be on finance's own
// ALLOWED_EMAILS — staff only, so hub guests are refused here even if the
// hub ever let one through.
//
// Scopes: every route takes scope "service" — except a proposal
// Confirm/Cancel, which also takes (and, once HUB_CONFIRM_TOKENS_REQUIRED
// is set, ONLY takes) a scope "confirm" token bound to that proposal id.
// A confirm token is refused everywhere else.

import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../lib/env.js";
import { verifyHubToken, type HubTokenClaims } from "../../lib/hub-token.js";
import { isEmailAllowed } from "./hub-handoff.js";

export type HubServiceAuthResult =
  | { ok: true; claims: HubTokenClaims }
  | { ok: false; status: 401 | 403 | 503; error: string };

/** Secrets a finance hub token may be signed with: finance's own, then (until retired) the shared one. */
export function hubSecrets(
  e: Pick<typeof env, "HUB_SECRET_FINANCE" | "HUB_SSO_SECRET" | "HUB_SHARED_SECRET_RETIRED"> = env,
): string[] {
  return [e.HUB_SECRET_FINANCE, e.HUB_SHARED_SECRET_RETIRED ? undefined : e.HUB_SSO_SECRET].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

/** The secret finance signs its own short-lived links with (finance-only when set). */
export function financeLinkSecret(e: Pick<typeof env, "HUB_SECRET_FINANCE" | "HUB_SSO_SECRET"> = env): string | undefined {
  return e.HUB_SECRET_FINANCE || e.HUB_SSO_SECRET || undefined;
}

export type ScopeRule =
  | { kind: "service" }
  // Proposal settle: "service" (until required off) or "confirm" bound to pid.
  | { kind: "settle"; proposalId: string; confirmRequired: boolean };

export function checkHubServiceAuth(
  authorization: string | undefined,
  opts: { secrets: readonly string[]; allowedEmails: string; nowSeconds: number; scope?: ScopeRule },
): HubServiceAuthResult {
  if (opts.secrets.length === 0) return { ok: false, status: 503, error: "hub not configured" };
  const header = authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const claims = verifyHubToken(token, {
    secret: opts.secrets,
    aud: "finance",
    nowSeconds: opts.nowSeconds,
  });
  const rule = opts.scope ?? { kind: "service" };
  const scopeOk =
    claims !== null &&
    (rule.kind === "service"
      ? claims.scope === "service"
      : (claims.scope === "confirm" && claims.pid === rule.proposalId) ||
        (claims.scope === "service" && !rule.confirmRequired));
  if (!claims || !scopeOk) {
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
  scope?: ScopeRule,
): HubTokenClaims | null {
  const res = checkHubServiceAuth(req.headers.authorization, {
    secrets: hubSecrets(),
    allowedEmails: env.ALLOWED_EMAILS,
    nowSeconds: Math.floor(Date.now() / 1000),
    scope,
  });
  if (!res.ok) {
    void reply.code(res.status).send({ error: res.error });
    return null;
  }
  return res.claims;
}
