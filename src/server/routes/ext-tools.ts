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
import { signQbPdfLink, signStatementLink } from "../../lib/file-link.js";
import type { HubTokenClaims } from "../../lib/hub-token.js";
import { createLogger } from "../../lib/logger.js";
import { isEmailAllowed } from "../lib/hub-handoff.js";
import { financeLinkSecret, requireHubService } from "../lib/hub-service-auth.js";
import {
  FINANCE_TOOLS,
  ToolInputError,
  type ToolContext,
  type ToolDef,
} from "../../modules/ai-tools/finance-tools.js";
import { OPS_FINANCE_READS } from "../../modules/ai-tools/ops-finance-reads.js";
import { financeUserIdFor, OPS_FINANCE_WRITES } from "../../modules/ai-tools/ops-finance-writes.js";
import { settleHubProposal } from "../../modules/ai-tools/ops-proposals.js";
import { OPS_QBO_TOOLS } from "../../modules/ai-tools/qbo-tools.js";
import { OPS_MONEY_READS } from "../../modules/ai-tools/ops-money-reads.js";
import { loadFinanceAlerts } from "../../modules/ai-tools/alerts.js";
import { OPS_TOOLS as OPS_CORE } from "../../modules/ai-tools/ops-tools.js";

export const OPS_TOOLS: ToolDef[] = [...OPS_CORE, ...OPS_FINANCE_READS, ...OPS_MONEY_READS, ...OPS_QBO_TOOLS, ...OPS_FINANCE_WRITES];

const log = createLogger({ component: "routes.ext-tools" });

export function hasOpsAccess(claims: Pick<HubTokenClaims, "email" | "ops">, opsEmailsCsv: string): boolean {
  return claims.ops === true && isEmailAllowed(claims.email, opsEmailsCsv);
}

/**
 * Manifest entry. "x-feldart-effect" (tool level, hub-only — never sent to
 * the model) tells the hub what a call does: scheduled/unattended runs only
 * ever call "read" tools; "propose" tools return a Confirm card.
 */
export function manifestEntry(t: ToolDef) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    "x-feldart-effect": t.write ? ("propose" as const) : ("read" as const),
  };
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
    // The list differs per caller (ops vs not) — never let a cache share it.
    reply.header("cache-control", "no-store").header("vary", "Authorization");
    return reply.send({ tools: tools.map(manifestEntry) });
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
    const secret = financeLinkSecret();
    const ctx: ToolContext = {
      now: new Date(),
      baseUrl,
      actorEmail: claims.email,
      ...(tool.ops && secret
        ? {
            signPdf: (kind, qbId, name) =>
              signQbPdfLink({ baseUrl, secret, kind, qbId, name, nowSeconds: Math.floor(Date.now() / 1000) }),
            signStatement: (customerId, origin, byUserId, name) =>
              signStatementLink({ baseUrl, secret, customerId, origin, byUserId, name, nowSeconds: Math.floor(Date.now() / 1000) }),
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

// POST /api/ext/proposals/:id/confirm|cancel — the hub forwards a Confirm /
// Cancel click with a fresh ops token. Body is ignored.
export const proposalsRoute: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string; action: string } }>("/proposals/:id/:action", async (req, reply) => {
    // A confirm-scoped token must be bound to THIS proposal; plain service
    // tokens stop working here once HUB_CONFIRM_TOKENS_REQUIRED is set.
    const claims = requireHubService(req, reply, {
      kind: "settle",
      proposalId: req.params.id,
      confirmRequired: env.HUB_CONFIRM_TOKENS_REQUIRED,
    });
    if (!claims) return reply;
    if (!hasOpsAccess(claims, env.FINANCE_AI_OPS_EMAILS)) {
      return reply.code(403).send({ error: "Not available for this user.", code: "forbidden" });
    }
    const { id, action } = req.params;
    if ((action !== "confirm" && action !== "cancel") || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      return reply.code(404).send({ error: "unknown proposal action", code: "expired" });
    }
    const res = await settleHubProposal({
      id,
      action,
      actorEmail: claims.email,
      userId: await financeUserIdFor(claims.email),
    });
    log.info({ email: claims.email, proposalId: id, action, http: res.http }, "hub proposal settled");
    return reply.code(res.http).header("cache-control", "no-store").send(res.body);
  });
};

export default extToolsRoute;

// GET /api/ext/alerts — finance's checks for the hub scheduler (ops only).
export const alertsRoute: FastifyPluginAsync = async (app) => {
  app.get("/alerts", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    if (!hasOpsAccess(claims, env.FINANCE_AI_OPS_EMAILS)) {
      return reply.code(403).send({ error: "Not available for this user." });
    }
    const started = Date.now();
    const res = await loadFinanceAlerts({ now: new Date(), baseUrl: env.PUBLIC_URL.replace(/\/$/, "") });
    log.info({ email: claims.email, alerts: res.alerts.length, ms: Date.now() - started }, "alerts served");
    return reply.header("cache-control", "no-store").send(res);
  });
};
