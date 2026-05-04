import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  createRma,
  getRmaById,
  listRmas,
  updateRma,
  approveRma,
  denyRma,
  issueCreditMemo,
  markReplacementSent,
  addRmaItem,
  updateRmaItem,
  removeRmaItem,
} from "../../modules/returns/index.js";
import {
  lookupItemPriceForCustomer,
  findOriginalInvoiceForItem,
} from "../../modules/returns/qbo-lookup.js";
import {
  RMA_RETURN_TYPES,
  RMA_STATUSES,
  RMA_ITEM_CLASSIFICATIONS,
  rmaItems,
} from "../../db/schema/returns.js";
import { customers } from "../../db/schema/customers.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import { db } from "../../db/index.js";
import { renderTemplate } from "../../modules/email-compose/index.js";
import { resolveRecipients } from "../../modules/customer-emails/recipients.js";
import { requireAuth } from "../lib/auth.js";

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const idParamsSchema = z.object({
  id: z.string().min(1),
});

const itemParamsSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Existing route schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z.enum(RMA_STATUSES).optional(),
  type: z.enum(RMA_RETURN_TYPES).optional(),
  customerId: z.string().max(24).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const createBodySchema = z.object({
  customerId: z.string().min(1).max(24),
  qbCustomerId: z.string().min(1).max(64),
  returnType: z.enum(RMA_RETURN_TYPES),
  seasonId: z.string().max(24).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  originalEmail: z.string().max(50000).optional().nullable(),
});

const patchBodySchema = z.object({
  notes: z.string().max(5000).nullable().optional(),
  totalValue: z.string().optional(),
});

// ---------------------------------------------------------------------------
// State transition schemas
// ---------------------------------------------------------------------------

const approveBodySchema = z.object({
  overrideThreshold: z.boolean().optional(),
  overrideReason: z.string().max(2000).optional(),
});

const denyBodySchema = z.object({
  reason: z.string().min(1).max(2000),
});

const issueCreditMemoBodySchema = z.object({
  shippingDeduction: z.string().optional(),
  restockingFee: z.string().optional(),
  itemOverrides: z
    .array(
      z.object({
        itemId: z.string().min(1),
        receivedQuantity: z.string().min(1),
      }),
    )
    .optional(),
});

const markReplacementSentBodySchema = z.object({}).passthrough();

// ---------------------------------------------------------------------------
// Items CRUD schemas
// ---------------------------------------------------------------------------

const addItemBodySchema = z.object({
  qbItemId: z.string().min(1).max(64),
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  quantity: z.string().min(1),
  unitPrice: z.string().min(1),
  classification: z.enum(RMA_ITEM_CLASSIFICATIONS),
  listUnitPrice: z.string().optional().nullable(),
  invoiceDiscountPct: z.string().optional().nullable(),
  lineTotal: z.string().optional(),
  reason: z.string().max(2000).optional().nullable(),
  originalInvoiceDocNumber: z.string().max(64).optional().nullable(),
  originalInvoiceDate: z.string().optional().nullable(),
});

const updateItemBodySchema = z.object({
  quantity: z.string().optional(),
  unitPrice: z.string().optional(),
  listUnitPrice: z.string().optional().nullable(),
  invoiceDiscountPct: z.string().optional().nullable(),
  reason: z.string().max(2000).optional().nullable(),
  originalInvoiceDocNumber: z.string().max(64).optional().nullable(),
  originalInvoiceDate: z.string().optional().nullable(),
  classification: z.enum(RMA_ITEM_CLASSIFICATIONS).optional(),
});

// ---------------------------------------------------------------------------
// QBO lookup schemas
// ---------------------------------------------------------------------------

const lookupPricesBodySchema = z.object({
  qbItemId: z.string().min(1).max(64),
});

const findOriginalInvoiceBodySchema = z.object({
  qbItemId: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// Helper: map { ok: true, rma } | { ok: false, reason } | null to HTTP
// ---------------------------------------------------------------------------

type OkResult<T> = { ok: true; rma: T } | { ok: false; reason: string };

function mapServiceResult<T>(
  result: OkResult<T> | null,
  reply: { code: (c: number) => void },
): T | { error: string } {
  if (result === null) {
    reply.code(404);
    return { error: "RMA not found" };
  }
  if (!result.ok) {
    reply.code(409);
    return { error: result.reason };
  }
  return result.rma;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const returnsRoute: FastifyPluginAsync = async (app) => {
  // ---- GET / ---------------------------------------------------------------
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid query", details: parse.error.flatten() };
    }
    const rows = await listRmas(parse.data);
    return { rmas: rows };
  });

  // ---- GET /:id ------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await requireAuth(req);
    const rma = await getRmaById(req.params.id);
    if (!rma) {
      reply.code(404);
      return { error: "RMA not found" };
    }
    return rma;
  });

  // ---- POST / --------------------------------------------------------------
  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const rma = await createRma({
      ...parse.data,
      createdByUserId: user.id,
    });
    reply.code(201);
    return rma;
  });

  // ---- PATCH /:id ----------------------------------------------------------
  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await requireAuth(req);
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    try {
      const updated = await updateRma(req.params.id, parse.data);
      if (!updated) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      return updated;
    } catch (err) {
      reply.code(409);
      return { error: err instanceof Error ? err.message : "Update failed" };
    }
  });

  // ==========================================================================
  // State transition routes
  // ==========================================================================

  // ---- POST /:id/approve ---------------------------------------------------
  app.post<{ Params: { id: string } }>("/:id/approve", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = approveBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const result = await approveRma(req.params.id, {
      userId: user.id,
      overrideThreshold: parse.data.overrideThreshold,
      overrideReason: parse.data.overrideReason,
    });
    return mapServiceResult(result, reply);
  });

  // ---- POST /:id/deny ------------------------------------------------------
  app.post<{ Params: { id: string } }>("/:id/deny", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = denyBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const result = await denyRma(req.params.id, {
      userId: user.id,
      reason: parse.data.reason,
    });
    return mapServiceResult(result, reply);
  });

  // ---- POST /:id/issue-credit-memo -----------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/issue-credit-memo",
    async (req, reply) => {
      const user = await requireAuth(req);
      const parse = issueCreditMemoBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await issueCreditMemo(req.params.id, {
        userId: user.id,
        shippingDeduction: parse.data.shippingDeduction,
        restockingFee: parse.data.restockingFee,
        itemOverrides: parse.data.itemOverrides,
      });
      return mapServiceResult(result, reply);
    },
  );

  // ---- POST /:id/mark-replacement-sent -------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/mark-replacement-sent",
    async (req, reply) => {
      const user = await requireAuth(req);
      const parse = markReplacementSentBodySchema.safeParse(req.body ?? {});
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await markReplacementSent(req.params.id, {
        userId: user.id,
      });
      return mapServiceResult(result, reply);
    },
  );

  // ==========================================================================
  // Items CRUD routes
  // ==========================================================================

  // ---- POST /:id/items -----------------------------------------------------
  app.post<{ Params: { id: string } }>("/:id/items", async (req, reply) => {
    const user = await requireAuth(req);
    void user; // auth check only; userId not passed to addRmaItem
    const parse = addItemBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    try {
      const updated = await addRmaItem(req.params.id, {
        qbItemId: parse.data.qbItemId,
        sku: parse.data.sku,
        name: parse.data.name,
        quantity: parse.data.quantity,
        unitPrice: parse.data.unitPrice,
        classification: parse.data.classification,
        listUnitPrice: parse.data.listUnitPrice,
        invoiceDiscountPct: parse.data.invoiceDiscountPct,
        reason: parse.data.reason,
        originalInvoiceDocNumber: parse.data.originalInvoiceDocNumber,
        originalInvoiceDate: parse.data.originalInvoiceDate,
      });
      reply.code(201);
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add item";
      if (msg.toLowerCase().includes("not found")) {
        reply.code(404);
        return { error: msg };
      }
      reply.code(409);
      return { error: msg };
    }
  });

  // ---- PATCH /:id/items/:itemId --------------------------------------------
  app.patch<{ Params: { id: string; itemId: string } }>(
    "/:id/items/:itemId",
    async (req, reply) => {
      await requireAuth(req);
      const paramsParse = itemParamsSchema.safeParse(req.params);
      if (!paramsParse.success) {
        reply.code(400);
        return { error: "Invalid params", details: paramsParse.error.flatten() };
      }
      const parse = updateItemBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      try {
        const updated = await updateRmaItem(req.params.itemId, parse.data);
        if (!updated) {
          reply.code(404);
          return { error: "RMA item not found" };
        }
        return updated;
      } catch (err) {
        reply.code(409);
        return {
          error: err instanceof Error ? err.message : "Failed to update item",
        };
      }
    },
  );

  // ---- DELETE /:id/items/:itemId -------------------------------------------
  app.delete<{ Params: { id: string; itemId: string } }>(
    "/:id/items/:itemId",
    async (req, reply) => {
      await requireAuth(req);
      try {
        const updated = await removeRmaItem(req.params.itemId);
        if (!updated) {
          reply.code(404);
          return { error: "RMA item not found" };
        }
        return updated;
      } catch (err) {
        reply.code(409);
        return {
          error: err instanceof Error ? err.message : "Failed to remove item",
        };
      }
    },
  );

  // ==========================================================================
  // QBO lookup routes
  // ==========================================================================

  // ---- POST /:id/lookup-prices ---------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/lookup-prices",
    async (req, reply) => {
      await requireAuth(req);
      const parse = lookupPricesBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      // Fetch parent RMA to get qbCustomerId
      const rma = await getRmaById(req.params.id);
      if (!rma) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!rma.qbCustomerId) {
        reply.code(409);
        return { error: "RMA has no QBO customer ID" };
      }
      const result = await lookupItemPriceForCustomer({
        qboCustomerId: rma.qbCustomerId,
        qbItemId: parse.data.qbItemId,
      });
      if (!result) {
        reply.code(404);
        return { error: "No matching invoice found for this item and customer" };
      }
      return result;
    },
  );

  // ---- POST /:id/find-original-invoice -------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/find-original-invoice",
    async (req, reply) => {
      await requireAuth(req);
      const parse = findOriginalInvoiceBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      // Fetch parent RMA to get qbCustomerId
      const rma = await getRmaById(req.params.id);
      if (!rma) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!rma.qbCustomerId) {
        reply.code(409);
        return { error: "RMA has no QBO customer ID" };
      }
      const result = await findOriginalInvoiceForItem({
        qboCustomerId: rma.qbCustomerId,
        qbItemId: parse.data.qbItemId,
      });
      if (!result) {
        reply.code(404);
        return { error: "No matching invoice found for this item and customer" };
      }
      return result;
    },
  );
  // ==========================================================================
  // Email preview routes
  // ==========================================================================

  // ---- POST /:id/preview-approval-email ------------------------------------
  // Returns { subject, body, recipients } pre-rendered from the rma-approval
  // template with all template_vars resolved. Used by the approval email
  // dialog so the operator can review + edit before send.
  app.post<{ Params: { id: string } }>(
    "/:id/preview-approval-email",
    async (req, reply) => {
      await requireAuth(req);
      const rma = await getRmaById(req.params.id);
      if (!rma) {
        reply.code(404);
        return { error: "RMA not found" };
      }

      // Fetch items for the items_list variable
      const items = await db
        .select()
        .from(rmaItems)
        .where(eq(rmaItems.rmaId, rma.id));

      // Fetch customer
      const customerRows = await db
        .select()
        .from(customers)
        .where(eq(customers.id, rma.customerId))
        .limit(1);
      const customer = customerRows[0];
      if (!customer) {
        reply.code(404);
        return { error: "Customer not found" };
      }

      // Fetch template
      const templateRows = await db
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.slug, "rma-approval"))
        .limit(1);
      const template = templateRows[0];
      if (!template) {
        reply.code(404);
        return { error: "rma-approval template not found — run the seed script" };
      }

      // Build items_list
      const itemsList = items
        .map((item) => {
          const qty = parseFloat(item.quantity).toFixed(0);
          const price = parseFloat(item.unitPrice).toFixed(2);
          const invRef = item.originalInvoiceDocNumber
            ? ` (inv. ${item.originalInvoiceDocNumber})`
            : "";
          return `  - ${item.sku} ${item.name} x${qty} @ $${price}${invRef}`;
        })
        .join("\n");

      // Build resolution body snippet
      const resolutionBody =
        rma.resolutionType === "replacement"
          ? "We will ship a replacement order to you shortly. No return is required."
          : "A credit memo will be issued to your account. You will receive a separate confirmation once it has been processed.";

      const approvalOpening =
        rma.thresholdOverridden
          ? "We have reviewed your return request and are pleased to approve it (approved with override)."
          : "We have reviewed your return request and are pleased to approve it.";

      const vars: Record<string, string> = {
        customer_name: customer.displayName,
        rma_number: rma.rmaNumber ?? rma.id,
        items_list: itemsList || "  (no items recorded)",
        resolution_body: resolutionBody,
        approval_opening: approvalOpening,
        company_name: "Feldart",
        user_name: "",
      };

      const subject = renderTemplate(template.subject, vars);
      const body = renderTemplate(template.body, vars);

      // Resolve recipients (use statement channel as the closest match)
      const resolved = await resolveRecipients("statement", {
        primaryEmail: customer.primaryEmail,
        billingEmails: customer.billingEmails,
        invoiceToEmails: customer.invoiceToEmails,
        invoiceCcEmails: customer.invoiceCcEmails,
        invoiceBccEmails: customer.invoiceBccEmails,
        statementToEmails: customer.statementToEmails,
        statementCcEmails: customer.statementCcEmails,
        statementBccEmails: customer.statementBccEmails,
        tags: customer.tags,
      });

      return {
        subject,
        body,
        recipients: {
          to: resolved.to.join(", "),
          cc: resolved.cc.join(", "),
          bcc: resolved.bcc.join(", "),
        },
        bccReasons: resolved.bccReasons ?? [],
      };
    },
  );

  // ---- POST /:id/preview-denial-email -------------------------------------
  // Returns { subject, body, recipients } for the denial email dialog.
  // Accepts optional { reason } in body so the dialog can re-fetch when the
  // operator types a custom denial reason.
  app.post<{ Params: { id: string } }>(
    "/:id/preview-denial-email",
    async (req, reply) => {
      await requireAuth(req);
      const bodyParse = z
        .object({ reason: z.string().max(2000).optional() })
        .safeParse(req.body);
      const denialReasonOverride = bodyParse.success
        ? (bodyParse.data.reason ?? null)
        : null;

      const rma = await getRmaById(req.params.id);
      if (!rma) {
        reply.code(404);
        return { error: "RMA not found" };
      }

      const customerRows = await db
        .select()
        .from(customers)
        .where(eq(customers.id, rma.customerId))
        .limit(1);
      const customer = customerRows[0];
      if (!customer) {
        reply.code(404);
        return { error: "Customer not found" };
      }

      const templateRows = await db
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.slug, "rma-denial"))
        .limit(1);
      const template = templateRows[0];
      if (!template) {
        reply.code(404);
        return { error: "rma-denial template not found — run the seed script" };
      }

      const denialReason =
        denialReasonOverride ??
        rma.denialReason ??
        "The item does not qualify for return under our current policy.";

      const vars: Record<string, string> = {
        customer_name: customer.displayName,
        rma_number: rma.rmaNumber ?? rma.id,
        denial_reason: denialReason,
        // Seasonal eligibility fields — empty for damage in Phase 1
        eligibility_section: "",
        eligible_amount: "",
        return_percentage: "",
        threshold: "",
        items_proposed: "",
        items_purchased: "",
        company_name: "Feldart",
        user_name: "",
      };

      const subject = renderTemplate(template.subject, vars);
      const body = renderTemplate(template.body, vars);

      const resolved = await resolveRecipients("statement", {
        primaryEmail: customer.primaryEmail,
        billingEmails: customer.billingEmails,
        invoiceToEmails: customer.invoiceToEmails,
        invoiceCcEmails: customer.invoiceCcEmails,
        invoiceBccEmails: customer.invoiceBccEmails,
        statementToEmails: customer.statementToEmails,
        statementCcEmails: customer.statementCcEmails,
        statementBccEmails: customer.statementBccEmails,
        tags: customer.tags,
      });

      return {
        subject,
        body,
        recipients: {
          to: resolved.to.join(", "),
          cc: resolved.cc.join(", "),
          bcc: resolved.bcc.join(", "),
        },
        bccReasons: resolved.bccReasons ?? [],
      };
    },
  );
};

export default returnsRoute;
