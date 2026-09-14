// Feldart Hub SSO handoff token (hub phase-1 spec §4).
//
// Format, byte-compatible with the inbox `embed-token` verifier:
//   token = seg1 "." sig
//   seg1  = base64url(JSON{ email, exp, aud, jti, scope? })   (no padding)
//   sig   = base64url(HMAC-SHA256(HUB_SSO_SECRET, seg1))       (no padding)
//
// The hub mints one per iframe mount (TTL 300 s, scope "user") and one per
// Home-tile fetch (scope "service"). Each app verifies with the shared
// secret, checks `aud` is itself, then applies its OWN allow-list — the hub
// never grants access an app would refuse. Verification never throws.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type HubAudience = "inbox" | "finance" | "internal";
export type HubTokenScope = "user" | "service";

export type HubTokenClaims = {
  email: string;
  aud: HubAudience;
  jti: string;
  scope: HubTokenScope;
};

function sign(seg1: string, secret: string): string {
  return createHmac("sha256", secret).update(seg1).digest("base64url");
}

export function mintHubToken(input: {
  email: string;
  aud: HubAudience;
  ttlSeconds: number;
  secret: string;
  nowSeconds?: number;
  scope?: HubTokenScope;
  jti?: string;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    email: input.email,
    exp: now + input.ttlSeconds,
    aud: input.aud,
    jti: input.jti ?? randomUUID(),
  };
  if (input.scope) payload.scope = input.scope;
  const seg1 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${seg1}.${sign(seg1, input.secret)}`;
}

export function verifyHubToken(
  token: string,
  opts: { secret: string; aud: HubAudience; nowSeconds: number },
): HubTokenClaims | null {
  if (!opts.secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const seg1 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  if (!seg1 || !providedSig) return null;

  const a = Buffer.from(providedSig);
  const b = Buffer.from(sign(seg1, opts.secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(seg1, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (typeof p.exp !== "number" || p.exp < opts.nowSeconds) return null;
  if (typeof p.email !== "string" || p.email.length === 0) return null;
  if (p.aud !== opts.aud) return null;

  let scope: HubTokenScope = "user";
  if (p.scope !== undefined) {
    if (p.scope !== "user" && p.scope !== "service") return null;
    scope = p.scope;
  }

  return {
    email: p.email.trim().toLowerCase(),
    aud: opts.aud,
    jti: typeof p.jti === "string" ? p.jti : "",
    scope,
  };
}
