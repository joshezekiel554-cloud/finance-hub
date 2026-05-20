// AI-training routes.
//
//   POST /api/ai-training/voice-guide/regenerate — re-distill the voice
//     guide from templates + recent outbound emails (overwrites the
//     app_settings.ai_voice_guide row; the UI warns before calling).
//
// Mounting: registered in src/server/routes/index.ts at /api/ai-training.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireAuth } from "../lib/auth.js";
import { db } from "../../db/index.js";
import { aiCompanyFacts } from "../../db/schema/ai-company-facts.js";
import { aiLearnedCorrections } from "../../db/schema/ai-learned-corrections.js";
import { auditLog } from "../../db/schema/audit.js";
import { runVoiceGuideSeed } from "../../modules/ai-agent/voice-seed.js";
import { runCorrectionsDistill } from "../../modules/ai-agent/corrections.js";
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

  // POST /api/ai-training/corrections/distill — on-demand "learn from edits".
  app.post("/corrections/distill", async (req, reply) => {
    const user = await requireAuth(req);
    try {
      const result = await runCorrectionsDistill(user.id);
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "distill failed");
      return reply.code(500).send({ error: "distill failed", detail: msg });
    }
  });

  // GET /api/ai-training/corrections — list (proposed + active + others).
  app.get("/corrections", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(aiLearnedCorrections)
      .orderBy(desc(aiLearnedCorrections.createdAt));
    return reply.send({ corrections: rows });
  });

  // PATCH /api/ai-training/corrections/:id — approve/reject/retire/edit.
  app.patch<{ Params: { id: string } }>(
    "/corrections/:id",
    async (req, reply) => {
      const user = await requireAuth(req);
      const schema = z.object({
        correction: z.string().min(1).max(4000).optional(),
        tags: z.array(z.string().min(1).max(64)).max(20).optional(),
        status: z.enum(["proposed", "active", "rejected", "retired"]).optional(),
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
        .from(aiLearnedCorrections)
        .where(eq(aiLearnedCorrections.id, req.params.id))
        .limit(1);
      if (!beforeRows[0]) return reply.code(404).send({ error: "not found" });
      const writeSet: Record<string, unknown> = { ...parse.data };
      if (parse.data.status) {
        writeSet.decidedByUserId = user.id;
        writeSet.decidedAt = sql`CURRENT_TIMESTAMP`;
      }
      await db
        .update(aiLearnedCorrections)
        .set(writeSet)
        .where(eq(aiLearnedCorrections.id, req.params.id));
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "ai_learned_correction.update",
        entityType: "ai_learned_correction",
        entityId: req.params.id,
        before: beforeRows[0],
        after: parse.data,
      });
      return reply.send({ ok: true });
    },
  );
};

export default aiTrainingRoute;
