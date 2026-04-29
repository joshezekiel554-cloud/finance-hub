// Email templates CRUD. Drives the Settings → Email templates UI plus
// the compose modal's template picker (consumed via GET, filtered by
// context).

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  emailTemplates,
  EMAIL_TEMPLATE_CONTEXTS,
} from "../../db/schema/email-templates.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";

const createBodySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/i, "slug must be alphanumeric/underscore"),
  name: z.string().min(1).max(255),
  context: z.enum(EMAIL_TEMPLATE_CONTEXTS),
  subject: z.string().min(1).max(512),
  body: z.string().min(1).max(50_000),
  description: z.string().max(512).optional(),
});

// Patch body — slug intentionally NOT updatable; if you need a different
// slug, create a new template and delete the old one. This keeps code
// references to slugs stable.
const patchBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  context: z.enum(EMAIL_TEMPLATE_CONTEXTS).optional(),
  subject: z.string().min(1).max(512).optional(),
  body: z.string().min(1).max(50_000).optional(),
  description: z.string().max(512).optional(),
});

const emailTemplatesRoute: FastifyPluginAsync = async (app) => {
  // GET /api/email-templates — list. Optional ?context=chase|statement|... filter.
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const querySchema = z.object({
      context: z.enum(EMAIL_TEMPLATE_CONTEXTS).optional(),
    });
    const parse = querySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const where = parse.data.context
      ? eq(emailTemplates.context, parse.data.context)
      : undefined;
    const rows = await db
      .select()
      .from(emailTemplates)
      .where(where)
      .orderBy(asc(emailTemplates.context), asc(emailTemplates.name));
    return reply.send({ rows });
  });

  app.get("/:id", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const rows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, id))
      .limit(1);
    if (!rows[0]) return reply.code(404).send({ error: "template not found" });
    return reply.send({ template: rows[0] });
  });

  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const id = nanoid(24);
    await db.insert(emailTemplates).values({ id, ...parse.data });
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "email_template.create",
      entityType: "email_template",
      entityId: id,
      before: null,
      after: parse.data,
    });
    const rows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, id))
      .limit(1);
    return reply.code(201).send({ template: rows[0]! });
  });

  app.patch("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = patchBodySchema.safeParse(req.body);
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
      .from(emailTemplates)
      .where(eq(emailTemplates.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "template not found" });

    await db
      .update(emailTemplates)
      .set(parse.data)
      .where(eq(emailTemplates.id, id));

    const afterRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, id))
      .limit(1);
    const after = afterRows[0]!;

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "email_template.update",
      entityType: "email_template",
      entityId: id,
      before,
      after,
    });

    return reply.send({ template: after });
  });

  app.delete("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const beforeRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "template not found" });
    await db.delete(emailTemplates).where(eq(emailTemplates.id, id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "email_template.delete",
      entityType: "email_template",
      entityId: id,
      before,
      after: null,
    });
    return reply.send({ ok: true });
  });
};

export default emailTemplatesRoute;
