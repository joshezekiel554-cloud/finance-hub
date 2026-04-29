import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { loggerPlugin } from "./plugins/logger.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { sentryPlugin } from "./plugins/sentry.js";
import { authPlugin } from "./plugins/auth.js";
import { ssePlugin } from "./plugins/sse.js";
import { healthRoute } from "./routes/health.js";
import { registerRoutes } from "./routes/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function buildServer(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    disableRequestLogging: true,
    genReqId: () => crypto.randomUUID(),
  });

  // Order matters:
  //   1. logger first — every subsequent plugin/route can use req.log
  //   2. sentry next — onError hook ready before any route runs
  //   3. error handler — setErrorHandler must be installed BEFORE routes
  //      register so thrown errors hit our handler, not Fastify's default
  //   4. security plugins (helmet, cors, rate-limit, cookie, sensible) —
  //      registered by scaffolder; insert at the marker below
  //   5. auth plugin
  //   6. routes (health, api)

  await app.register(loggerPlugin);
  await app.register(sentryPlugin);
  await app.register(errorHandlerPlugin);

  // ─── security plugins (helmet/cors/rate-limit/cookie/sensible) ───
  // CSP off for now: the SPA is dev-served by Vite (different origin) and
  // prod-served as static assets here; we'll re-enable + tighten in week 6
  // when the CRM UI lands and we know the asset origins.
  await app.register(helmet, { contentSecurityPolicy: false });

  // Same-origin everything; no CORS needed. If the SPA ever runs on a
  // separate origin we'll allow-list it explicitly.
  await app.register(cors, { origin: false });

  // 60 req/min global; auth callbacks tighter at 10/min. /health bypassed
  // entirely so uptime monitors aren't blocked.
  // The keyGenerator partitions counts by (ip, path-family) so /api/auth
  // pressure can't use up the budget for /api/* and vice versa.
  await app.register(rateLimit, {
    max: (req) => (req.url.startsWith("/api/auth/") ? 10 : 60),
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
    keyGenerator: (req) => {
      const family = req.url.startsWith("/api/auth/") ? "auth" : "default";
      return `${family}:${req.ip}`;
    },
  });

  // Auth.js owns its own session cookies; this is just for any non-Auth.js
  // signed cookies we might set later. Reusing AUTH_SECRET as the signing
  // secret keeps key management in one place.
  await app.register(cookie, { secret: env.AUTH_SECRET });

  await app.register(sensible);

  await app.register(authPlugin);

  // SSE broker (in-memory pub/sub keyed by user). Decorates app.sseBroker
  // so any module that mutates state can publish events to subscribers.
  // Order: after auth so the broker can be safely consumed by routes; the
  // /api/events/stream route itself uses requireAuth.
  await app.register(ssePlugin);

  await app.register(healthRoute);
  await registerRoutes(app);

  if (env.NODE_ENV === "production") {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, {
      root: path.resolve(__dirname, "../web"),
      prefix: "/",
      wildcard: false,
    });
  }

  return app;
}

async function start() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled rejection");
  });

  try {
    const address = await app.listen({ host: "0.0.0.0", port: env.PORT });
    logger.info({ address }, "finance-hub server listening");
  } catch (err) {
    logger.fatal({ err }, "failed to start server");
    process.exit(1);
  }
}

start();
