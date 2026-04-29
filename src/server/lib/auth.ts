import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "~/db/index.js";
import { sessions, users, type User } from "~/db/schema/auth.js";
import { env } from "~/lib/env.js";
import { createLogger } from "~/lib/logger.js";

const log = createLogger({ component: "auth" });

// Hard fail at boot if the dev bypass is configured against production.
// This is paranoia layered on top of the runtime guard inside getCurrentUser
// — better to refuse to start than to silently auth-bypass a prod deploy.
if (env.NODE_ENV === "production" && env.DEV_USER_EMAIL) {
  throw new Error(
    "DEV_USER_EMAIL is set in a production NODE_ENV — refusing to start. " +
      "This env var is dev-only; remove it from prod configs.",
  );
}
if (env.DEV_USER_EMAIL) {
  log.warn(
    { email: env.DEV_USER_EMAIL, nodeEnv: env.NODE_ENV },
    "DEV AUTH BYPASS active — every requireAuth synthesizes this user. " +
      "Disable for production.",
  );
}

// Order matters: prefer the secure (HTTPS-only) cookie when both are present
// so a plain-name cookie set over HTTP can never override the signed prod one.
const SESSION_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
];

function readSessionToken(req: FastifyRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const c of cookies) {
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    const name = c.slice(0, eq);
    if (SESSION_COOKIE_NAMES.includes(name)) {
      return decodeURIComponent(c.slice(eq + 1));
    }
  }
  return null;
}

export type SessionInfo = {
  user: User;
  expires: Date;
  sessionToken: string;
};

export async function getSession(req: FastifyRequest): Promise<SessionInfo | null> {
  const token = readSessionToken(req);
  if (!token) return null;

  const rows = await db
    .select({
      sessionToken: sessions.sessionToken,
      expires: sessions.expires,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sessionToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expires.getTime() < Date.now()) return null;

  return { user: row.user, expires: row.expires, sessionToken: row.sessionToken };
}

export async function getCurrentUser(req: FastifyRequest): Promise<User | null> {
  // Dev bypass — short-circuit auth in non-production when DEV_USER_EMAIL
  // is set. The user row is auto-created on first use so foreign keys
  // resolve. Real OAuth still works in parallel; this just removes the
  // requirement to sign in for local development. Production is double-
  // gated by the boot-time throw above + the NODE_ENV check here.
  if (env.NODE_ENV !== "production" && env.DEV_USER_EMAIL) {
    return getOrCreateDevUser(env.DEV_USER_EMAIL);
  }
  const session = await getSession(req);
  return session?.user ?? null;
}

// Find-or-create the dev bypass user. Cached in module memory after the
// first DB hit so we're not re-querying on every request — `users` is
// a stable identity, the row's name/image only update via real OAuth.
let _devUserCache: User | null = null;
async function getOrCreateDevUser(email: string): Promise<User> {
  if (_devUserCache && _devUserCache.email === email) return _devUserCache;
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0]) {
    _devUserCache = existing[0];
    return existing[0];
  }
  // First-time setup: insert a minimal user row with a deterministic id
  // so every dev session lands the same identity. Auth.js's drizzle
  // adapter will write to this same row if the operator later signs in
  // with real Google OAuth using the same email — emails are unique.
  const id = `dev-${email.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const name = email.split("@")[0] ?? "Dev User";
  await db.insert(users).values({
    id,
    email,
    name,
    emailVerified: new Date(),
    image: null,
  });
  const created = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  _devUserCache = created[0]!;
  return _devUserCache;
}

export class UnauthorizedError extends Error {
  statusCode = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function requireAuth(req: FastifyRequest): Promise<User> {
  const user = await getCurrentUser(req);
  if (!user) throw new UnauthorizedError();
  return user;
}
