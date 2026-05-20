// AI-training routes.
//
//   POST /api/ai-training/voice-guide/regenerate — re-distill the voice
//     guide from templates + recent outbound emails (overwrites the
//     app_settings.ai_voice_guide row; the UI warns before calling).
//
// Mounting: registered in src/server/routes/index.ts at /api/ai-training.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireAuth } from "../lib/auth.js";
import { db } from "../../db/index.js";
import { aiCompanyFacts } from "../../db/schema/ai-company-facts.js";
import { auditLog } from "../../db/schema/audit.js";
import { runVoiceGuideSeed } from "../../modules/ai-agent/voice-seed.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.ai-training" });

const aiTrainingRoute: FastifyPluginAsync = async (app) => {
  app.post("/voice-guide/regenerate", async (req, reply) => {
    const user = await requireAuth(req);
    try {
      const { words } = await runVoiceGuideSeed(user.id);
      return reply.send({ ok: true, words });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "voice guide regenerate failed");
      return reply.code(500).send({ error: "regenerate failed", detail: msg });
    }
  });

  // GET /api/ai-training/facts — list all (active + retired) for management.
  app.get("/facts", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(aiCompanyFacts)
      .orderBy(desc(aiCompanyFacts.createdAt));
    return reply.send({ facts: rows });
  });

  // POST /api/ai-training/facts — create.
  app.post("/facts", async (req, reply) => {
    const user = await requireAuth(req);
    const schema = z.object({
      fact: z.string().min(1).max(4000),
      tags: z.array(z.string().min(1).max(64)).max(20).default([]),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const id = nanoid(24);
    await db.insert(aiCompanyFacts).values({
      id,
      fact: parse.data.fact,
      tags: parse.data.tags,
      createdByUserId: user.id,
    });
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "ai_company_fact.create",
      entityType: "ai_company_fact",
      entityId: id,
      before: null,
      after: { fact: parse.data.fact, tags: parse.data.tags },
    });
    return reply.code(201).send({ id });
  });

  // PATCH /api/ai-training/facts/:id — edit text/tags or retire (active=false).
  app.patch<{ Params: { id: string } }>("/facts/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const schema = z.object({
      fact: z.string().min(1).max(4000).optional(),
      tags: z.array(z.string().min(1).max(64)).max(20).optional(),
      active: z.boolean().optional(),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    if (Object.keys(parse.data).length === 0) {
      return reply.code(400).send({ error: "no fields to update" });
    }
    const beforeRows = await db
      .select()
      .from(aiCompanyFacts)
      .where(eq(aiCompanyFacts.id, req.params.id))
      .limit(1);
    if (!beforeRows[0]) return reply.code(404).send({ error: "not found" });
    await db
      .update(aiCompanyFacts)
      .set(parse.data)
      .where(eq(aiCompanyFacts.id, req.params.id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "ai_company_fact.update",
      entityType: "ai_company_fact",
      entityId: req.params.id,
      before: beforeRows[0],
      after: parse.data,
    });
    return reply.send({ ok: true });
  });

  // DELETE /api/ai-training/facts/:id — hard delete.
  app.delete<{ Params: { id: string } }>("/facts/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const beforeRows = await db
      .select()
      .from(aiCompanyFacts)
      .where(eq(aiCompanyFacts.id, req.params.id))
      .limit(1);
    if (!beforeRows[0]) return reply.code(404).send({ error: "not found" });
    await db.delete(aiCompanyFacts).where(eq(aiCompanyFacts.id, req.params.id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "ai_company_fact.delete",
      entityType: "ai_company_fact",
      entityId: req.params.id,
      before: beforeRows[0],
      after: null,
    });
    return reply.code(204).send();
  });
};

export default aiTrainingRoute;
