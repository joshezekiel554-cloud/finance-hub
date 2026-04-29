// Users API. Read-only directory for the @-mention picker and assignee
// dropdown. Auth.js owns the user lifecycle (create on first OAuth login,
// update via account merge) so this router intentionally has no write
// endpoints — adding a user means logging in, not POSTing here.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { asc, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/auth.js";
import { requireAuth } from "../lib/auth.js";

const listQuerySchema = z.object({
  // Optional fragment to filter on — used by the @-mention typeahead
  // and the assignee picker. Matches name OR email substring,
  // case-insensitive. Caller passes the raw text after the @ sign.
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const usersRoute: FastifyPluginAsync = async (app) => {
  // GET /api/users — list users for the picker. Sorted by name (asc)
  // so the dropdown is stable across calls; users with NULL name fall
  // to the bottom alphabetically per MySQL default. Returns the minimal
  // shape the picker needs (id/name/email/image) — we don't leak
  // emailVerified or any auth-internal fields.
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { q, limit } = parse.data;

    // Escape LIKE wildcards in the user-supplied fragment — `%` and `_`
    // would otherwise match across char boundaries (a search for "a_b"
    // matching "aXb"). Pair the escape with `ESCAPE '\\'`.
    const where =
      q && q.trim()
        ? (() => {
            const escaped = q.trim().replace(/[\\%_]/g, "\\$&");
            return or(
              sql`LOWER(${users.name}) LIKE LOWER(${`%${escaped}%`}) ESCAPE '\\'`,
              sql`LOWER(${users.email}) LIKE LOWER(${`%${escaped}%`}) ESCAPE '\\'`,
            );
          })()
        : undefined;

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(users)
      .where(where)
      .orderBy(asc(users.name))
      .limit(limit);

    return reply.send({ users: rows });
  });
};

export default usersRoute;
