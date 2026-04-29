// Hold/release endpoints. Toggling hold status removes (or re-adds) the
// canonical "b2b" Shopify tag on the customer's matched Shopify record,
// which is how the Shopify storefront gates B2B-only customers from the
// program. Our customers.holdStatus column tracks the local mirror so
// the UI can render hold banners without a round-trip to Shopify.
//
// Match strategy: by primary_email, exact-match. May not always have a
// match — handle gracefully by returning a 404 on toggle (so the user
// gets feedback rather than a silent failure) and `{ matched: false }`
// on the read endpoint.
//
// Auth: both routes require an authenticated session (requireAuth).
// Audit + activity: hold toggles write a hold_on / hold_off activity
// (source: user_action) plus an audit_log row that records the before/
// after Shopify tag set. The customers.holdStatus update itself is also
// audit-logged.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import { ShopifyClient, ShopifyApiError } from "../../integrations/shopify/client.js";
import {
  addTag,
  findCustomerByEmail,
  parseTags,
  removeTag,
} from "../../integrations/shopify/hold.js";
import { recordActivity } from "../../modules/crm/index.js";

const log = createLogger({ component: "routes.holds" });

const B2B_TAG = "b2b";

const toggleBodySchema = z.object({
  targetState: z.enum(["hold", "active"]),
});

const holdsRoute: FastifyPluginAsync = async (app) => {
  // GET /api/customers/:id/shopify-tags — read the customer's current
  // Shopify tag set (so the customer detail page can render the chips
  // row). Returns `matched: false` when the customer has no primary
  // email or no matching Shopify customer; never throws on miss so the
  // detail UI can render gracefully without bouncing into an error
  // state for a non-Shopify customer (e.g. QB-only B2B clients).
  app.get("/:id/shopify-tags", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const rows = await db
      .select({
        id: customers.id,
        primaryEmail: customers.primaryEmail,
      })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const customer = rows[0];
    if (!customer) {
      return reply.code(404).send({ error: "customer not found" });
    }
    if (!customer.primaryEmail) {
      return reply.send({ matched: false, tags: [] });
    }

    let shopify;
    try {
      const client = new ShopifyClient();
      shopify = await findCustomerByEmail(client, customer.primaryEmail);
    } catch (err) {
      log.error(
        { err, customerId: id, email: customer.primaryEmail },
        "shopify customer lookup failed",
      );
      return reply.code(502).send({ error: "shopify lookup failed" });
    }

    if (!shopify) {
      return reply.send({ matched: false, tags: [] });
    }

    return reply.send({
      matched: true,
      shopifyCustomerId: String(shopify.id),
      tags: parseTags(shopify.tags),
    });
  });

  // POST /api/customers/:id/hold-toggle — flip a customer's hold state.
  // Body: { targetState: "hold" | "active" }. The server is authoritative
  // about which Shopify tag operation runs (remove for hold, add for
  // active) so the UI can't accidentally invert it.
  app.post("/:id/hold-toggle", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = toggleBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { targetState } = parse.data;

    const beforeRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "customer not found" });

    if (!before.primaryEmail) {
      return reply
        .code(404)
        .send({ error: "no shopify customer matched by email" });
    }

    let client: ShopifyClient;
    try {
      client = new ShopifyClient();
    } catch (err) {
      log.error({ err, customerId: id }, "shopify client init failed");
      return reply.code(502).send({ error: "shopify client unavailable" });
    }

    let shopify;
    try {
      shopify = await findCustomerByEmail(client, before.primaryEmail);
    } catch (err) {
      log.error(
        { err, customerId: id, email: before.primaryEmail },
        "shopify customer lookup failed",
      );
      return reply.code(502).send({ error: "shopify lookup failed" });
    }
    if (!shopify) {
      return reply
        .code(404)
        .send({ error: "no shopify customer matched by email" });
    }

    let tagsAfter: string[];
    const tagsBefore = parseTags(shopify.tags);
    try {
      const result =
        targetState === "hold"
          ? await removeTag(client, shopify.id, B2B_TAG)
          : await addTag(client, shopify.id, B2B_TAG);
      tagsAfter = result.tagsAfter;
    } catch (err) {
      // 403 → likely missing write_customers scope. Bubble up a
      // distinct status so the UI can suggest a re-OAuth.
      if (err instanceof ShopifyApiError && err.status === 403) {
        log.error(
          { err, customerId: id, shopifyCustomerId: shopify.id, targetState },
          "shopify tag mutation forbidden — write_customers scope missing?",
        );
        return reply.code(403).send({
          error:
            "shopify rejected the tag write — the Admin token likely needs the write_customers scope. Re-run the Shopify OAuth flow.",
        });
      }
      log.error(
        { err, customerId: id, shopifyCustomerId: shopify.id, targetState },
        "shopify tag mutation failed",
      );
      return reply.code(502).send({ error: "shopify tag write failed" });
    }

    // Local mirror — flip customers.holdStatus to the requested state.
    await db
      .update(customers)
      .set({ holdStatus: targetState })
      .where(eq(customers.id, id));

    // Audit-log the local row change AND the Shopify tag mutation
    // separately so the audit trail records both sides.
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "customer.hold_toggle",
      entityType: "customer",
      entityId: id,
      before: { holdStatus: before.holdStatus },
      after: { holdStatus: targetState },
    });
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action:
        targetState === "hold"
          ? "shopify.tag_remove"
          : "shopify.tag_add",
      entityType: "shopify_customer",
      entityId: String(shopify.id),
      before: { tags: tagsBefore },
      after: { tags: tagsAfter, tag: B2B_TAG },
    });

    // Activity row so the customer timeline shows the hold flip.
    await recordActivity({
      customerId: id,
      kind: targetState === "hold" ? "hold_on" : "hold_off",
      source: "user_action",
      userId: user.id,
      subject:
        targetState === "hold"
          ? `Put on hold — removed Shopify tag '${B2B_TAG}'`
          : `Hold released — re-added Shopify tag '${B2B_TAG}'`,
      refType: "shopify_customer",
      refId: String(shopify.id),
      meta: {
        shopifyCustomerId: String(shopify.id),
        tag: B2B_TAG,
        tagsBefore,
        tagsAfter,
      },
    });

    log.info(
      {
        userId: user.id,
        customerId: id,
        shopifyCustomerId: shopify.id,
        targetState,
        tagsAfter,
      },
      "hold toggled",
    );

    return reply.send({
      holdStatus: targetState,
      tagsAfter,
    });
  });
};

export default holdsRoute;
