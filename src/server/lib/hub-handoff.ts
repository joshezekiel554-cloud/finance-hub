// Pure helpers for the hub → finance sign-in handoff (GET /auth/hub).
// Kept free of Fastify/DB so they can be unit-tested; the route is glue.

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // Auth.js default

/** Only ever bounce to an in-app path; anything else lands on Home. */
export function safeNextPath(next: string | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/auth/hub")) return "/";
  return next;
}

/** Case-insensitive membership in the comma-separated allow-list. Empty list → nobody. */
export function isEmailAllowed(email: string, allowListCsv: string): boolean {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  const set = new Set(
    allowListCsv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(wanted);
}

export function sessionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_MAX_AGE_MS);
}

/**
 * The exact cookie Auth.js sets for a database session, so `getSession()`
 * in server/lib/auth.ts reads it unchanged: `__Secure-` prefix + Secure over
 * https, plain name over http (dev); HttpOnly, SameSite=Lax, Path=/.
 */
export function buildSessionCookie(input: {
  token: string;
  expires: Date;
  secure: boolean;
}): string {
  const name = input.secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const parts = [
    `${name}=${encodeURIComponent(input.token)}`,
    "Path=/",
    `Expires=${input.expires.toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (input.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Marks this browser session as "inside the hub". Readable by the SPA (no
 * HttpOnly) so App.tsx can hide finance's own top bar; session-scoped so a
 * later top-level visit to finance.feldart.com gets the full chrome back.
 */
export function buildHubEmbeddedCookie(secure: boolean): string {
  const parts = ["hub_embedded=1", "Path=/", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * What the hub's iframe shows when a handoff is refused. Deliberately no
 * Google button (Google won't render inside a frame); the way out is a
 * top-level tab where finance's normal sign-in works.
 */
export function renderHandoffErrorPage(input: { reason: string; publicUrl: string }): string {
  const base = input.publicUrl.replace(/\/$/, "");
  const reason = escapeHtml(input.reason);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Finance</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;font:14px/1.5 Inter,"Segoe UI",system-ui,sans-serif;color:oklch(20% 0.015 250);background:oklch(99% 0.003 250);display:grid;place-items:center;min-height:100vh}
  .card{max-width:420px;padding:24px 28px;border:1px solid oklch(91% 0.008 250);border-radius:12px;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/.04)}
  h1{font-size:16px;margin:0 0 8px}
  p{margin:0 0 16px;color:oklch(40% 0.015 250)}
  a{display:inline-block;padding:8px 14px;border-radius:8px;background:oklch(58% 0.18 260);color:#fff;text-decoration:none;font-weight:600}
</style></head>
<body><div class="card"><h1>Finance can’t sign you in here</h1><p>${reason}</p>
<a href="${base}/" target="_blank" rel="noopener">Open Finance in a new tab</a></div></body></html>`;
}
