import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "~/db/index.js";
import { sessions, users, type User } from "~/db/schema/auth.js";

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
  const session = await getSession(req);
  return session?.user ?? null;
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
