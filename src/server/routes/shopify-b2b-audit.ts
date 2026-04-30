// Audit B2B customers against the Shopify tag set. Tags map to a
// single account state (customers.holdStatus):
//
//   has `b2b`,         no `b2b-b2b-upfront` → "active"
//   has `b2b`,         has `b2b-b2b-upfront` → "payment_upfront"
//   missing `b2b`                          → "hold"
//
// payment_upfront is a third state (alongside active + hold): the
// storefront still serves the customer (Shopify b2b tag intact), but
// the operator should require prepayment on every order. It renders
// as its own pill in the customers list — not active, not hold.
//
// Two endpoints:
//   POST /api/shopify-b2b-audit/preview — read-only scan + preview
//   POST /api/shopify-b2b-audit/apply   — apply selected status changes
//
// Scope: every customer with customer_type='b2b'.
//
// We don't write to Shopify on apply: the tags are the input, finance-
// hub is the side that drifted. Local mirror + audit_log + activity
// is sufficient.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
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
  findCustomerByEmail,
  parseTags,
} from "../../integrations/shopify/hold.js";
import { recordActivity } from "../../modules/crm/index.js";

const log = createLogger({ component: "routes.shopify-b2b-audit" });

const B2B_TAG = "b2b";
const UPFRONT_TAG = "b2b-b2b-upfront";
// Shopify standard plan rate-limits at 4 req/sec; bound the fanout
// safely below that. A 243-customer scan at concurrency=4 takes ~60s
// worst case, fine for an operator-triggered sweep.
const SCAN_CONCURRENCY = 4;

const STATUS_VALUES = ["active", "hold", "payment_upfront"] as const;
type Status = (typeof STATUS_VALUES)[number];

type Classification =
  // Tag → status agree with what we have locally.
  | "in_sync"
  // Tag → status disagree; the Shopify side is the truth and we'd write.
  | "drift"
  // Couldn't audit:
  | "no_shopify_match"
  | "no_email"
  | "error";

type PreviewRow = {
  customerId: string;
  displayName: string;
  primaryEmail: string | null;
  classification: Classification;
  shopifyCustomerId: string | null;
  shopifyTags: string[];
  currentStatus: Status;
  desiredStatus: Status | null;
  recommended: boolean;
  errorMessage?: string;
};

const applyBodySchema = z.object({
  applies: z
    .array(
      z.object({
        customerId: z.string().min(1).max(64),
        status: z.enum(STATUS_VALUES),
      }),
    )
    .min(1)
    .max(1000),
});

function statusFromTags(tags: string[]): Status {
  const lower = tags.map((t) => t.toLowerCase());
  if (!lower.includes(B2B_TAG)) return "hold";
  if (lower.includes(UPFRONT_TAG)) return "payment_upfront";
  return "active";
}

const shopifyB2bAuditRoute: FastifyPluginAsync = async (app) => {
  app.post("/preview", async (req, reply) => {
    await requireAuth(req);

    const targets = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        primaryEmail: customers.primaryEmail,
        holdStatus: customers.holdStatus,
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
            const base = {
              customerId: t.id,
              displayName: t.displayName,
              primaryEmail: t.primaryEmail,
              currentStatus: t.holdStatus as Status,
            };
            if (!t.primaryEmail) {
              rows.push({
                ...base,
                classification: "no_email",
                shopifyCustomerId: null,
                shopifyTags: [],
                desiredStatus: null,
                recommended: false,
              });
              continue;
            }
            try {
              const shopify = await findCustomerByEmail(
                client,
                t.primaryEmail,
              );
              if (!shopify) {
                rows.push({
                  ...base,
                  classification: "no_shopify_match",
                  shopifyCustomerId: null,
                  shopifyTags: [],
                  desiredStatus: null,
                  recommended: false,
                });
                continue;
              }
              const tags = parseTags(shopify.tags);
              const desiredStatus = statusFromTags(tags);
              const drift = desiredStatus !== base.currentStatus;
              rows.push({
                ...base,
                classification: drift ? "drift" : "in_sync",
                shopifyCustomerId: String(shopify.id),
                shopifyTags: tags,
                desiredStatus,
                recommended: drift,
              });
            } catch (err) {
              const msg =
                err instanceof ShopifyApiError
                  ? `${err.status}: ${err.message}`
                  : (err as Error).message ?? "unknown";
              log.warn(
                { err, customerId: t.id, email: t.primaryEmail },
                "shopify scan row failed",
              );
              rows.push({
                ...base,
                classification: "error",
                shopifyCustomerId: null,
                shopifyTags: [],
                desiredStatus: null,
                recommended: false,
                errorMessage: msg,
              });
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    // Sort: drift rows first (the action items), then errors/missing,
    // then in_sync at the bottom. Within a bucket: alpha by name.
    const order = (r: PreviewRow): number => {
      switch (r.classification) {
        case "drift":
          return 0;
        case "error":
          return 1;
        case "no_shopify_match":
          return 2;
        case "no_email":
          return 3;
        case "in_sync":
          return 4;
      }
    };
    rows.sort((a, b) => {
      const d = order(a) - order(b);
      if (d !== 0) return d;
      return a.displayName.localeCompare(b.displayName);
    });

    const driftRows = rows.filter((r) => r.classification === "drift");
    const stats = {
      total: rows.length,
      drift: driftRows.length,
      driftToHold: driftRows.filter((r) => r.desiredStatus === "hold")
        .length,
      driftToUpfront: driftRows.filter(
        (r) => r.desiredStatus === "payment_upfront",
      ).length,
      driftToActive: driftRows.filter((r) => r.desiredStatus === "active")
        .length,
      inSync: rows.filter((r) => r.classification === "in_sync").length,
      noShopifyMatch: rows.filter(
        (r) => r.classification === "no_shopify_match",
      ).length,
      noEmail: rows.filter((r) => r.classification === "no_email").length,
      error: rows.filter((r) => r.classification === "error").length,
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
            holdStatus: customers.holdStatus,
            displayName: customers.displayName,
          })
          .from(customers)
          .where(eq(customers.id, a.customerId))
          .limit(1);
        if (before.length === 0) {
          failures.push({
            customerId: a.customerId,
            reason: "not_found",
          });
          continue;
        }
        const cur = before[0]!;
        if (cur.holdStatus === a.status) {
          skipped++;
          continue;
        }

        await db
          .update(customers)
          .set({ holdStatus: a.status })
          .where(eq(customers.id, a.customerId));

        await db.insert(auditLog).values({
          id: nanoid(24),
          userId: user.id,
          action: "customer.hold_toggle",
          entityType: "customer",
          entityId: a.customerId,
          before: { holdStatus: cur.holdStatus },
          after: {
            holdStatus: a.status,
            reason: "shopify_b2b_tag_audit",
          },
        });
        await recordActivity({
          customerId: a.customerId,
          // Activity kind picks based on direction: any move INTO hold
          // = hold_on; any move OUT of hold (including → payment_upfront)
          // = hold_off; everything else (active ↔ payment_upfront) gets
          // a generic note kind so the timeline still records it.
          kind:
            a.status === "hold"
              ? "hold_on"
              : cur.holdStatus === "hold"
                ? "hold_off"
                : "manual_note",
          source: "user_action",
          userId: user.id,
          subject: `Status: ${cur.holdStatus} → ${a.status} (Shopify b2b tag audit)`,
        });
        updated++;
      } catch (err) {
        log.error(
          { err, customerId: a.customerId, status: a.status },
          "shopify-b2b-audit apply row failed",
        );
        failures.push({
          customerId: a.customerId,
          reason: (err as Error).message ?? "unknown",
        });
      }
    }

    log.info(
      { updated, skipped, failures: failures.length, by: user.id },
      "shopify b2b audit apply complete",
    );

    return reply.send({ updated, skipped, failures });
  });
};

export default shopifyB2bAuditRoute;
