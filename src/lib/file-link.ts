// Short-lived signed download links for QBO document PDFs, handed out by the
// Feldart AI ops tools so a PDF opens straight from the hub chat without a
// finance session. The link carries kind + QBO id + expiry + download name,
// HMAC-signed with a key derived from HUB_SSO_SECRET (domain-separated, so a
// link signature can never double as a hub token and vice versa).
//
//   /api/files/qb-pdf/{kind}/{qbId}?exp={unix}&name={file name}&sig={b64url}
//
// Verification never throws; any mismatch, tamper or expiry → null.

import { createHmac, timingSafeEqual } from "node:crypto";

export type QbPdfKind = "invoice" | "creditmemo";

export const FILE_LINK_TTL_SECONDS = 15 * 60;
// Not under /api/ext: nginx keeps /api/ext server-to-server only, and these
// links are opened by browsers.
export const FILE_LINK_PATH = "/api/files/qb-pdf";

function linkKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("finance:file-link:v1").digest();
}

function signature(secret: string, kind: QbPdfKind, qbId: string, exp: number, name: string): string {
  return createHmac("sha256", linkKey(secret))
    .update(`qb-pdf\n${kind}\n${qbId}\n${exp}\n${name}`)
    .digest("base64url");
}

/** A download name safe for Content-Disposition and every OS ("Invoice 1234 - Acme.pdf"). */
export function pdfFileName(label: string): string {
  const clean = label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${clean || "document"}.pdf`;
}

export function signQbPdfLink(input: {
  baseUrl: string;
  secret: string;
  kind: QbPdfKind;
  qbId: string;
  name: string;
  nowSeconds: number;
  ttlSeconds?: number;
}): { url: string; name: string; mime: "application/pdf"; expiresAt: string } {
  const exp = input.nowSeconds + (input.ttlSeconds ?? FILE_LINK_TTL_SECONDS);
  const sig = signature(input.secret, input.kind, input.qbId, exp, input.name);
  const qs = new URLSearchParams({ exp: String(exp), name: input.name, sig });
  return {
    url: `${input.baseUrl}${FILE_LINK_PATH}/${input.kind}/${encodeURIComponent(input.qbId)}?${qs.toString()}`,
    name: input.name,
    mime: "application/pdf",
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyQbPdfLink(input: {
  // Any of these (finance-only secret, or the shared one during cutover).
  secret: string | readonly string[] | undefined;
  kind: string;
  qbId: string;
  exp: unknown;
  name: unknown;
  sig: unknown;
  nowSeconds: number;
}): { kind: QbPdfKind; qbId: string; name: string } | null {
  const secrets = (typeof input.secret === "string" ? [input.secret] : input.secret ?? []).filter(Boolean);
  if (secrets.length === 0) return null;
  if (input.kind !== "invoice" && input.kind !== "creditmemo") return null;
  if (!/^\d{1,32}$/.test(input.qbId)) return null;
  if (typeof input.exp !== "string" || !/^\d{1,12}$/.test(input.exp)) return null;
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 200) return null;
  if (typeof input.sig !== "string" || input.sig.length === 0) return null;
  const exp = Number(input.exp);
  if (exp < input.nowSeconds) return null;
  const got = Buffer.from(input.sig);
  const kind: QbPdfKind = input.kind;
  const name = input.name;
  const ok = secrets.some((secret) => {
    const want = Buffer.from(signature(secret, kind, input.qbId, exp, name));
    return want.length === got.length && timingSafeEqual(want, got);
  });
  if (!ok) return null;
  return { kind: input.kind, qbId: input.qbId, name: input.name };
}

// ---------------------------------------------------------------------------
// Stored generated files (lib/ai-file-store.ts). The tool did the work once;
// this link only streams the stored bytes, so opening it is idempotent.
//
//   /api/files/stored/{fileId}?exp={unix}&name={file name}&sig={b64url}

export const STORED_FILE_PATH = "/api/files/stored";

function storedSignature(secret: string, fileId: string, exp: number, name: string): string {
  return createHmac("sha256", linkKey(secret)).update(`stored\n${fileId}\n${exp}\n${name}`).digest("base64url");
}

export function signStoredFileLink(input: {
  baseUrl: string;
  secret: string;
  fileId: string;
  name: string;
  mime: "application/pdf";
  nowSeconds: number;
  ttlSeconds?: number;
}): { url: string; name: string; mime: "application/pdf"; expiresAt: string } {
  const exp = input.nowSeconds + (input.ttlSeconds ?? FILE_LINK_TTL_SECONDS);
  const sig = storedSignature(input.secret, input.fileId, exp, input.name);
  const qs = new URLSearchParams({ exp: String(exp), name: input.name, sig });
  return {
    url: `${input.baseUrl}${STORED_FILE_PATH}/${encodeURIComponent(input.fileId)}?${qs.toString()}`,
    name: input.name,
    mime: input.mime,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyStoredFileLink(input: {
  secret: string | readonly string[] | undefined;
  fileId: string;
  exp: unknown;
  name: unknown;
  sig: unknown;
  nowSeconds: number;
}): { fileId: string; name: string } | null {
  const secrets = (typeof input.secret === "string" ? [input.secret] : input.secret ?? []).filter(Boolean);
  if (secrets.length === 0) return null;
  if (!/^[A-Za-z0-9_-]{32}$/.test(input.fileId)) return null;
  if (typeof input.exp !== "string" || !/^\d{1,12}$/.test(input.exp)) return null;
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 200) return null;
  if (typeof input.sig !== "string" || input.sig.length === 0) return null;
  const exp = Number(input.exp);
  if (exp < input.nowSeconds) return null;
  const name = input.name;
  const got = Buffer.from(input.sig);
  const ok = secrets.some((secret) => {
    const want = Buffer.from(storedSignature(secret, input.fileId, exp, name));
    return want.length === got.length && timingSafeEqual(want, got);
  });
  return ok ? { fileId: input.fileId, name } : null;
}
