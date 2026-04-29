// Comments API + mention resolver.
//
// Two surfaces live here:
//   1. The exported `resolveMentions` helper that the tasks router uses
//      when a comment is created on a task. Lives here so the parsing,
//      lookup, dedupe, and SSE-emission logic has one source of truth.
//   2. PATCH /api/comments/:id and DELETE /api/comments/:id — own-only
//      edit/delete of any comment regardless of parent type. Creation
//      happens on the parent's router (POST /api/tasks/:id/comments)
//      because that's where the parent existence check naturally lives.
//
// Mention notes:
//   - Body matches /@([\w.-]+)/ — alphanumerics, dot, dash, underscore.
//     Sufficient for our user table where names are display-name-cased
//     and emails are the underlying identity.
//   - We resolve a fragment by case-insensitive prefix on email AND
//     case-insensitive substring on name. Multiple matches → write one
//     mention row per user (and one SSE event per).
//   - Self-mentions are dropped silently — @-mentioning yourself in a
//     comment is allowed in the prose but doesn't fire a notification.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  comments,
  mentions,
  type Mention,
  type NewMention,
} from "../../db/schema/crm.js";
import { users } from "../../db/schema/auth.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.comments" });

const editBodySchema = z.object({
  body: z.string().min(1).max(10_000),
});

// ---------------------------------------------------------------------
// Mention parsing + resolution. Exported so tasks.ts can call it from
// the create-comment endpoint without duplicating the logic.
// ---------------------------------------------------------------------

const MENTION_RX = /@([\w.-]+)/g;

export function parseMentions(body: string): string[] {
  const matches = new Set<string>();
  // Reset lastIndex defensively — global RegExps maintain state and a
  // leftover index from a previous call would skip the head of the next
  // string. The reassignment below avoids needing to reset.
  let m: RegExpExecArray | null;
  const rx = new RegExp(MENTION_RX.source, "g");
  while ((m = rx.exec(body)) !== null) {
    const fragment = m[1];
    if (fragment) matches.add(fragment);
  }
  return Array.from(matches);
}

export type ResolveMentionsArgs = {
  body: string;
  commentId: string;
  byUserId: string;
  parentType: string;
  parentId: string;
  // Mention rows already on this comment (when re-resolving for an edit).
  // Used to skip writing duplicates and to skip emitting events for
  // mentions that already existed.
  existingMentionedUserIds: string[];
};

// Resolves @-fragments to user rows, writes new mention rows, emits
// per-user "mention" events for the new ones, and returns the full set
// of mention rows that now exist on this comment.
export async function resolveMentions(
  args: ResolveMentionsArgs,
): Promise<Mention[]> {
  const { body, commentId, byUserId, parentType, parentId } = args;
  const fragments = parseMentions(body);
  if (fragments.length === 0) return [];

  // Build an OR of (name LIKE %frag% OR email LIKE frag%) for each
  // fragment. We match name as a substring because display names like
  // "Joshua Ezekiel" should match @joshua, @ezekiel, AND @joshua.ezekiel.
  // Email match is prefix-only because that's how @-handles map: the
  // local-part of a corporate email is the canonical handle.
  const orClauses = fragments.flatMap((frag) => [
    sql`LOWER(${users.name}) LIKE LOWER(${`%${frag}%`})`,
    sql`LOWER(${users.email}) LIKE LOWER(${`${frag}%`})`,
  ]);

  const matched = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(or(...orClauses));

  // Dedupe by id, drop self-mentions. Order doesn't matter for the
  // mention rows themselves, but we want a stable iteration order so
  // tests are deterministic.
  const seen = new Set<string>(args.existingMentionedUserIds);
  const toInsert: NewMention[] = [];
  const toEmit: { mentionedUserId: string }[] = [];
  for (const u of matched) {
    if (u.id === byUserId) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    const id = nanoid(24);
    toInsert.push({
      id,
      commentId,
      mentionedUserId: u.id,
      byUserId,
      parentType,
      parentId,
    });
    toEmit.push({ mentionedUserId: u.id });
  }

  if (toInsert.length > 0) {
    await db.insert(mentions).values(toInsert);
  }

  // Excerpt for the toast/notification: first ~140 chars of the comment
  // body, single-spaced. Newlines turn into spaces so the toast doesn't
  // break across lines awkwardly.
  const excerpt = body
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  for (const ev of toEmit) {
    events.emit("mention", {
      mentionedUserId: ev.mentionedUserId,
      byUserId,
      parentType,
      parentId,
      excerpt,
    });
  }

  // Return the FULL set of mentions on this comment (existing + new)
  // so callers can include them in the response payload.
  const allRows = await db
    .select()
    .from(mentions)
    .where(eq(mentions.commentId, commentId));
  return allRows;
}

// ---------------------------------------------------------------------
// Routes mounted at /api/comments
// ---------------------------------------------------------------------

const commentsRoute: FastifyPluginAsync = async (app) => {
  // PATCH /api/comments/:id — edit your own comment. Sets editedAt to
  // now and re-resolves mentions. Note the no-decrement policy: if the
  // edit removes an @-mention, the existing mention row is left in
  // place — it's already a notification trail and pulling it would
  // erase the bell ping the user already saw. Only NEW mentions in the
  // edit fire fresh events.
  app.patch("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = editBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { body } = parse.data;

    const beforeRows = await db
      .select()
      .from(comments)
      .where(eq(comments.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "comment not found" });
    if (before.userId !== user.id) {
      return reply.code(403).send({ error: "not your comment" });
    }

    const editedAt = new Date();
    await db
      .update(comments)
      .set({ body, editedAt })
      .where(eq(comments.id, id));

    const afterRows = await db
      .select()
      .from(comments)
      .where(eq(comments.id, id))
      .limit(1);
    const after = afterRows[0]!;

    // Pull existing mentions so resolveMentions can skip them when
    // emitting events. Without this, every edit would re-fire mention
    // events for users who were already pinged.
    const existing = await db
      .select({ mentionedUserId: mentions.mentionedUserId })
      .from(mentions)
      .where(eq(mentions.commentId, id));
    const existingIds = existing.map((r) => r.mentionedUserId);

    const updatedMentions = await resolveMentions({
      body,
      commentId: id,
      byUserId: user.id,
      parentType: before.parentType,
      parentId: before.parentId,
      existingMentionedUserIds: existingIds,
    });

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "comment.update",
      entityType: "comment",
      entityId: id,
      before: {
        id: before.id,
        body: before.body,
        editedAt: before.editedAt ? before.editedAt.toISOString() : null,
      },
      after: {
        id: after.id,
        body: after.body,
        editedAt: after.editedAt ? after.editedAt.toISOString() : null,
      },
    });

    return reply.send({ comment: after, mentions: updatedMentions });
  });

  // DELETE /api/comments/:id — delete your own comment. The mentions
  // table cascades on comment delete, so the bell-inbox naturally
  // sheds entries pointing at a deleted comment. The audit row keeps
  // a copy of the body for post-mortem review.
  app.delete("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const beforeRows = await db
      .select()
      .from(comments)
      .where(eq(comments.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "comment not found" });
    if (before.userId !== user.id) {
      return reply.code(403).send({ error: "not your comment" });
    }

    await db.delete(comments).where(eq(comments.id, id));

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "comment.delete",
      entityType: "comment",
      entityId: id,
      before: {
        id: before.id,
        parentType: before.parentType,
        parentId: before.parentId,
        body: before.body,
        createdAt: before.createdAt.toISOString(),
      },
      after: null,
    });

    log.info({ commentId: id, userId: user.id }, "comment deleted");

    return reply.send({ ok: true });
  });
};

export default commentsRoute;
