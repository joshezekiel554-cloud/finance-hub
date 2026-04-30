// One-off + on-demand Shopify ID linker. Three endpoints:
//
//   POST /api/shopify-link/preview       — auto-match every B2B customer
//                                          to a Shopify id via the
//                                          ID-first lookup helper.
//                                          Persists newly-discovered
//                                          ids as a side effect of the
//                                          scan (so an empty manual
//                                          confirm step is enough).
//   POST /api/shopify-link/apply         — operator-confirmed manual
//                                          links: { customerId,
//                                          shopifyCustomerId } pairs.
//   GET  /api/shopify-link/search        — fuzzy search Shopify by
//                                          company name (or arbitrary
//                                          query). Powers the manual-
//                                          link picker.
//
// Scope: customer_type='b2b'. The audit and the hold/release flows
// both use customers.shopifyCustomerId once it's populated.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import {
  ShopifyClient,
  ShopifyApiError,
} from "../../integrations/shopify/client.js";
import {
  findShopifyCustomer,
  searchShopifyByCompany,
  type LinkResolution,
} from "../../modules/shopify-link/lookup.js";

const log = createLogger({ component: "routes.shopify-link" });

// 2 calls/sec leaky bucket — same constraint as the audit. Per-customer
// lookups can do up to (1 cached id + 4 emails) = 5 GETs each, so we
// stay conservative at concurrency 2.
const SCAN_CONCURRENCY = 2;

type PreviewRow = {
  customerId: string;
  displayName: string;
  primaryEmail: string | null;
  billingEmails: string[];
  classification:
    | "already_linked"
    | "auto_matched"
    | "ambiguous"
    | "no_match";
  resolvedShopifyId: string | null;
  matchedEmail?: string;
  candidatesByEmail?: Record<string, string>;
};

const applyBodySchema = z.object({
  applies: z
    .array(
      z.object({
        customerId: z.string().min(1).max(64),
        shopifyCustomerId: z.string().min(1).max(64),
      }),
    )
    .min(1)
    .max(500),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const shopifyLinkRoute: FastifyPluginAsync = async (app) => {
  app.post("/preview", async (req, reply) => {
    await requireAuth(req);

    const targets = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        primaryEmail: customers.primaryEmail,
        billingEmails: customers.billingEmails,
        shopifyCustomerId: customers.shopifyCustomerId,
      })
      .from(customers)
      .where(eq(customers.customerType, "b2b"));

    let client: ShopifyClient;
    try {
      client = new ShopifyClient();
    } catch (err) {
      log.error({ err }, "shopify client init failed");
      return reply.code(502).send({ error: "shopify client unavailable" });
    }

    const rows: PreviewRow[] = [];
    const queue = [...targets];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < SCAN_CONCURRENCY; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const t = queue.shift();
            if (!t) return;
            const billingEmails = Array.isArray(t.billingEmails)
              ? (t.billingEmails as string[])
              : [];
            try {
              // The lookup persists newly-discovered ids by default,
              // so a successful preview run already brings the back-
              // catalog into agreement. The classification reflects
              // pre-lookup state for operator clarity.
              const resolution: LinkResolution = await findShopifyCustomer(
                {
                  customerId: t.id,
                  shopifyCustomerId: t.shopifyCustomerId,
                  primaryEmail: t.primaryEmail,
                  billingEmails,
                },
                client,
              );
              switch (resolution.kind) {
                case "by_id":
                  rows.push({
                    customerId: t.id,
                    displayName: t.displayName,
                    primaryEmail: t.primaryEmail,
                    billingEmails,
                    classification: "already_linked",
                    resolvedShopifyId: resolution.shopifyCustomerId,
                  });
                  break;
                case "by_email":
                  rows.push({
                    customerId: t.id,
                    displayName: t.displayName,
                    primaryEmail: t.primaryEmail,
                    billingEmails,
                    // already_linked when the cached id was stale (404)
                    // and we re-discovered the same id via email; that's
                    // covered by newlyDiscovered === false.
                    classification: resolution.newlyDiscovered
                      ? "auto_matched"
                      : "already_linked",
                    resolvedShopifyId: resolution.shopifyCustomerId,
                    matchedEmail: resolution.matchedEmail,
                  });
                  break;
                case "ambiguous":
                  rows.push({
                    customerId: t.id,
                    displayName: t.displayName,
                    primaryEmail: t.primaryEmail,
                    billingEmails,
                    classification: "ambiguous",
                    resolvedShopifyId: null,
                    candidatesByEmail: resolution.candidatesByEmail,
                  });
                  break;
                case "none":
                  rows.push({
                    customerId: t.id,
                    displayName: t.displayName,
                    primaryEmail: t.primaryEmail,
                    billingEmails,
                    classification: "no_match",
                    resolvedShopifyId: null,
                  });
                  break;
              }
            } catch (err) {
              const msg =
                err instanceof ShopifyApiError
                  ? `${err.status}: ${err.message}`
                  : (err as Error).message ?? "unknown";
              log.warn(
                { err, customerId: t.id },
                "shopify-link preview row failed",
              );
              rows.push({
                customerId: t.id,
                displayName: t.displayName,
                primaryEmail: t.primaryEmail,
                billingEmails,
                classification: "no_match",
                resolvedShopifyId: null,
                matchedEmail: undefined,
                candidatesByEmail: { error: msg },
              });
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    // Sort: action-required first (ambiguous + no_match), then auto-
    // matched (just persisted, useful to scan for surprises), then
    // already-linked at the bottom.
    const order = (r: PreviewRow): number => {
      switch (r.classification) {
        case "ambiguous":
          return 0;
        case "no_match":
          return 1;
        case "auto_matched":
          return 2;
        case "already_linked":
          return 3;
      }
    };
    rows.sort((a, b) => {
      const d = order(a) - order(b);
      if (d !== 0) return d;
      return a.displayName.localeCompare(b.displayName);
    });

    const stats = {
      total: rows.length,
      autoMatched: rows.filter((r) => r.classification === "auto_matched")
        .length,
      alreadyLinked: rows.filter(
        (r) => r.classification === "already_linked",
      ).length,
      ambiguous: rows.filter((r) => r.classification === "ambiguous").length,
      noMatch: rows.filter((r) => r.classification === "no_match").length,
    };

    return reply.send({ rows, stats });
  });

  app.post("/apply", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = applyBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { applies } = parse.data;

    let updated = 0;
    let skipped = 0;
    const failures: Array<{ customerId: string; reason: string }> = [];

    for (const a of applies) {
      try {
        const before = await db
          .select({
            id: customers.id,
            shopifyCustomerId: customers.shopifyCustomerId,
          })
          .from(customers)
          .where(eq(customers.id, a.customerId))
          .limit(1);
        if (before.length === 0) {
          failures.push({ customerId: a.customerId, reason: "not_found" });
          continue;
        }
        if (before[0]!.shopifyCustomerId === a.shopifyCustomerId) {
          skipped++;
          continue;
        }
        await db
          .update(customers)
          .set({ shopifyCustomerId: a.shopifyCustomerId })
          .where(eq(customers.id, a.customerId));
        await db.insert(auditLog).values({
          id: nanoid(24),
          userId: user.id,
          action: "customer.update",
          entityType: "customer",
          entityId: a.customerId,
          before: {
            shopifyCustomerId: before[0]!.shopifyCustomerId ?? null,
          },
          after: {
            shopifyCustomerId: a.shopifyCustomerId,
            reason: "shopify_link_manual",
          },
        });
        updated++;
      } catch (err) {
        log.error(
          { err, customerId: a.customerId, shopifyCustomerId: a.shopifyCustomerId },
          "shopify-link apply row failed",
        );
        failures.push({
          customerId: a.customerId,
          reason: (err as Error).message ?? "unknown",
        });
      }
    }
    return reply.send({ updated, skipped, failures });
  });

  app.get("/search", async (req, reply) => {
    await requireAuth(req);
    const parse = searchQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { q, limit } = parse.data;

    let client: ShopifyClient;
    try {
      client = new ShopifyClient();
    } catch (err) {
      log.error({ err }, "shopify client init failed");
      return reply.code(502).send({ error: "shopify client unavailable" });
    }

    try {
      const results = await searchShopifyByCompany(client, q, limit);
      return reply.send({
        results: results.map((c) => ({
          id: String(c.id),
          email: c.email,
          firstName: c.first_name ?? null,
          lastName: c.last_name ?? null,
          company: c.default_address?.company ?? null,
          city: c.default_address?.city ?? null,
        })),
      });
    } catch (err) {
      log.error({ err, q }, "shopify search failed");
      return reply.code(502).send({ error: "shopify search failed" });
    }
  });
};

// Suppress unused import warnings when only some helpers reference and.
void and;

export default shopifyLinkRoute;
