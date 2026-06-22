// Viewer-token mint for the embedded inbox tasks board (shared-tasks M1).
//
// Finance mints a SHORT-LIVED (5-min) HMAC-signed token carrying the viewer's
// email; inbox VERIFIES it with the SAME shared secret and scopes the embedded
// board + SSE to that member. The format below is the LOCKED contract — it must
// BYTE-MATCH inbox's verify, so do not change the encoding without coordinating
// both sides.
//
// FORMAT (locked 2026-06-22):
//   payload   = JSON  {"email":<string>,"exp":<unix epoch SECONDS>}
//   seg1      = base64url(payloadJSON)
//   sig       = base64url(HMAC_SHA256(secret, seg1))
//   token     = seg1 + "." + sig
// base64url = URL-safe alphabet (+ → -, / → _) with ALL `=` padding stripped,
// applied to BOTH segments. HMAC over the ENCODED seg1 string (not the raw JSON).
//
// verifyViewerToken is used by finance only for its own unit tests (it documents
// the exact algorithm); inbox owns verification in production.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env.js";

/** Token lifetime in seconds (5 min). Inbox rejects an expired exp. */
export const VIEWER_TOKEN_TTL_SECONDS = 300;

/** Thrown at mint time when the signing secret is not configured. */
export class TasksEmbedSecretMissingError extends Error {
  constructor() {
    super(
      "TASKS_EMBED_SIGNING_SECRET is not set — cannot mint a tasks viewer token. " +
        "Set it (same value as inbox) before enabling shared tasks.",
    );
    this.name = "TasksEmbedSecretMissingError";
  }
}

type ViewerPayload = { email: string; exp: number };

function requireSecret(): string {
  const secret = env.TASKS_EMBED_SIGNING_SECRET;
  if (!secret) throw new TasksEmbedSecretMissingError();
  return secret;
}

/** Encode a Buffer/string as URL-safe base64 with NO padding. */
function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Decode a URL-safe, unpadded base64 string back to a Buffer. */
function base64urlDecode(seg: string): Buffer {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

/** HMAC-SHA256 over the encoded seg1 string, returned as a base64url signature. */
function sign(seg1: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(seg1).digest());
}

/**
 * Mint a short-lived viewer token for `email`. exp = now + 5 min (unix SECONDS).
 * Throws TasksEmbedSecretMissingError when the signing secret is unset.
 */
export function mintViewerToken(email: string): string {
  const secret = requireSecret();
  const payload: ViewerPayload = {
    email,
    exp: Math.floor(Date.now() / 1000) + VIEWER_TOKEN_TTL_SECONDS,
  };
  const seg1 = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = sign(seg1, secret);
  return `${seg1}.${sig}`;
}

/**
 * Verify a viewer token using the same algorithm + shared secret. Returns
 * `{ email }` on success, or null when the token is malformed, the signature
 * doesn't match (constant-time compare), or it has expired. Finance uses this
 * only in its own unit tests — inbox owns production verification.
 */
export function verifyViewerToken(token: string): { email: string } | null {
  const secret = requireSecret();
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const seg1 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Constant-time signature compare. Length-guard first: timingSafeEqual throws
  // on length mismatch, so bail when the byte lengths differ.
  const expected = Buffer.from(sign(seg1, secret), "utf8");
  const actual = Buffer.from(sig, "utf8");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let payload: ViewerPayload;
  try {
    const json = base64urlDecode(seg1).toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as ViewerPayload).email !== "string" ||
      typeof (parsed as ViewerPayload).exp !== "number"
    ) {
      return null;
    }
    payload = parsed as ViewerPayload;
  } catch {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { email: payload.email };
}
