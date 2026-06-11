// AI agent HTTP surface (spec 2026-06-11 §2, §6).
//
//   GET    /api/agent/me                      -> { id, email, name } (the
//          web app needs a userId for per-user threads; /api/auth/session
//          only exposes email)
//   GET    /api/agent/conversations           -> list (per-user)
//   POST   /api/agent/conversations           -> create
//   GET    /api/agent/conversations/:id       -> conversation + messages
//   POST   /api/agent/conversations/:id/message -> start a turn (fire and
//          stream: 202 immediately; progress arrives over the existing
//          /api/events/stream SSE as agent.* events; the turn finishes
//          server-side even if the client disconnects)
//   DELETE /api/agent/conversations/:id       -> archive
//
// Kill switch: app_settings.agent_enabled ("" = off) gates the message
// route only — reading history stays available so nothing looks lost.

import type { FastifyPluginAsync } from "fastify";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
import { loadAppSettings } from "../../modules/statements/settings.js";
import {
  archiveConversation,
  createConversation,
  getConversation,
  listConversations,
  listMessages,
} from "../../modules/agent/conversations.js";
import {
  isTurnInFlight,
  runAgentTurn,
  type AgentTurnEvent,
} from "../../modules/agent/loop.js";
import { registerAllAgentTools } from "../../modules/agent/tools/index.js";
import {
  ACCEPTED_MIME,
  MAX_FILE_BYTES,
  getAgentFile,
  linkAgentFile,
  readAgentFileBytes,
  saveAgentFile,
} from "../../modules/agent/files.js";
import { readAgentReportBytes } from "../../modules/agent/reports.js";
import { getBudgetStatus } from "../../modules/agent/budget.js";
import { aiInteractions } from "../../db/schema/audit.js";
import { sql } from "drizzle-orm";
import { agentReports } from "../../db/schema/agent.js";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { recordNotification } from "../../modules/notifications/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.agent" });

// Exported for the schema-export route-test pattern.
export const messageBodySchema = z.object({
  text: z.string().min(1).max(20_000),
  fileIds: z.array(z.string().min(1).max(64)).max(5).optional(),
  pageContext: z
    .object({
      page: z.string().max(256),
      customerId: z.string().max(64).optional(),
      customerName: z.string().max(256).optional(),
    })
    .nullable()
    .optional(),
});

export const createConversationBodySchema = z.object({
  title: z.string().min(1).max(256).optional(),
});

const agentRoute: FastifyPluginAsync = async (app) => {
  // All agent tools register once at boot (idempotent). Write tools are
  // declarations only — the loop proposalizes them.
  registerAllAgentTools();

  app.get("/me", async (req) => {
    const user = await requireAuth(req);
    return { id: user.id, email: user.email, name: user.name ?? null };
  });

  app.get("/conversations", async (req) => {
    const user = await requireAuth(req);
    return { conversations: await listConversations(user.id) };
  });

  app.post("/conversations", async (req, reply) => {
    const user = await requireAuth(req);
    const parsed = createConversationBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    }
    const id = await createConversation(
      user.id,
      parsed.data.title ?? "New conversation",
    );
    return reply.code(201).send({ id });
  });

  app.get("/conversations/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const conversation = await getConversation(user.id, id);
    // Cross-user ids 404 identically to missing ones (per-user threads).
    if (!conversation) return reply.code(404).send({ error: "not found" });
    const messages = await listMessages(id);
    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        turnInFlight: isTurnInFlight(id),
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    };
  });

  app.delete("/conversations/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    await archiveConversation(user.id, id);
    return reply.code(204).send();
  });




  // ── Spend dashboard (spec §11) ────────────────────────────────────────
  app.get("/spend", async (req) => {
    await requireAuth(req);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [status, bySurface, byDay] = await Promise.all([
      getBudgetStatus(now),
      db
        .select({
          surface: aiInteractions.surface,
          costUsd: sql<string>`COALESCE(SUM(${aiInteractions.costUsd}), 0)`,
          calls: sql<string>`COUNT(*)`,
        })
        .from(aiInteractions)
        .where(sql`${aiInteractions.occurredAt} >= ${monthStart}`)
        .groupBy(aiInteractions.surface),
      db
        .select({
          day: sql<string>`DATE(${aiInteractions.occurredAt})`,
          costUsd: sql<string>`COALESCE(SUM(${aiInteractions.costUsd}), 0)`,
        })
        .from(aiInteractions)
        .where(sql`${aiInteractions.occurredAt} >= ${monthStart}`)
        .groupBy(sql`DATE(${aiInteractions.occurredAt})`)
        .orderBy(sql`DATE(${aiInteractions.occurredAt})`),
    ]);
    return {
      ...status,
      bySurface: bySurface.map((r) => ({
        surface: r.surface,
        costUsd: Number(r.costUsd),
        calls: Number(r.calls),
      })),
      byDay: byDay.map((r) => ({ day: r.day, costUsd: Number(r.costUsd) })),
    };
  });

  // ── Reports library (spec §9) ─────────────────────────────────────────
  app.get("/reports", async (req) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(agentReports)
      .orderBy(desc(agentReports.createdAt))
      .limit(200);
    return { reports: rows };
  });

  app.get("/reports/:id/download", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(agentReports)
      .where(eq(agentReports.id, (req.params as { id: string }).id))
      .limit(1);
    const report = rows[0];
    if (!report) return reply.code(404).send({ error: "not found" });
    const bytes = await readAgentReportBytes(report.storagePath);
    reply.header(
      "Content-Type",
      report.kind === "pdf" ? "application/pdf" : "text/csv",
    );
    reply.header(
      "Content-Disposition",
      `attachment; filename="${report.title.replace(/[^a-z0-9 _-]/gi, "")}.${report.kind}"`,
    );
    return reply.send(bytes);
  });

  // ── Files: upload / download / link (spec §8) ─────────────────────────
  const memUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES },
  }).single("file");

  app.addContentTypeParser(
    /^multipart\/form-data/,
    (_req, _payload, done) => done(null),
  );

  app.post("/conversations/:id/files", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const conversation = await getConversation(user.id, id);
    if (!conversation) return reply.code(404).send({ error: "not found" });
    try {
      await new Promise<void>((resolve, reject) => {
        memUpload(
          req.raw as Parameters<typeof memUpload>[0],
          reply.raw as Parameters<typeof memUpload>[1],
          (err: unknown) => (err ? reject(err) : resolve()),
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "upload failed";
      return reply.code(400).send({
        error: message.includes("File too large")
          ? "file too large (max 20 MB)"
          : message,
      });
    }
    const file = (req.raw as unknown as { file?: Express.Multer.File }).file;
    if (!file) return reply.code(400).send({ error: "missing 'file' field" });
    if (!ACCEPTED_MIME[file.mimetype]) {
      return reply
        .code(400)
        .send({ error: "only PNG, JPEG, GIF, WEBP or PDF files are accepted" });
    }
    const saved = await saveAgentFile({
      buffer: file.buffer,
      filename: file.originalname,
      mime: file.mimetype,
      conversationId: id,
      uploaderUserId: user.id,
    });
    return reply
      .code(201)
      .send({ id: saved.id, filename: file.originalname, mime: file.mimetype });
  });

  app.get("/files/:id", async (req, reply) => {
    await requireAuth(req);
    const file = await getAgentFile((req.params as { id: string }).id);
    if (!file) return reply.code(404).send({ error: "not found" });
    const bytes = await readAgentFileBytes(file.storagePath);
    reply.header("Content-Type", file.mime);
    reply.header(
      "Content-Disposition",
      `inline; filename="${file.filename.replace(/"/g, "")}"`,
    );
    return reply.send(bytes);
  });

  const linkBodySchema = z
    .object({
      customerId: z.string().max(64).optional(),
      rmaId: z.string().max(64).optional(),
      invoiceId: z.string().max(64).optional(),
    })
    .refine((b) => b.customerId || b.rmaId || b.invoiceId, {
      message: "at least one of customerId/rmaId/invoiceId required",
    });

  app.post("/files/:id/link", async (req, reply) => {
    const user = await requireAuth(req);
    const parsed = linkBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    }
    const ok = await linkAgentFile(
      (req.params as { id: string }).id,
      parsed.data,
      user.id,
    );
    if (!ok) return reply.code(404).send({ error: "not found" });
    return reply.send({ ok: true });
  });

  app.post("/conversations/:id/message", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const settings = await loadAppSettings();
    if (!settings.agent_enabled || settings.agent_enabled.trim() === "") {
      return reply.code(403).send({
        error:
          "The agent is currently switched off (Settings → AI agent). Conversation history remains available.",
      });
    }

    const parsed = messageBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    }

    const conversation = await getConversation(user.id, id);
    if (!conversation) return reply.code(404).send({ error: "not found" });
    if (isTurnInFlight(id)) {
      return reply
        .code(409)
        .send({ error: "the agent is still working on the previous message" });
    }

    const messages = await listMessages(id);
    const isFirstTurn = messages.length === 0;

    // Fire the turn without awaiting — progress streams over SSE and the
    // turn survives client disconnects. Failures persist a friendly
    // assistant message + complete event inside runAgentTurn itself.
    void runAgentTurn(
      {
        conversationId: id,
        userId: user.id,
        userText: parsed.data.text,
        pageContext: parsed.data.pageContext ?? null,
        isFirstTurn,
        fileIds: parsed.data.fileIds,
      },
      {
        publish: (userId, event: AgentTurnEvent) => {
          if (event.kind === "tool") {
            app.sseBroker.publish(userId, {
              type: "agent.tool",
              conversationId: event.conversationId,
              tool: event.tool,
              ok: event.ok,
              durationMs: event.durationMs,
            });
          } else if (event.kind === "assistant") {
            app.sseBroker.publish(userId, {
              type: "agent.assistant",
              conversationId: event.conversationId,
              messageId: event.messageId,
              text: event.text,
            });
          } else {
            app.sseBroker.publish(userId, {
              type: "agent.complete",
              conversationId: event.conversationId,
              error: event.error,
            });
          }
        },
        hasSubscribers: (userId) => app.sseBroker.hasSubscribers(userId),
        notify: async ({ userId, conversationId, title }) => {
          // kind "system": NOTIFICATION_KINDS is a DB enum; a dedicated
          // agent kind would need a migration — payload title carries the
          // meaning, refType/refId let the bell deep-link later.
          await recordNotification({
            userId,
            kind: "system",
            refType: "agent_conversation",
            refId: conversationId,
            payload: { title, body: "Open the agent to see the result." },
          });
        },
      },
    ).catch((err) => {
      // runAgentTurn handles its own errors; this only fires for the
      // in-flight race losing between our check and the lock.
      log.warn({ err, conversationId: id }, "agent turn rejected at start");
    });

    return reply.code(202).send({ accepted: true, conversationId: id });
  });
};

export default agentRoute;
