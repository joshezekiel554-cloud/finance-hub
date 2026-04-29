// Mentions inbox API. Per-user "who pinged me" view that drives the
// notification bell + the dedicated mentions page.
//
// Mentions rows are written by the comments router when a comment body
// contains an @-fragment that resolves to a real user (see
// `resolveMentions` in comments.ts). This router is read-only from the
// inbox-owner's perspective: list and mark-read.
//
// NOTE: This file lives outside the original three-file ownership list
// in the brief because the API contract requires GET /api/mentions/me
// and POST /api/mentions/:id/read, which need their own prefix mount.
// Team-lead registers it alongside the others in routes/index.ts.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mentions, comments } from "../../db/schema/crm.js";
import { users } from "../../db/schema/auth.js";
import { requireAuth } from "../lib/auth.js";

const listQuerySchema = z.object({
  unread: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === true || v === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const mentionsRoute: FastifyPluginAsync = async (app) => {
  // GET /api/mentions/me — current user's mentions, newest first. Each
  // row is enriched with the by-user (avatar/name for the toast) and a
  // short snippet of the comment body so the inbox can render the row
  // without a follow-up call. ?unread=true filters to mentions whose
  // read_at is still NULL — that's the bell-badge population.
  app.get("/me", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { unread, limit, offset } = parse.data;

    const filters = [eq(mentions.mentionedUserId, user.id)];
    if (unread) filters.push(isNull(mentions.readAt));

    // Single round trip: mentions ⨝ comments ⨝ users(by). The users
    // join uses the by_user_id since the mentioned-user is always the
    // current user (filtered via WHERE).
    const rows = await db
      .select({
        mention: mentions,
        comment: {
          id: comments.id,
          body: comments.body,
        },
        byUser: {
          id: users.id,
          name: users.name,
          email: users.email,
          image: users.image,
        },
      })
      .from(mentions)
      .leftJoin(comments, eq(mentions.commentId, comments.id))
      .leftJoin(users, eq(mentions.byUserId, users.id))
      .where(and(...filters))
      .orderBy(desc(mentions.createdAt))
      .limit(limit)
      .offset(offset);

    // Flatten into the wire shape the contract calls out — Mention
    // fields at the top level + byUser + a parentSnippet pulled from
    // the comment body. Cap snippet at 200 chars; the inbox row UI
    // truncates further but we want enough text to disambiguate.
    const out = rows.map((r) => ({
      ...r.mention,
      byUser: r.byUser,
      parentSnippet: r.comment?.body
        ? r.comment.body.replace(/\s+/g, " ").trim().slice(0, 200)
        : null,
    }));

    return reply.send({ mentions: out });
  });

  // POST /api/mentions/:id/read — mark a mention read. Idempotent:
  // re-marking an already-read mention is a no-op (we do nothing
  // rather than bumping read_at to the latest timestamp; the first
  // read is the meaningful one).
  app.post("/:id/read", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;

    // Scope the update by both id and mentioned_user_id so a user can't
    // mark someone else's mention read by guessing the id. The WHERE
    // is the access control here.
    await db
      .update(mentions)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(mentions.id, id),
          eq(mentions.mentionedUserId, user.id),
          isNull(mentions.readAt),
        ),
      );

    return reply.send({ ok: true });
  });
};

export default mentionsRoute;
