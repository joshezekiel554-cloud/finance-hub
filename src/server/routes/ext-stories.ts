// Customer stories for the hub's Chief of Staff panel (phase 3, "it knows the
// story", operator approved 2026-11-19). Same gate as /api/ext/signals: a
// hub service token whose email is a finance admin (ADMIN_EMAILS); anyone
// else gets 403. Always cache-control: no-store.
//
//   GET /customers/story?id=<customerId> | ?email=<addr>
//     → {customer:{id,name,emails[]}, money, payBehaviour, promises, buying,
//        timeline, generatedAt}   400 neither given · 404 unknown
//   GET /customers/stories?changedSince=<ISO>&cursor=<opaque>&limit=≤50
//     → {stories:[...], nextCursor|null}  customers with anything new since
//        changedSince (capped at 2 years back; default = 2 years), by id.

import type { FastifyPluginAsync } from "fastify";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { isEmailAllowed } from "../lib/hub-handoff.js";
import { requireHubService } from "../lib/hub-service-auth.js";
import { changedCustomerIds, findCustomerIdByEmail, loadStories } from "../../modules/hub-stories/load.js";
import { STORY_RULES } from "../../modules/hub-stories/story.js";

const log = createLogger({ component: "routes.ext-stories" });

export const STORIES_DEFAULT_LIMIT = 25;
export const STORIES_MAX_LIMIT = 50;

type Cursor = { after: string; since: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString()) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { after, since } = v as Record<string, unknown>;
    if (typeof after !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(after)) return null;
    if (typeof since !== "string" || !Number.isFinite(Date.parse(since))) return null;
    return { after, since };
  } catch {
    return null;
  }
}

/** changedSince → the effective lower bound (never more than 2 years back). */
export function effectiveSince(raw: string | undefined, now: Date): Date | null {
  const floor = new Date(now.getTime() - STORY_RULES.lookbackDays * 86_400_000);
  if (raw === undefined || raw === "") return floor;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return t < floor.getTime() ? floor : new Date(t);
}

const baseUrl = () => env.PUBLIC_URL.replace(/\/$/, "");

export const storiesRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { id?: string; email?: string } }>("/customers/story", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    reply.header("cache-control", "no-store");
    if (!isEmailAllowed(claims.email, env.ADMIN_EMAILS)) {
      return reply.code(403).send({ error: "Customer stories are for finance admins only." });
    }
    const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
    const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (!id && !email) return reply.code(400).send({ error: "expected ?id=<customerId> or ?email=<address>" });
    if (id && !/^[A-Za-z0-9_-]{1,24}$/.test(id)) return reply.code(404).send({ error: "unknown customer" });

    const started = Date.now();
    const customerId = id || (await findCustomerIdByEmail(email));
    if (!customerId) return reply.code(404).send({ error: "unknown customer" });
    const [story] = await loadStories([customerId], { now: new Date(), baseUrl: baseUrl() });
    if (!story) return reply.code(404).send({ error: "unknown customer" });
    log.info({ email: claims.email, customerId, by: id ? "id" : "email", ms: Date.now() - started }, "story served");
    return reply.send(story);
  });

  app.get<{ Querystring: { changedSince?: string; cursor?: string; limit?: string } }>("/customers/stories", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    reply.header("cache-control", "no-store");
    if (!isEmailAllowed(claims.email, env.ADMIN_EMAILS)) {
      return reply.code(403).send({ error: "Customer stories are for finance admins only." });
    }
    const now = new Date();
    let limit = STORIES_DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isInteger(n) || n < 1) return reply.code(400).send({ error: `limit must be 1-${STORIES_MAX_LIMIT}` });
      limit = Math.min(n, STORIES_MAX_LIMIT);
    }
    let cursor: Cursor | null = null;
    if (req.query.cursor) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) return reply.code(400).send({ error: "bad cursor" });
    }
    // A cursor carries the since it was minted with, so paging stays stable.
    const since = effectiveSince(cursor ? cursor.since : req.query.changedSince, now);
    if (!since) return reply.code(400).send({ error: "changedSince must be an ISO date-time" });

    const started = Date.now();
    const ids = await changedCustomerIds({ since, afterId: cursor?.after ?? null, limit: limit + 1 });
    const page = ids.slice(0, limit);
    const stories = await loadStories(page, { now, baseUrl: baseUrl() });
    const last = page[page.length - 1];
    const nextCursor = ids.length > limit && last ? encodeCursor({ after: last, since: since.toISOString() }) : null;
    log.info({ email: claims.email, stories: stories.length, more: nextCursor !== null, ms: Date.now() - started }, "stories served");
    return reply.send({ stories, nextCursor, generatedAt: now.toISOString() });
  });
};

export default storiesRoute;
