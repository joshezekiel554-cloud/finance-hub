// Vocatech signs webhook payloads with HMAC-SHA256.
// Header: X-Vocatech-Signature: t=<unix>,v1=<HMAC over "t={timestamp}.{raw_body}">
// Replay protection: reject if |now - t| > 300s.

import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SECONDS = 300;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "malformed_header" | "expired" | "bad_signature" };

export function verifyVocatechSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing_header" };
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k!.trim(), v?.trim() ?? ""];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "malformed_header" };

  const tsUnix = parseInt(t, 10);
  if (!Number.isFinite(tsUnix)) return { ok: false, reason: "malformed_header" };
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsUnix);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "expired" };

  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(v1);
  if (expectedBuf.length !== providedBuf.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(expectedBuf, providedBuf)) return { ok: false, reason: "bad_signature" };

  return { ok: true };
}
