import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { getSession } from "../lib/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: bigint;
    session?: { userId: string; email: string | null };
  }
}

const AUTH_ROUTE_PREFIX = "/api/auth";
const HEALTH_ROUTE = "/health";

async function loggerPluginImpl(app: FastifyInstance): Promise<void> {
  // Fastify is built with `loggerInstance: logger` (see server.ts), so
  // `app.log` and `req.log` are already pino. This plugin only adds the
  // per-request lifecycle hooks: timing, session decoration, and the
  // structured "request completed" line.

  app.addHook("onRequest", async (req: FastifyRequest) => {
    req.startTime = process.hrtime.bigint();
  });

  // Decorate req.session for downstream consumers (route handlers, the
  // request-completed log line). Skip /api/auth/* (Auth.js owns those)
  // and /health (uptime monitor traffic — don't query the DB on every poll).
  // Failures are swallowed: this is best-effort context, not a gate.
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const url = req.url ?? "";
    if (url.startsWith(AUTH_ROUTE_PREFIX)) return;
    if (url === HEALTH_ROUTE) return;

    try {
      const s = await getSession(req);
      if (s) req.session = { userId: s.user.id, email: s.user.email ?? null };
    } catch (err) {
      req.log.debug({ err }, "session lookup failed");
    }
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const status = reply.statusCode;
    const durationMs = req.startTime
      ? Number((process.hrtime.bigint() - req.startTime) / 1_000_000n)
      : undefined;

    const isAuthRoute = req.url?.startsWith(AUTH_ROUTE_PREFIX) ?? false;

    const fields: Record<string, unknown> = {
      method: req.method,
      url: req.url,
      status,
      duration_ms: durationMs,
      request_id: req.id,
    };

    if (req.session?.userId) fields.user_id = req.session.userId;

    if (isAuthRoute) fields.body_omitted = true;

    if (status >= 500) {
      req.log.error(fields, "request completed");
    } else if (status >= 400) {
      req.log.warn(fields, "request completed");
    } else {
      req.log.info(fields, "request completed");
    }
  });
}

export const loggerPlugin = fp(loggerPluginImpl, { name: "logger" });
