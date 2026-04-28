import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "../lib/env.js";
import { registerRoutes } from "./routes/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    disableRequestLogging: true,
  });

  // Placeholder plugin registration. Wired up in later phases:
  //   - logger (pino) — observability task
  //   - db (drizzle + postgres) — schema task
  //   - auth (sessions + arctic) — auth task
  //   - queue (bullmq + redis) — sync task
  //   - sse broker — notifications task

  // Health check placeholder. Observability task replaces with full readiness probe.
  app.get("/health", async () => ({
    status: "ok",
    env: env.NODE_ENV,
    uptime: process.uptime(),
  }));

  await registerRoutes(app);

  if (env.NODE_ENV === "production") {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, {
      root: path.resolve(__dirname, "../web"),
      prefix: "/",
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/oauth")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}

async function start() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info?.({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      console.error("error during shutdown", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const address = await app.listen({ host: "0.0.0.0", port: env.PORT });
    console.log(`finance-hub server listening at ${address} (${env.NODE_ENV})`);
  } catch (err) {
    console.error("failed to start server", err);
    process.exit(1);
  }
}

start();
