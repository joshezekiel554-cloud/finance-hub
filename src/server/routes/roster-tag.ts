// Roster-tag import. Apply a single tag (e.g. "yiddy") to many
// customers in one go by name. Two-phase: a preview pass that
// reports matches without writing, then an apply pass that commits.
//
// Used today for Yiddy's commission roster (~120 stores) but the
// shape is generic — any tag, any name list. Mirrors the one-shot
// scripts/tag-yiddy-roster.ts logic but exposes it through the UI
// so the operator doesn't need to edit a TS file every refresh of
// the roster.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.roster-tag" });

const bodySchema = z.object({
  // The tag to apply. Lower-cased + trimmed before write so matching
  // against email_routing_rules stays case-insensitive.
  tag: z.string().min(1).max(64),
  // Display names to match against customers.display_name. We accept
  // the raw list and dedupe + normalise server-side; frontend can
  // trust the wire format to stay simple.
  names: z.array(z.string().min(1).max(500)).min(1).max(2000),
  // false → preview only (no writes), true → write the tags.
  apply: z.boolean().default(false),
});

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

const rosterTagRoute: FastifyPluginAsync = async (app) => {
  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = bodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({
        error: "invalid body",
        details: parse.error.flatten(),
      });
    }
    const tag = parse.data.tag.trim().toLowerCase();
    const apply = parse.data.apply;

    // Dedupe input names by normalised form so a roster with the same
    // store listed twice doesn't double-count.
    const inputByNorm = new Map<string, string>();
    for (const raw of parse.data.names) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = norm(trimmed);
      if (!inputByNorm.has(key)) inputByNorm.set(key, trimmed);
    }
    const inputs = Array.from(inputByNorm.entries()); // [normKey, originalDisplay][]

    const allCustomers = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        tags: customers.tags,
      })
      .from(customers);

    const byNorm = new Map<string, typeof allCustomers>();
    for (const c of allCustomers) {
      const key = norm(c.displayName);
      const arr = byNorm.get(key) ?? [];
      arr.push(c);
      byNorm.set(key, arr);
    }

    type Match = {
      rosterName: string;
      customerId: string;
      customerName: string;
      alreadyTagged: boolean;
    };
    const matches: Match[] = [];
    const ambiguous: Array<{ rosterName: string; candidates: string[] }> = [];
    const notFound: string[] = [];

    for (const [key, original] of inputs) {
      const hits = byNorm.get(key) ?? [];
      if (hits.length === 0) {
        notFound.push(original);
        continue;
      }
      if (hits.length > 1) {
        ambiguous.push({
          rosterName: original,
          candidates: hits.map((h) => h.displayName),
        });
        continue;
      }
      const c = hits[0]!;
      const alreadyTagged = (c.tags ?? [])
        .map((t) => t.toLowerCase())
        .includes(tag);
      matches.push({
        rosterName: original,
        customerId: c.id,
        customerName: c.displayName,
        alreadyTagged,
      });
    }

    const toApply = matches.filter((m) => !m.alreadyTagged);

    if (!apply) {
      return reply.send({
        applied: false,
        tag,
        counts: {
          input: inputs.length,
          matched: matches.length,
          alreadyTagged: matches.filter((m) => m.alreadyTagged).length,
          wouldApply: toApply.length,
          ambiguous: ambiguous.length,
          notFound: notFound.length,
        },
        matches,
        ambiguous,
        notFound,
      });
    }

    // Apply pass — append the tag to each matched customer's tags
    // JSON column (case-insensitive dedupe). Audit-log per change so
    // the bulk write is traceable.
    let applied = 0;
    for (const m of toApply) {
      const before = await db
        .select({ tags: customers.tags })
        .from(customers)
        .where(eq(customers.id, m.customerId))
        .limit(1);
      const currentTags = before[0]?.tags ?? [];
      const lowered = currentTags.map((t) => t.toLowerCase());
      if (lowered.includes(tag)) continue;
      const nextTags = [...currentTags, tag];
      await db
        .update(customers)
        .set({ tags: nextTags })
        .where(eq(customers.id, m.customerId));
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "customer.tag.add.roster",
        entityType: "customer",
        entityId: m.customerId,
        before: { tags: currentTags },
        after: { tags: nextTags },
      });
      applied++;
    }

    log.info(
      { tag, userId: user.id, applied, matchedCount: matches.length },
      "roster tag applied",
    );

    return reply.send({
      applied: true,
      tag,
      counts: {
        input: inputs.length,
        matched: matches.length,
        alreadyTagged: matches.filter((m) => m.alreadyTagged).length,
        applied,
        ambiguous: ambiguous.length,
        notFound: notFound.length,
      },
      matches,
      ambiguous,
      notFound,
    });
  });
};

export default rosterTagRoute;
