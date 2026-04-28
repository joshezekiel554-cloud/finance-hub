import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { env } from "~/lib/env.js";

type CheckResult = "ok" | "fail" | "skipped";

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} check timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function checkDb(req: FastifyRequest): Promise<CheckResult> {
  try {
    // Prefer the shared drizzle pool that schema-designer publishes at ~/db.
    // Fall back to an ephemeral mysql2 connection so /health works pre-schema.
    let runQuery: () => Promise<unknown>;
    try {
      const dbModule = (await import("~/db/index.js")) as {
        pool?: { query: (sql: string) => Promise<unknown> };
      };
      if (dbModule.pool) {
        const pool = dbModule.pool;
        runQuery = () => pool.query("SELECT 1");
      } else {
        throw new Error("pool not exported");
      }
    } catch {
      const mysql = await import("mysql2/promise");
      runQuery = async () => {
        const conn = await mysql.createConnection({ uri: env.DATABASE_URL });
        try {
          await conn.query("SELECT 1");
        } finally {
          await conn.end();
        }
      };
    }

    await withTimeout(runQuery(), CHECK_TIMEOUT_MS, "db");
    return "ok";
  } catch (err) {
    req.log.warn({ err }, "health: db check failed");
    return "fail";
  }
}

async function checkRedis(req: FastifyRequest): Promise<CheckResult> {
  if (!env.REDIS_URL) return "skipped";

  let client: Redis | undefined;
  try {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: CHECK_TIMEOUT_MS,
    });
    await withTimeout(client.connect(), CHECK_TIMEOUT_MS, "redis-connect");
    const pong = await withTimeout(client.ping(), CHECK_TIMEOUT_MS, "redis-ping");
    return pong === "PONG" ? "ok" : "fail";
  } catch (err) {
    req.log.warn({ err }, "health: redis check failed");
    return "fail";
  } finally {
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore
      }
    }
  }
}

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/health", async (req: FastifyRequest, reply: FastifyReply) => {
    const [db, redis] = await Promise.all([checkDb(req), checkRedis(req)]);

    const allOk = db !== "fail" && redis !== "fail";
    const status = allOk ? "ok" : "degraded";

    // Be lenient in dev: dependencies may not be running locally.
    const httpCode = allOk ? 200 : env.NODE_ENV === "production" ? 503 : 200;

    reply.code(httpCode).send({
      status,
      checks: { db, redis },
      env: env.NODE_ENV,
      uptime: process.uptime(),
      request_id: req.id,
    });
  });
}
