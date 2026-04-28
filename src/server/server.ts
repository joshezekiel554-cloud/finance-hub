import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { loggerPlugin } from "./plugins/logger.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { sentryPlugin } from "./plugins/sentry.js";
import { authPlugin } from "./plugins/auth.js";
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
  //   2. sentry next — wires onError hook before app routes register
  //   3. routes (health, api)
  //   4. error handler LAST — catches downstream errors

  await app.register(loggerPlugin);
  await app.register(sentryPlugin);
  await app.register(authPlugin);

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

  // Register error handler last so it catches errors from all routes/plugins above.
  await app.register(errorHandlerPlugin);

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
