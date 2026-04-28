import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Auth, type AuthConfig } from "@auth/core";
import Google from "@auth/core/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "~/db/index.js";
import { users, accounts, sessions, verificationTokens } from "~/db/schema/auth.js";
import { env } from "~/lib/env.js";

function buildAuthConfig(allowList: ReadonlySet<string>): AuthConfig {
  return {
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    providers: [
      Google({
        clientId: env.AUTH_GOOGLE_CLIENT_ID,
        clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET,
      }),
    ],
    secret: env.AUTH_SECRET,
    session: { strategy: "database" },
    trustHost: true,
    pages: { signIn: "/login" },
    callbacks: {
      async signIn({ user }) {
        const email = user?.email?.toLowerCase();
        if (!email) return false;
        if (allowList.size === 0) {
          // Dev-friendly: with no allow-list configured, refuse all sign-ins
          // rather than silently accepting them. The plugin warns at boot.
          return false;
        }
        return allowList.has(email);
      },
      async session({ session, user }) {
        if (session.user && user) {
          session.user.id = user.id;
          session.user.email = user.email;
        }
        return session;
      },
    },
  };
}

function parseAllowList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function fastifyToWebRequest(req: FastifyRequest): Promise<Request> {
  const protocol = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
  const url = new URL(req.url, `${protocol}://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, String(value));
    }
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Fastify default content-type parsers buffer the body to req.body.
    // For Auth.js form posts, re-serialize from the parsed body. URL-encoded
    // form data is what Auth.js posts (CSRF, sign-in, callback).
    const ct = (req.headers["content-type"] ?? "").toString();
    if (ct.includes("application/x-www-form-urlencoded") && req.body && typeof req.body === "object") {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
        if (Array.isArray(v)) v.forEach((item) => params.append(k, String(item)));
        else if (v !== undefined && v !== null) params.append(k, String(v));
      }
      init.body = params.toString();
    } else if (ct.includes("application/json") && req.body !== undefined) {
      init.body = JSON.stringify(req.body);
    } else if (typeof req.body === "string" || req.body instanceof Uint8Array) {
      init.body = req.body as BodyInit;
    }
  }

  return new Request(url.toString(), init);
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      reply.header("set-cookie", value);
    } else {
      reply.header(key, value);
    }
  });
  const body = response.body ? await response.text() : "";
  return reply.send(body);
}

export const authPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const allowList = parseAllowList(env.ALLOWED_EMAILS);
  if (allowList.size === 0) {
    app.log.warn?.(
      "ALLOWED_EMAILS is empty — all Google sign-ins will be rejected. Configure at least one email before testing login.",
    );
  }

  const config = buildAuthConfig(allowList);

  // Make sure Fastify parses URL-encoded bodies (Auth.js posts forms)
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      const parsed: Record<string, string> = {};
      const params = new URLSearchParams(body as string);
      for (const [k, v] of params.entries()) parsed[k] = v;
      done(null, parsed);
    },
  );

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const webReq = await fastifyToWebRequest(req);
    const webRes = await Auth(webReq, config);
    await sendWebResponse(reply, webRes);
  };

  app.route({ method: ["GET", "POST"], url: "/api/auth/*", handler });
};

export default authPlugin;
