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
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import { ShopifyClient } from "../../integrations/shopify/client.js";
import { parseTags } from "../../integrations/shopify/hold.js";
import { findShopifyCustomer } from "../../modules/shopify-link/lookup.js";
import { applyHoldStatus } from "../../modules/holds/apply.js";

const log = createLogger({ component: "routes.holds" });

const toggleBodySchema = z.object({
  targetState: z.enum(["hold", "active", "payment_upfront"]),
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
        billingEmails: customers.billingEmails,
        shopifyCustomerId: customers.shopifyCustomerId,
      })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const customer = rows[0];
    if (!customer) {
      return reply.code(404).send({ error: "customer not found" });
    }
    if (!customer.primaryEmail && !customer.shopifyCustomerId) {
      return reply.send({ matched: false, tags: [] });
    }

    let shopify;
    try {
      const client = new ShopifyClient();
      const resolution = await findShopifyCustomer(
        {
          customerId: customer.id,
          shopifyCustomerId: customer.shopifyCustomerId,
          primaryEmail: customer.primaryEmail,
          billingEmails: Array.isArray(customer.billingEmails)
            ? (customer.billingEmails as string[])
            : [],
        },
        client,
      );
      if (
        resolution.kind === "none" ||
        resolution.kind === "ambiguous"
      ) {
        return reply.send({ matched: false, tags: [] });
      }
      shopify = resolution.customer;
    } catch (err) {
      log.error(
        { err, customerId: id },
        "shopify customer lookup failed",
      );
      return reply.code(502).send({ error: "shopify lookup failed" });
    }

    return reply.send({
      matched: true,
      shopifyCustomerId: String(shopify.id),
      tags: parseTags(shopify.tags),
    });
  });

  // POST /api/customers/:id/hold-toggle — flip a customer's hold state.
  // Body: { targetState: "hold" | "active" | "payment_upfront" }. The
  // whole flow (Shopify atomic tag ops + local mirror + audit + activity)
  // lives in modules/holds/apply.ts, shared with the AI agent's
  // set_hold_status tool; this handler just maps the result to HTTP.
  app.post("/:id/hold-toggle", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = toggleBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }

    const result = await applyHoldStatus(id, parse.data.targetState, user.id);
    if (result.kind === "ok") {
      return reply.send({
        holdStatus: result.holdStatus,
        tagsAfter: result.tagsAfter,
      });
    }
    const status =
      result.code === "customer_not_found" || result.code === "no_shopify_match"
        ? 404
        : result.code === "shopify_forbidden"
          ? 403
          : 502;
    return reply.code(status).send({ error: result.message });
  });
};

export default holdsRoute;
