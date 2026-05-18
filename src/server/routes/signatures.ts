import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { userSignatures } from "../../db/schema/user-signatures.js";
import { aliasSignatures } from "../../db/schema/alias-signatures.js";
import { users } from "../../db/schema/auth.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  MAX_SIGNATURE_BYTES,
  sanitizeSignatureHtml,
} from "../../modules/email-compose/signatures.js";
import { requireAuth } from "../lib/auth.js";

const createUserSigSchema = z.object({
  name: z.string().min(1).max(64),
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES),
  isDefault: z.boolean().optional(),
});

const patchUserSigSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES).optional(),
  isDefault: z.boolean().optional(),
});

const patchAliasSigSchema = z.object({
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES),
});

const signaturesRoute: FastifyPluginAsync = async (app) => {
  // ----- User signatures (per current user) -----

  app.get("/me/signatures", async (req, reply) => {
    const user = await requireAuth(req);
    const rows = await db
      .select()
      .from(userSignatures)
      .where(eq(userSignatures.userId, user.id))
      .orderBy(desc(userSignatures.isDefault), asc(userSignatures.name));
    return reply.send({ rows });
  });

  app.post("/me/signatures", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createUserSigSchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(parse.error.issues.some((i) => i.code === "too_big") ? 413 : 400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const sanitizedHtml = sanitizeSignatureHtml(parse.data.html);
    const id = nanoid(24);
    const isDefault = parse.data.isDefault ?? false;

    await db.transaction(async (tx) => {
      if (isDefault) {
        await tx
          .update(userSignatures)
          .set({ isDefault: false })
          .where(eq(userSignatures.userId, user.id));
      }
      await tx.insert(userSignatures).values({
        id,
        userId: user.id,
        name: parse.data.name,
        html: sanitizedHtml,
        isDefault,
      });
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "user_signature.create",
        entityType: "user_signature",
        entityId: id,
        before: null,
        after: { name: parse.data.name, isDefault },
      });
    });

    const rows = await db
      .select()
      .from(userSignatures)
      .where(eq(userSignatures.id, id))
      .limit(1);
    return reply.send({ row: rows[0] });
  });

  app.patch("/me/signatures/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = patchUserSigSchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(parse.error.issues.some((i) => i.code === "too_big") ? 413 : 400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }

    const beforeRows = await db
      .select()
      .from(userSignatures)
      .where(
        and(eq(userSignatures.id, id), eq(userSignatures.userId, user.id)),
      )
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "signature not found" });

    const update: Partial<typeof before> = {};
    if (parse.data.name !== undefined) update.name = parse.data.name;
    if (parse.data.html !== undefined) {
      update.html = sanitizeSignatureHtml(parse.data.html);
    }
    if (parse.data.isDefault !== undefined) update.isDefault = parse.data.isDefault;

    await db.transaction(async (tx) => {
      if (parse.data.isDefault === true) {
        await tx
          .update(userSignatures)
          .set({ isDefault: false })
          .where(eq(userSignatures.userId, user.id));
      }
      await tx
        .update(userSignatures)
        .set(update)
        .where(eq(userSignatures.id, id));
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "user_signature.update",
        entityType: "user_signature",
        entityId: id,
        before: { name: before.name, isDefault: before.isDefault },
        after: { ...before, ...update },
      });
    });

    const afterRows = await db
      .select()
      .from(userSignatures)
      .where(eq(userSignatures.id, id))
      .limit(1);
    return reply.send({ row: afterRows[0] });
  });

  app.delete("/me/signatures/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const beforeRows = await db
      .select()
      .from(userSignatures)
      .where(
        and(eq(userSignatures.id, id), eq(userSignatures.userId, user.id)),
      )
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "signature not found" });

    await db.transaction(async (tx) => {
      await tx.delete(userSignatures).where(eq(userSignatures.id, id));
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "user_signature.delete",
        entityType: "user_signature",
        entityId: id,
        before: { name: before.name, isDefault: before.isDefault },
        after: null,
      });
    });

    return reply.send({ ok: true });
  });

  // ----- Alias signatures (shared) -----

  app.get("/alias-signatures", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select({
        aliasEmail: aliasSignatures.aliasEmail,
        html: aliasSignatures.html,
        updatedByUserId: aliasSignatures.updatedByUserId,
        updatedAt: aliasSignatures.updatedAt,
        updatedByEmail: users.email,
      })
      .from(aliasSignatures)
      .leftJoin(users, eq(users.id, aliasSignatures.updatedByUserId))
      .orderBy(asc(aliasSignatures.aliasEmail));
    return reply.send({ rows });
  });

  app.patch("/alias-signatures/:email", async (req, reply) => {
    const user = await requireAuth(req);
    const aliasEmail = decodeURIComponent(
      (req.params as { email: string }).email,
    ).toLowerCase();
    const parse = patchAliasSigSchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(parse.error.issues.some((i) => i.code === "too_big") ? 413 : 400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const sanitizedHtml = sanitizeSignatureHtml(parse.data.html);

    const beforeRows = await db
      .select()
      .from(aliasSignatures)
      .where(eq(aliasSignatures.aliasEmail, aliasEmail))
      .limit(1);
    const before = beforeRows[0] ?? null;

    if (before) {
      await db
        .update(aliasSignatures)
        .set({ html: sanitizedHtml, updatedByUserId: user.id })
        .where(eq(aliasSignatures.aliasEmail, aliasEmail));
    } else {
      await db.insert(aliasSignatures).values({
        aliasEmail,
        html: sanitizedHtml,
        updatedByUserId: user.id,
      });
    }

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: before ? "alias_signature.update" : "alias_signature.create",
      entityType: "alias_signature",
      entityId: aliasEmail,
      before: before ? { html: before.html } : null,
      after: { html: sanitizedHtml },
    });

    const afterRows = await db
      .select()
      .from(aliasSignatures)
      .where(eq(aliasSignatures.aliasEmail, aliasEmail))
      .limit(1);
    return reply.send({ row: afterRows[0] });
  });
};

export default signaturesRoute;
