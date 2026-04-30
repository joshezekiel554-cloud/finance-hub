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
  parseTags,
  setCustomerTags,
} from "../../integrations/shopify/hold.js";
import { findShopifyCustomer } from "../../modules/shopify-link/lookup.js";
import { recordActivity } from "../../modules/crm/index.js";

const log = createLogger({ component: "routes.holds" });

const B2B_TAG = "b2b";
const UPFRONT_TAG = "b2b-b2b-upfront";

const toggleBodySchema = z.object({
  targetState: z.enum(["hold", "active", "payment_upfront"]),
});

// Compute the canonical Shopify tag set for a target account status,
// preserving any other tags the customer has. The output is the FULL
// list (caller writes it via setCustomerTags). Mirrors the inverse of
// statusFromTags() in the b2b-audit route — same rules, same order:
//
//   active           → has b2b, no upfront
//   payment_upfront  → has b2b AND upfront
//   hold             → no b2b, no upfront
function tagsForStatus(
  current: string[],
  target: "active" | "hold" | "payment_upfront",
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of current) {
    const lower = t.trim().toLowerCase();
    if (!lower || seen.has(lower)) continue;
    if (target === "hold" && (lower === B2B_TAG || lower === UPFRONT_TAG)) {
      continue;
    }
    if (target === "active" && lower === UPFRONT_TAG) {
      // active strips upfront but keeps b2b (added below if missing).
      continue;
    }
    seen.add(lower);
    out.push(t.trim());
  }
  if (target === "active" || target === "payment_upfront") {
    if (!seen.has(B2B_TAG)) out.push(B2B_TAG);
  }
  if (target === "payment_upfront" && !seen.has(UPFRONT_TAG)) {
    out.push(UPFRONT_TAG);
  }
  return out;
}

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

    if (!before.primaryEmail && !before.shopifyCustomerId) {
      return reply
        .code(404)
        .send({ error: "no shopify customer matched by id or email" });
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
      const resolution = await findShopifyCustomer(
        {
          customerId: before.id,
          shopifyCustomerId: before.shopifyCustomerId,
          primaryEmail: before.primaryEmail,
          billingEmails: Array.isArray(before.billingEmails)
            ? (before.billingEmails as string[])
            : [],
        },
        client,
      );
      if (
        resolution.kind === "none" ||
        resolution.kind === "ambiguous"
      ) {
        return reply
          .code(404)
          .send({ error: "no shopify customer matched by id or email" });
      }
      shopify = resolution.customer;
    } catch (err) {
      log.error(
        { err, customerId: id },
        "shopify customer lookup failed",
      );
      return reply.code(502).send({ error: "shopify lookup failed" });
    }

    const tagsBefore = parseTags(shopify.tags);
    const tagsAfter = tagsForStatus(tagsBefore, targetState);
    // No-op short-circuit: if the desired tag set is identical to what
    // Shopify already has, skip the PUT entirely. Saves a request and
    // avoids tripping rate limits on rapid double-clicks.
    const sameTags =
      tagsBefore.length === tagsAfter.length &&
      tagsBefore.every((t, i) => t === tagsAfter[i]);
    try {
      if (!sameTags) {
        await setCustomerTags(client, shopify.id, tagsAfter);
      }
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
      action: "shopify.tag_set",
      entityType: "shopify_customer",
      entityId: String(shopify.id),
      before: { tags: tagsBefore },
      after: { tags: tagsAfter, targetState },
    });

    // Activity row so the customer timeline shows the status flip.
    // hold_on/hold_off only fire when crossing the hold boundary; flips
    // between active and payment_upfront log a manual_note so the
    // timeline still records what happened without misclassifying the
    // hold-state change.
    const wasHold = before.holdStatus === "hold";
    const isHold = targetState === "hold";
    const activityKind = isHold
      ? "hold_on"
      : wasHold
        ? "hold_off"
        : "manual_note";
    const subject =
      targetState === "hold"
        ? `Put on hold — Shopify b2b tag removed`
        : targetState === "payment_upfront"
          ? `Status: ${before.holdStatus} → payment upfront — Shopify b2b-b2b-upfront tag added`
          : wasHold
            ? `Hold released — Shopify b2b tag re-added`
            : `Status: ${before.holdStatus} → active — Shopify b2b-b2b-upfront tag removed`;
    await recordActivity({
      customerId: id,
      kind: activityKind,
      source: "user_action",
      userId: user.id,
      subject,
      refType: "shopify_customer",
      refId: String(shopify.id),
      meta: {
        shopifyCustomerId: String(shopify.id),
        targetState,
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
