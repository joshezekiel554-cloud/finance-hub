// GET /api/ext/tools, POST /api/ext/tools/:name — finance's tools for the
// Feldart AI chatbot. The hub runs the agent loop and calls these as the
// signed-in member (hub service token, same gate as /api/ext/reports).
//
//   GET  → {tools:[{name, description, input_schema}]}   (Anthropic tool format)
//   POST {input} → 200 {result} | 400 {error} (the model sees the text) | 403 | 404
//
// Ops tools (modules/ai-tools/ops-tools.ts) are listed and served only when
// the hub token carries ops:true AND the email is on FINANCE_AI_OPS_EMAILS —
// two independent checks, so neither side alone can widen access.

import type { FastifyPluginAsync } from "fastify";
import { env } from "../../lib/env.js";
import { signQbPdfLink } from "../../lib/file-link.js";
import type { HubTokenClaims } from "../../lib/hub-token.js";
import { createLogger } from "../../lib/logger.js";
import { isEmailAllowed } from "../lib/hub-handoff.js";
import { requireHubService } from "../lib/hub-service-auth.js";
import {
  FINANCE_TOOLS,
  ToolInputError,
  type ToolContext,
  type ToolDef,
} from "../../modules/ai-tools/finance-tools.js";
import { OPS_TOOLS } from "../../modules/ai-tools/ops-tools.js";

const log = createLogger({ component: "routes.ext-tools" });

export function hasOpsAccess(claims: Pick<HubTokenClaims, "email" | "ops">, opsEmailsCsv: string): boolean {
  return claims.ops === true && isEmailAllowed(claims.email, opsEmailsCsv);
}

/** The tools this caller may see, staff tools first. */
export function toolsFor(opsAccess: boolean): ToolDef[] {
  return opsAccess ? [...FINANCE_TOOLS, ...OPS_TOOLS] : FINANCE_TOOLS;
}

const extToolsRoute: FastifyPluginAsync = async (app) => {
  app.get("/tools", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    const tools = toolsFor(hasOpsAccess(claims, env.FINANCE_AI_OPS_EMAILS));
    reply.header("cache-control", "private, max-age=60");
    return reply.send({ tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })) });
  });

  app.post<{ Params: { name: string } }>("/tools/:name", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    const opsAccess = hasOpsAccess(claims, env.FINANCE_AI_OPS_EMAILS);
    const tool = [...FINANCE_TOOLS, ...OPS_TOOLS].find((t) => t.name === req.params.name);
    if (!tool) return reply.code(404).send({ error: `unknown tool "${req.params.name}"` });
    if (tool.ops && !opsAccess) {
      log.warn({ email: claims.email, tool: tool.name, opsClaim: claims.ops }, "ops tool refused");
      return reply.code(403).send({ error: `"${tool.name}" isn't available for this user.` });
    }
    const body = (req.body ?? {}) as { input?: unknown };
    const baseUrl = env.PUBLIC_URL.replace(/\/$/, "");
    const secret = env.HUB_SSO_SECRET;
    const ctx: ToolContext = {
      now: new Date(),
      baseUrl,
      ...(tool.ops && secret
        ? {
            signPdf: (kind, qbId, name) =>
              signQbPdfLink({ baseUrl, secret, kind, qbId, name, nowSeconds: Math.floor(Date.now() / 1000) }),
          }
        : {}),
    };
    const started = Date.now();
    try {
      const result = await tool.run(body.input ?? {}, ctx);
      log.info({ email: claims.email, tool: tool.name, ops: tool.ops === true, ms: Date.now() - started }, "tool served");
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
