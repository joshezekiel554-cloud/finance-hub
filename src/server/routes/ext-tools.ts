// GET /api/ext/tools, POST /api/ext/tools/:name — finance's read-only tools
// for the Feldart AI chatbot. The hub runs the agent loop and calls these as
// the signed-in member (hub service token, same gate as /api/ext/reports).
//
//   GET  → {tools:[{name, description, input_schema}]}   (Anthropic tool format)
//   POST {input} → 200 {result} | 400 {error} (the model sees the text) | 404

import type { FastifyPluginAsync } from "fastify";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { requireHubService } from "../lib/hub-service-auth.js";
import {
  toolByName,
  toolManifest,
  ToolInputError,
} from "../../modules/ai-tools/finance-tools.js";

const log = createLogger({ component: "routes.ext-tools" });

const extToolsRoute: FastifyPluginAsync = async (app) => {
  app.get("/tools", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    reply.header("cache-control", "private, max-age=60");
    return reply.send(toolManifest());
  });

  app.post<{ Params: { name: string } }>("/tools/:name", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    const tool = toolByName(req.params.name);
    if (!tool) return reply.code(404).send({ error: `unknown tool "${req.params.name}"` });
    const body = (req.body ?? {}) as { input?: unknown };
    const started = Date.now();
    try {
      const result = await tool.run(body.input ?? {}, {
        now: new Date(),
        baseUrl: env.PUBLIC_URL.replace(/\/$/, ""),
      });
      log.info({ email: claims.email, tool: tool.name, ms: Date.now() - started }, "tool served");
      return reply.header("cache-control", "no-store").send({ result });
    } catch (err) {
      if (err instanceof ToolInputError) {
        return reply.code(400).send({ error: err.message });
      }
      log.error({ err, email: claims.email, tool: tool.name }, "tool failed");
      return reply.code(500).send({ error: "tool failed" });
    }
  });
};

export default extToolsRoute;
