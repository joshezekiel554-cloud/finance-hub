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
