// Viewer-token mint for the embedded inbox tasks board (shared-tasks M1/M6).
//
// Finance mints a SHORT-LIVED HMAC-signed token carrying the viewer's email;
// inbox VERIFIES it with the SAME shared secret and scopes the embedded board +
// SSE to that member. The format below is the LOCKED contract — it must
// BYTE-MATCH inbox's verify, so do not change the encoding without coordinating
// both sides.
//
// FORMAT (locked 2026-06-22; scope added 2026-06-23 — ADDITIVE):
//   payload   = JSON  {"email":<string>,"exp":<unix epoch SECONDS>[,"scope":"edit"]}
//   seg1      = base64url(payloadJSON)
//   sig       = base64url(HMAC_SHA256(secret, seg1))
//   token     = seg1 + "." + sig
// base64url = URL-safe alphabet (+ → -, / → _) with ALL `=` padding stripped,
// applied to BOTH segments. HMAC over the ENCODED seg1 string (not the raw JSON).
//
// SCOPE (M6): the READ token (mintViewerToken) emits NO `scope` field — its
// payload is byte-identical to the locked-2026-06-22 contract, so the live M1
// read embed is untouched. The EDIT token (mintEditToken) adds `"scope":"edit"`
// and a longer TTL; inbox must (a) treat an ABSENT scope as "view" and (b) gate
// any WRITE (task edit / drag-restatus) on scope === "edit". Unknown fields don't
// affect the signature (inbox re-signs the received seg1 string, it does not
// re-encode the payload), so this is safe to roll out finance-first.
//
// verifyViewerToken is used by finance only for its own unit tests (it documents
// the exact algorithm); inbox owns verification in production.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env.js";

/** Read-token lifetime in seconds (5 min). Inbox rejects an expired exp. */
export const VIEWER_TOKEN_TTL_SECONDS = 300;

/**
 * Edit-token lifetime in seconds (30 min). Longer than the read token because an
 * interactive edit session (open a task, change fields, drag between columns)
 * spans far longer than a board render. Still short enough that a leaked token
 * expires quickly. Inbox enforces the same exp.
 */
export const EDIT_TOKEN_TTL_SECONDS = 1800;

/** Token scope. Absent in a token payload ⇒ "view" (back-compat read token). */
export type TokenScope = "view" | "edit";

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

type ViewerPayload = { email: string; exp: number; scope?: TokenScope };

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

/** Core mint: build the signed token for a payload object. */
function mintToken(payload: ViewerPayload): string {
  const secret = requireSecret();
  const seg1 = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = sign(seg1, secret);
  return `${seg1}.${sig}`;
}

/**
 * Mint a short-lived READ (view) token for `email`. exp = now + 5 min (unix
 * SECONDS). Emits NO `scope` field — byte-identical to the locked read contract.
 * Throws TasksEmbedSecretMissingError when the signing secret is unset.
 */
export function mintViewerToken(email: string): string {
  return mintToken({
    email,
    exp: Math.floor(Date.now() / 1000) + VIEWER_TOKEN_TTL_SECONDS,
  });
}

/**
 * Mint a longer-lived EDIT (write) token for `email`. exp = now + 30 min (unix
 * SECONDS) and `scope:"edit"`. Inbox gates task edits + drag-restatus on this
 * scope. Throws TasksEmbedSecretMissingError when the signing secret is unset.
 */
export function mintEditToken(email: string): string {
  return mintToken({
    email,
    exp: Math.floor(Date.now() / 1000) + EDIT_TOKEN_TTL_SECONDS,
    scope: "edit",
  });
}

/**
 * Verify a viewer token using the same algorithm + shared secret. Returns
 * `{ email, scope }` on success (scope defaults to "view" when the payload omits
 * it — back-compat with read tokens), or null when the token is malformed, the
 * signature doesn't match (constant-time compare), or it has expired. Finance
 * uses this only in its own unit tests — inbox owns production verification.
 */
export function verifyViewerToken(
  token: string,
): { email: string; scope: TokenScope } | null {
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
    const rawScope = (parsed as ViewerPayload).scope;
    if (rawScope !== undefined && rawScope !== "view" && rawScope !== "edit") {
      return null;
    }
    payload = parsed as ViewerPayload;
  } catch {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { email: payload.email, scope: payload.scope ?? "view" };
}
