// CRUD for tag_email_schedules.
//
// Operator-facing settings routes that manage recurring digest emails
// tied to a customer tag. Each row configures a recipient address,
// frequency, and content template; the cron worker (shipped in B.1)
// reads enabled rows and dispatches emails.
//
// All four routes are admin-only: they affect outbound email behaviour
// and should not be accessible to regular authenticated users.
//
// Mounting: registered in src/server/routes/index.ts at
// `/api/tag-email-schedules`.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  TAG_EMAIL_FREQUENCIES,
  TAG_EMAIL_CONTENT_TYPES,
  tagEmailSchedules,
  type TagEmailSchedule,
} from "../../db/schema/notifications.js";
import { requireAuth, isAdmin } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.tag-email-schedules" });

// ── Zod schemas ────────────────────────────────────────────────────────────

const createBodySchema = z.object({
  tag: z.string().min(1).max(64),
  recipientEmail: z.string().email(),
  frequency: z.enum(TAG_EMAIL_FREQUENCIES),
  contentType: z.enum(TAG_EMAIL_CONTENT_TYPES),
  enabled: z.boolean().optional().default(true),
});

const patchBodySchema = z
  .object({
    tag: z.string().min(1).max(64).optional(),
    recipientEmail: z.string().email().optional(),
    frequency: z.enum(TAG_EMAIL_FREQUENCIES).optional(),
    contentType: z.enum(TAG_EMAIL_CONTENT_TYPES).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "body must contain at least one field",
  });

// ── Serialise a DB row to the API shape ────────────────────────────────────

function serialise(r: TagEmailSchedule) {
  return {
    id: r.id,
    tag: r.tag,
    recipientEmail: r.recipientEmail,
    frequency: r.frequency,
    contentType: r.contentType,
    enabled: r.enabled,
    lastSentAt: r.lastSentAt ? r.lastSentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const tagEmailSchedulesRoute: FastifyPluginAsync = async (app) => {
  // GET /api/tag-email-schedules — list all schedules (admin-only).
  app.get("/", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

    const rows = await db
      .select()
      .from(tagEmailSchedules)
      .orderBy(tagEmailSchedules.tag, tagEmailSchedules.frequency);

    return reply.send({ schedules: rows.map(serialise) });
  });

  // POST /api/tag-email-schedules — create a new schedule (admin-only).
  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

    const parse = createBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }

    const { tag, recipientEmail, frequency, contentType, enabled } =
      parse.data;

    const duplicate = await db
      .select({ id: tagEmailSchedules.id })
      .from(tagEmailSchedules)
      .where(
        and(
          eq(tagEmailSchedules.tag, tag.trim().toLowerCase()),
          eq(tagEmailSchedules.recipientEmail, recipientEmail.trim().toLowerCase()),
          eq(tagEmailSchedules.frequency, frequency),
        ),
      )
      .limit(1);
    if (duplicate.length > 0) {
      reply.code(409);
      return { error: "A schedule with the same tag, recipient, and frequency already exists" };
    }

    const id = nanoid(24);

    await db.insert(tagEmailSchedules).values({
      id,
      tag: tag.trim().toLowerCase(),
      recipientEmail: recipientEmail.trim().toLowerCase(),
      frequency,
      contentType,
      enabled,
    });

    const [created] = await db
      .select()
      .from(tagEmailSchedules)
      .where(eq(tagEmailSchedules.id, id))
      .limit(1);

    log.info({ id, tag, recipientEmail, frequency }, "tag email schedule created");
    return reply.code(201).send({ schedule: serialise(created!) });
  });

  // PATCH /api/tag-email-schedules/:id — update any field (admin-only).
  app.patch("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

    const { id } = req.params as { id: string };
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }

    const existing = await db
      .select()
      .from(tagEmailSchedules)
      .where(eq(tagEmailSchedules.id, id))
      .limit(1);
    if (!existing[0]) return reply.code(404).send({ error: "schedule not found" });

    const updates: Partial<typeof tagEmailSchedules.$inferInsert> = {};
    const { tag, recipientEmail, frequency, contentType, enabled } = parse.data;
    if (tag !== undefined) updates.tag = tag.trim().toLowerCase();
    if (recipientEmail !== undefined)
      updates.recipientEmail = recipientEmail.trim().toLowerCase();
    if (frequency !== undefined) updates.frequency = frequency;
    if (contentType !== undefined) updates.contentType = contentType;
    if (enabled !== undefined) updates.enabled = enabled;

    // Duplicate check: only when at least one of the uniqueness fields is changing.
    if (tag !== undefined || recipientEmail !== undefined || frequency !== undefined) {
      const nextTag = updates.tag ?? existing[0]!.tag;
      const nextRecipient = updates.recipientEmail ?? existing[0]!.recipientEmail;
      const nextFrequency = updates.frequency ?? existing[0]!.frequency;
      const patchDuplicate = await db
        .select({ id: tagEmailSchedules.id })
        .from(tagEmailSchedules)
        .where(
          and(
            eq(tagEmailSchedules.tag, nextTag),
            eq(tagEmailSchedules.recipientEmail, nextRecipient),
            eq(tagEmailSchedules.frequency, nextFrequency),
            ne(tagEmailSchedules.id, id),
          ),
        )
        .limit(1);
      if (patchDuplicate.length > 0) {
        reply.code(409);
        return { error: "A schedule with the same tag, recipient, and frequency already exists" };
      }
    }

    await db
      .update(tagEmailSchedules)
      .set(updates)
      .where(eq(tagEmailSchedules.id, id));

    const [updated] = await db
      .select()
      .from(tagEmailSchedules)
      .where(eq(tagEmailSchedules.id, id))
      .limit(1);

    log.info({ id, updates }, "tag email schedule updated");
    return reply.send({ schedule: serialise(updated!) });
  });

  // DELETE /api/tag-email-schedules/:id — delete a schedule (admin-only).
  app.delete("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

    const { id } = req.params as { id: string };

    const existing = await db
      .select()
      .from(tagEmailSchedules)
      .where(eq(tagEmailSchedules.id, id))
      .limit(1);
    if (!existing[0]) return reply.code(404).send({ error: "schedule not found" });

    await db
      .delete(tagEmailSchedules)
      .where(eq(tagEmailSchedules.id, id));

    log.info({ id }, "tag email schedule deleted");
    return reply.send({ ok: true });
  });
};

export default tagEmailSchedulesRoute;
