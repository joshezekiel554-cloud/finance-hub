// Core hold/release flow, extracted from the holds route so the AI
// agent's set_hold_status tool and the HTTP route share ONE battle-tested
// path (Shopify atomic tag mutations + local mirror + audit + activity).
// Returns a discriminated result; callers map it to HTTP codes or tool
// errors.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { createLogger } from "../../lib/logger.js";
import {
  ShopifyClient,
  ShopifyApiError,
} from "../../integrations/shopify/client.js";
import {
  addTag,
  parseTags,
  removeTag,
} from "../../integrations/shopify/hold.js";
import { findShopifyCustomer } from "../shopify-link/lookup.js";
import { recordActivity } from "../crm/index.js";

const log = createLogger({ component: "holds.apply" });

export type HoldTargetState = "active" | "hold" | "payment_upfront";

export type TagOp = { kind: "add" | "remove"; tag: string };

const B2B_TAG = "b2b";
const UPFRONT_TAG = "b2b-b2b-upfront";

// Intent ops per target state (moved verbatim from the route — see its
// git history for the 36-combination equivalence check).
export function tagOpsForStatus(
  current: string[],
  target: HoldTargetState,
): TagOp[] {
  const has = (t: string) => current.includes(t);
  const ops: TagOp[] = [];
  if (target === "hold") {
    if (has(B2B_TAG)) ops.push({ kind: "remove", tag: B2B_TAG });
    if (has(UPFRONT_TAG)) ops.push({ kind: "remove", tag: UPFRONT_TAG });
  } else if (target === "active") {
    if (!has(B2B_TAG)) ops.push({ kind: "add", tag: B2B_TAG });
    if (has(UPFRONT_TAG)) ops.push({ kind: "remove", tag: UPFRONT_TAG });
  } else {
    if (!has(B2B_TAG)) ops.push({ kind: "add", tag: B2B_TAG });
    if (!has(UPFRONT_TAG)) ops.push({ kind: "add", tag: UPFRONT_TAG });
  }
  return ops;
}

export type ApplyHoldResult =
  | { kind: "ok"; holdStatus: HoldTargetState; tagsAfter: string[] }
  | {
      kind: "error";
      code:
        | "customer_not_found"
        | "no_shopify_match"
        | "shopify_unavailable"
        | "shopify_forbidden"
        | "shopify_failed";
      message: string;
    };

export async function applyHoldStatus(
  customerId: string,
  targetState: HoldTargetState,
  userId: string,
): Promise<ApplyHoldResult> {
  const beforeRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const before = beforeRows[0];
  if (!before) {
    return { kind: "error", code: "customer_not_found", message: "customer not found" };
  }
  if (!before.primaryEmail && !before.shopifyCustomerId) {
    return {
      kind: "error",
      code: "no_shopify_match",
      message: "no shopify customer matched by id or email",
    };
  }

  let client: ShopifyClient;
  try {
    client = new ShopifyClient();
  } catch (err) {
    log.error({ err, customerId }, "shopify client init failed");
    return {
      kind: "error",
      code: "shopify_unavailable",
      message: "shopify client unavailable",
    };
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
    if (resolution.kind === "none" || resolution.kind === "ambiguous") {
      return {
        kind: "error",
        code: "no_shopify_match",
        message: "no shopify customer matched by id or email",
      };
    }
    shopify = resolution.customer;
  } catch (err) {
    log.error({ err, customerId }, "shopify customer lookup failed");
    return {
      kind: "error",
      code: "shopify_failed",
      message: "shopify lookup failed",
    };
  }

  const tagsBefore = parseTags(shopify.tags);
  const ops = tagOpsForStatus(tagsBefore, targetState);
  let tagsAfter = tagsBefore;
  let currentOp: TagOp | null = null;
  try {
    for (const op of ops) {
      currentOp = op;
      const result =
        op.kind === "add"
          ? await addTag(client, shopify.id, op.tag)
          : await removeTag(client, shopify.id, op.tag);
      tagsAfter = result.tagsAfter;
    }
  } catch (err) {
    // Partial multi-op flips are recorded so they're never invisible;
    // ops are idempotent so a retry converges.
    try {
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId,
        action: "shopify.tag_set_failed",
        entityType: "shopify_customer",
        entityId: String(shopify.id),
        before: { tags: tagsBefore },
        after: {
          tags: tagsAfter,
          targetState,
          failedOp: currentOp,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } catch (auditErr) {
      log.error(
        { err: auditErr, customerId, shopifyCustomerId: shopify.id },
        "failed to audit-log partial tag flip",
      );
    }
    if (err instanceof ShopifyApiError && err.status === 403) {
      log.error(
        { err, customerId, shopifyCustomerId: shopify.id, targetState },
        "shopify tag mutation forbidden — write_customers scope missing?",
      );
      return {
        kind: "error",
        code: "shopify_forbidden",
        message:
          "shopify rejected the tag write — the Admin token likely needs the write_customers scope. Re-run the Shopify OAuth flow.",
      };
    }
    log.error(
      { err, customerId, shopifyCustomerId: shopify.id, targetState },
      "shopify tag mutation failed",
    );
    return {
      kind: "error",
      code: "shopify_failed",
      message: "shopify tag write failed",
    };
  }

  await db
    .update(customers)
    .set({ holdStatus: targetState })
    .where(eq(customers.id, customerId));

  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "customer.hold_toggle",
    entityType: "customer",
    entityId: customerId,
    before: { holdStatus: before.holdStatus },
    after: { holdStatus: targetState },
  });
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "shopify.tag_set",
    entityType: "shopify_customer",
    entityId: String(shopify.id),
    before: { tags: tagsBefore },
    after: { tags: tagsAfter, targetState },
  });

  const wasHold = before.holdStatus === "hold";
  const isHold = targetState === "hold";
  const activityKind = isHold ? "hold_on" : wasHold ? "hold_off" : "manual_note";
  const subject =
    targetState === "hold"
      ? `Put on hold — Shopify b2b tag removed`
      : targetState === "payment_upfront"
        ? `Status: ${before.holdStatus} → payment upfront — Shopify b2b-b2b-upfront tag added`
        : wasHold
          ? `Hold released — Shopify b2b tag re-added`
          : `Status: ${before.holdStatus} → active — Shopify b2b-b2b-upfront tag removed`;
  await recordActivity({
    customerId,
    kind: activityKind,
    source: "user_action",
    userId,
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
    { userId, customerId, shopifyCustomerId: shopify.id, targetState, tagsAfter },
    "hold toggled",
  );

  return { kind: "ok", holdStatus: targetState, tagsAfter };
}
