// CRUD for the email_routing_rules table — the tag → email-action
// mapping that drives auto-CC/BCC on invoice + statement sends. Today
// the only seeded rule is `yiddy / bcc_invoice / sales@feldart.com`,
// but the table is plural-shaped so the operator can add per-team
// rules from the Settings page without code changes.
//
// Tags are lower-cased + trimmed before persisting; case-insensitive
// matching against customers.tags is the responsibility of the
// recipients resolver. The (tag, action, value) tuple is unique
// (enforced at the schema level), so re-applying the same rule is a
// silent no-op.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  ROUTING_RULE_ACTIONS,
  emailRoutingRules,
} from "../../db/schema/email-routing-rules.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";

const createBodySchema = z.object({
  tag: z.string().min(1).max(64),
  action: z.enum(ROUTING_RULE_ACTIONS),
  value: z.string().min(3).max(255),
});

const emailRoutingRulesRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(emailRoutingRules)
      .orderBy(emailRoutingRules.tag, emailRoutingRules.action);
    return reply.send({
      rules: rows.map((r) => ({
        id: r.id,
        tag: r.tag,
        action: r.action,
        value: r.value,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });

  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const tag = parse.data.tag.trim().toLowerCase();
    const value = parse.data.value.trim();
    const id = nanoid(24);
    try {
      await db.insert(emailRoutingRules).values({
        id,
        tag,
        action: parse.data.action,
        value,
        createdByUserId: user.id,
      });
    } catch (err) {
      const msg = (err as { message?: string }).message ?? "";
      if (/duplicate|ER_DUP_ENTRY/i.test(msg)) {
        return reply
          .code(409)
          .send({ error: "rule already exists", code: "duplicate" });
      }
      throw err;
    }
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "email_routing_rules.create",
      entityType: "email_routing_rule",
      entityId: id,
      before: null,
      after: { tag, action: parse.data.action, value },
    });
    return reply.send({
      rule: { id, tag, action: parse.data.action, value },
    });
  });

  app.delete("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const beforeRows = await db
      .select()
      .from(emailRoutingRules)
      .where(eq(emailRoutingRules.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "rule not found" });
    await db.delete(emailRoutingRules).where(eq(emailRoutingRules.id, id));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "email_routing_rules.delete",
      entityType: "email_routing_rule",
      entityId: id,
      before: {
        tag: before.tag,
        action: before.action,
        value: before.value,
      },
      after: null,
    });
    return reply.send({ ok: true });
  });
};

export default emailRoutingRulesRoute;
