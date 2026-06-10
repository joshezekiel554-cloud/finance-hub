// GET  /api/customers/:id/ai-card             → cached row, or generates on miss.
// POST /api/customers/:id/ai-card/regenerate  → forces a fresh generation.
//
// The card is a single LLM-synthesised JSON object ({summary, actions[]}) over
// the same candidate finders that drive /autopilot, scoped to one customer.
// Stale rows (>24h) still return so the page renders instantly; the Regenerate
// button is the only path that forces a fresh call.

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../lib/auth.js";
import {
  generateCustomerCard,
  getCustomerCard,
} from "../../modules/ai-agent/customer-card.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.customer-ai-card" });

const customerAiCardRoute: FastifyPluginAsync = async (app) => {
  app.get("/:id/ai-card", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    try {
      const cached = await getCustomerCard(id);
      if (cached) {
        return reply.send({
          summary: cached.data.summary,
          summaryFeldart: cached.data.summaryFeldart,
          summaryTj: cached.data.summaryTj,
          actions: cached.data.actions,
          generatedAt: cached.generatedAt.toISOString(),
          isStale: cached.isStale,
        });
      }
      const fresh = await generateCustomerCard(id);
      return reply.send({
        summary: fresh.data.summary,
        summaryFeldart: fresh.data.summaryFeldart,
        summaryTj: fresh.data.summaryTj,
        actions: fresh.data.actions,
        generatedAt: fresh.generatedAt.toISOString(),
        isStale: false,
      });
    } catch (err) {
      log.error({ err, customerId: id }, "ai-card GET failed");
      return reply
        .code(500)
        .send({
          error: err instanceof Error ? err.message : "ai-card load failed",
        });
    }
  });

  app.post("/:id/ai-card/regenerate", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    try {
      const fresh = await generateCustomerCard(id, { force: true });
      return reply.send({
        summary: fresh.data.summary,
        summaryFeldart: fresh.data.summaryFeldart,
        summaryTj: fresh.data.summaryTj,
        actions: fresh.data.actions,
        generatedAt: fresh.generatedAt.toISOString(),
        isStale: false,
      });
    } catch (err) {
      log.error({ err, customerId: id }, "ai-card regenerate failed");
      return reply
        .code(500)
        .send({
          error: err instanceof Error ? err.message : "regenerate failed",
        });
    }
  });
};

export default customerAiCardRoute;
