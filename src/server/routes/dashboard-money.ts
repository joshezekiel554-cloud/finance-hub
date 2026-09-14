// GET /api/dashboard/money — the Money section of the finance dashboard.
// Same object the hub's Finance panel gets via /api/ext/hub-summary.money,
// so the two pages can never disagree. Cached in-process for 60 s: it's four
// aggregate queries and the underlying data only moves on QB sync (30 min).

import type { FastifyPluginAsync } from "fastify";
import { loadMoneySummary, type MoneySummary } from "../../modules/dashboard/money.js";
import { requireAuth } from "../lib/auth.js";

const TTL_MS = 60_000;
let cache: { at: number; value: MoneySummary } | null = null;

export async function getMoneySummaryCached(now = new Date()): Promise<MoneySummary> {
  if (cache && now.getTime() - cache.at < TTL_MS) return cache.value;
  const value = await loadMoneySummary(now);
  cache = { at: now.getTime(), value };
  return value;
}

const dashboardMoneyRoute: FastifyPluginAsync = async (app) => {
  app.get("/money", async (req, reply) => {
    await requireAuth(req);
    reply.header("cache-control", "private, max-age=30");
    return reply.send(await getMoneySummaryCached());
  });
};

export default dashboardMoneyRoute;
