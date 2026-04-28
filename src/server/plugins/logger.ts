import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: bigint;
  }
}

const AUTH_ROUTE_PREFIX = "/api/auth";

async function loggerPluginImpl(app: FastifyInstance): Promise<void> {
  // Fastify is built with `loggerInstance: logger` (see server.ts), so
  // `app.log` and `req.log` are already pino. This plugin only adds the
  // per-request lifecycle hook that emits one structured line per request.
  app.addHook("onRequest", async (req: FastifyRequest) => {
    req.startTime = process.hrtime.bigint();
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

    const userId = (req as FastifyRequest & { session?: { userId?: string } }).session
      ?.userId;
    if (userId) fields.user_id = userId;

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
