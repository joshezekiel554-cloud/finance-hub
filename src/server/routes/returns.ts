import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { backfillLinksForRma } from "../modules/rma/email-linker.js";
import {
  createRma,
  getRmaById,
  listRmas,
  updateRma,
  approveRma,
  denyRma,
  issueCreditMemo,
  markReplacementSent,
  markAlreadyCredited,
  forceStatus,
  setTracking,
  addRmaItem,
  updateRmaItem,
  removeRmaItem,
  generateWarehouseExport,
  cancelWarehouseExport,
  cancelRma,
  deleteRma,
  revertToDraft,
  setWarehouseNumber,
  manualMarkReceived,
  overrideApproveRma,
} from "../../modules/returns/index.js";
import {
  createRmaFromReceipt,
  dismissExtensivReceipt,
  confirmExtensivReceipt,
} from "../../modules/returns/rma-service.js";
import returnsPhotosRoute from "./returns-photos.js";
import {
  lookupItemPriceForCustomer,
  findOriginalInvoiceForItem,
} from "../../modules/returns/qbo-lookup.js";
import { parseReturnRequestEmail } from "../../modules/returns/parser.js";
import { getSourceInvoiceTaxStatus } from "../../modules/returns/source-invoice-tax.js";
import { getPriorInvoiceItems } from "../../modules/returns/prior-invoice-check.js";
import {
  RMA_RETURN_TYPES,
  RMA_STATUSES,
  RMA_ITEM_CLASSIFICATIONS,
  extensivReceipts,
  rmaItems,
  seasons,
} from "../../db/schema/returns.js";
import { customers } from "../../db/schema/customers.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import { db } from "../../db/index.js";
import { renderTemplate } from "../../modules/email-compose/index.js";
import { resolveRecipients } from "../../modules/customer-emails/recipients.js";
import { requireAuth, isAdmin } from "../lib/auth.js";
import { runEligibility } from "../../modules/returns/eligibility.js";
import { buildExtensivExportFile } from "../../modules/returns/extensiv-export.js";

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
  // Pagination offset. 0-based. Without this the route silently truncates
  // past `limit` rows; with it, operators can scroll backwards in time.
  offset: z.coerce.number().int().min(0).default(0).optional(),
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
  seasonId: z.string().max(24).nullable().optional(),
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
  applyTax: z.boolean().optional(),
  taxCodeRef: z.string().max(64).nullable().optional(),
});

const markReplacementSentBodySchema = z.object({}).passthrough();

const markAlreadyCreditedBodySchema = z.object({
  creditMemoDocNumber: z.string().min(1).max(64),
});

const forceStatusBodySchema = z.object({
  status: z.enum(RMA_STATUSES),
  reason: z.string().max(1000).nullable().optional(),
});

const setTrackingBodySchema = z.object({
  trackingNumber: z.string().min(1).max(128),
  trackingCarrier: z.string().max(64).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Receipt dismiss-with-reason schema
// ---------------------------------------------------------------------------

const dismissWithReasonBodySchema = z.object({
  reason: z.enum(["done", "not_return", "other"]),
  reasonText: z.string().max(50).optional(), // 50 chars + "other: " prefix fits in dismissed_reason varchar(64)
});

// ---------------------------------------------------------------------------
// Phase 3 warehouse + eligibility + override schemas
// ---------------------------------------------------------------------------

const setWarehouseNumberBodySchema = z.object({
  txNumber: z.string().min(1).max(64),
});

const overrideApproveBodySchema = z.object({
  reason: z.string().min(1).max(2000),
});

const runEligibilityBodySchema = z.object({
  seasonId: z.string().min(1).max(24),
  items: z
    .array(
      z.object({
        lineTotal: z.string().min(1),
        classification: z.enum(RMA_ITEM_CLASSIFICATIONS),
      }),
    )
    .optional(),
});

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
  qbItemId: z.string().max(64).optional(),
  sku: z.string().max(255).optional(),
  name: z.string().max(255).optional(),
  quantity: z.string().optional(),
  unitPrice: z.string().optional(),
  listUnitPrice: z.string().optional().nullable(),
  invoiceDiscountPct: z.string().optional().nullable(),
  reason: z.string().max(2000).optional().nullable(),
  originalInvoiceDocNumber: z.string().max(64).optional().nullable(),
  originalInvoiceDate: z.string().optional().nullable(),
  classification: z.enum(RMA_ITEM_CLASSIFICATIONS).optional(),
  receivedQuantity: z.string().optional().nullable(),
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
  // Photo upload/list/delete sub-routes (multipart — registered first so the
  // content-type parser is scoped before JSON routes try to parse bodies).
  await app.register(returnsPhotosRoute, { prefix: "/:id/photos" });

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

  // ---- GET /qbo-prior-invoice-items?qbCustomerId=... -----------------------
  // Returns the set of qbItemIds that have appeared on any prior invoice
  // for a customer. Drives the damage wizard's "not found on prior invoices"
  // soft warning. We expose this as a customer-scoped route (not RMA-scoped)
  // so the wizard can call it before an RMA exists.
  app.get("/qbo-prior-invoice-items", async (req, reply) => {
    await requireAuth(req);
    const parse = z
      .object({ qbCustomerId: z.string().min(1).max(64) })
      .safeParse(req.query);
    if (!parse.success) {
      reply.code(400);
      return { error: "qbCustomerId required" };
    }
    try {
      return await getPriorInvoiceItems(parse.data.qbCustomerId);
    } catch (err) {
      reply.code(502);
      return {
        error:
          err instanceof Error
            ? err.message
            : "QBO prior-invoice lookup failed",
      };
    }
  });

  // ---- GET /:id/source-invoice-tax -----------------------------------------
  // Looks up each unique original invoice for the RMA's items in QBO and
  // reports whether sales tax was applied at the source. The credit memo
  // dialog uses this to default the "Apply sales tax" checkbox: on if any
  // source invoice was taxed (so a return mirrors the sale), off otherwise.
  // ratePercent is the subtotal-weighted aggregate; taxCodeRef is the QBO
  // TxnTaxCodeRef from the first taxed invoice (mirrored onto the CM).
  app.get<{ Params: { id: string } }>(
    "/:id/source-invoice-tax",
    async (req, reply) => {
      await requireAuth(req);
      try {
        return await getSourceInvoiceTaxStatus(req.params.id);
      } catch (err) {
        reply.code(502);
        return {
          error:
            err instanceof Error ? err.message : "QBO tax lookup failed",
        };
      }
    },
  );

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

  // ---- POST /parse-email — AI-extract items from a customer email ---------
  // No rmaId required — operator can parse before saving the draft.
  app.post("/parse-email", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      emailBody: z.string().min(1).max(50000),
      attachmentText: z.string().max(50000).optional(),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    try {
      const result = await parseReturnRequestEmail(parse.data);
      return result;
    } catch (err) {
      reply.code(502);
      return {
        error: err instanceof Error ? err.message : "Parse failed",
      };
    }
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
        applyTax: parse.data.applyTax,
        taxCodeRef: parse.data.taxCodeRef,
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

  // ---- POST /:id/force-status ----------------------------------------------
  // Operator override: change the RMA's status without walking through the
  // state machine. Used to fix imported RMAs whose lifecycle stage drifted
  // from reality (e.g. flip an imported "approved" → "sent_to_warehouse"
  // because the warehouse handoff already happened in the desktop app).
  // Activity log records the change for audit. Does NOT touch other fields.
  app.post<{ Params: { id: string } }>(
    "/:id/force-status",
    async (req, reply) => {
      const user = await requireAuth(req);
      // Force-status bypasses the state machine — restrict to admins so a
      // regular operator can't flip an RMA to any arbitrary status.
      if (!isAdmin(user)) {
        reply.code(403);
        return { error: "admin only" };
      }
      const parse = forceStatusBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await forceStatus(req.params.id, {
        userId: user.id,
        status: parse.data.status,
        reason: parse.data.reason ?? null,
      });
      return mapServiceResult(result, reply);
    },
  );

  // ---- POST /:id/set-tracking ---------------------------------------------
  // Operator pastes the customer's return tracking number; we save it +
  // notify the warehouse team if warehouse_team_email is configured.
  app.post<{ Params: { id: string } }>(
    "/:id/set-tracking",
    async (req, reply) => {
      const user = await requireAuth(req);
      const parse = setTrackingBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await setTracking(req.params.id, {
        userId: user.id,
        trackingNumber: parse.data.trackingNumber,
        trackingCarrier: parse.data.trackingCarrier ?? null,
        notes: parse.data.notes ?? null,
      });
      if (result === null) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!result.ok) {
        reply.code(409);
        return { error: result.reason };
      }
      return { rma: result.rma, emailedTo: result.emailedTo };
    },
  );

  // ---- POST /:id/mark-already-credited -------------------------------------
  // Reconcile imported RMAs whose desktop status was stale: the CM was
  // issued in QBO but the desktop never advanced past "approved". Operator
  // pastes the QBO doc#, we verify it exists, then move to completed.
  app.post<{ Params: { id: string } }>(
    "/:id/mark-already-credited",
    async (req, reply) => {
      const user = await requireAuth(req);
      const parse = markAlreadyCreditedBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await markAlreadyCredited(req.params.id, {
        userId: user.id,
        creditMemoDocNumber: parse.data.creditMemoDocNumber,
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

  // ---- POST /qbo-lookup-prices ---------------------------------------------
  // Customer-scoped lookup — doesn't require a saved RMA. Used by the create
  // form so operators can pull prices BEFORE saving a draft.
  app.post("/qbo-lookup-prices", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      qbCustomerId: z.string().min(1),
      qbItemId: z.string().min(1),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const result = await lookupItemPriceForCustomer({
      qboCustomerId: parse.data.qbCustomerId,
      qbItemId: parse.data.qbItemId,
    });
    if (!result) {
      reply.code(404);
      return { error: "No matching invoice found for this item and customer" };
    }
    return result;
  });

  // ---- POST /qbo-find-original-invoice -------------------------------------
  app.post("/qbo-find-original-invoice", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      qbCustomerId: z.string().min(1),
      qbItemId: z.string().min(1),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const result = await findOriginalInvoiceForItem({
      qboCustomerId: parse.data.qbCustomerId,
      qbItemId: parse.data.qbItemId,
    });
    if (!result) {
      reply.code(404);
      return { error: "No matching invoice found" };
    }
    return result;
  });

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
        .where(eq(rmaItems.rmaId, rma.id))
        .orderBy(rmaItems.position);

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

  // ==========================================================================
  // Phase 3 warehouse round-trip + eligibility + override-approve routes
  // ==========================================================================

  // ---- POST /:id/generate-warehouse-export ---------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/generate-warehouse-export",
    async (req, reply) => {
      const user = await requireAuth(req);
      const result = await generateWarehouseExport({ rmaId: req.params.id, userId: user.id });
      if (result === null) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!result.ok) {
        reply.code(409);
        return { error: result.reason };
      }
      // Return JSON with base64-encoded content so the frontend can trigger a
      // download via Blob/anchor (avoids Fastify streaming complexity for this
      // infrequent, small file).
      return {
        rma: result.rma,
        exportFile: {
          filename: result.exportFile.filename,
          content: Buffer.from(result.exportFile.content, "utf-8").toString("base64"),
          mimeType: "text/tab-separated-values",
        },
      };
    },
  );

  // ---- POST /:id/revert-to-draft -------------------------------------------
  // Roll an in-flight RMA back to draft so the operator can edit. Clears
  // workflow side-effects (rmaNumber for non-damage, extensiv timestamps,
  // approval/denial/override fields). Items + audit trail kept intact.
  app.post<{ Params: { id: string } }>(
    "/:id/revert-to-draft",
    async (req, reply) => {
      const user = await requireAuth(req);
      const result = await revertToDraft({
        rmaId: req.params.id,
        userId: user.id,
      });
      if (!result) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!result.ok) {
        reply.code(409);
        return { error: result.reason };
      }
      return result.rma;
    },
  );

  // ---- POST /:id/cancel ----------------------------------------------------
  // Transitions an in-flight RMA (approved / awaiting_warehouse_number /
  // sent_to_warehouse) to cancelled. Reason is appended to notes.
  app.post<{ Params: { id: string } }>(
    "/:id/cancel",
    async (req, reply) => {
      const user = await requireAuth(req);
      const schema = z.object({
        reason: z.string().max(2000).optional().nullable(),
      });
      const parse = schema.safeParse(req.body ?? {});
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await cancelRma({
        rmaId: req.params.id,
        userId: user.id,
        reason: parse.data.reason ?? null,
      });
      if (!result) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!result.ok) {
        reply.code(409);
        return { error: result.reason };
      }
      return result.rma;
    },
  );

  // ---- DELETE /:id ---------------------------------------------------------
  // Hard-delete an RMA. Only allowed for `draft` or `cancelled` — anything
  // in-flight needs to be cancelled first to preserve audit trail.
  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    // Hard delete is destructive (rma + items + photos cascade). Restrict to
    // admins so a regular operator can't permanently remove an RMA — even
    // ones in draft/cancelled — without elevated privilege.
    if (!isAdmin(user)) {
      reply.code(403);
      return { error: "admin only" };
    }
    const result = await deleteRma({ rmaId: req.params.id, userId: user.id });
    if (!result) {
      reply.code(404);
      return { error: "RMA not found" };
    }
    if (!result.ok) {
      reply.code(409);
      return { error: result.reason };
    }
    return { ok: true };
  });

  // ---- POST /:id/cancel-warehouse-export -----------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/cancel-warehouse-export",
    async (req, reply) => {
      const user = await requireAuth(req);
      const result = await cancelWarehouseExport({ rmaId: req.params.id, userId: user.id });
      return mapServiceResult(result, reply);
    },
  );

  // ---- POST /:id/set-warehouse-number --------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/set-warehouse-number",
    async (req, reply) => {
      const user = await requireAuth(req);
      const parse = setWarehouseNumberBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await setWarehouseNumber({
        rmaId: req.params.id,
        userId: user.id,
        txNumber: parse.data.txNumber,
      });
      if (result === null) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!result.ok) {
        reply.code(409);
        return { error: result.reason };
      }
      // Return RMA + email-dialog-ready payload (PDF Drive ID if override path)
      return {
        rma: result.rma,
        emailDialogPayload: {
          pdfDriveId: result.rma.denialPdfDriveId ?? null,
          thresholdOverridden: result.rma.thresholdOverridden ?? false,
        },
      };
    },
  );

  // ---- POST /:id/manual-mark-received --------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/manual-mark-received",
    async (req, reply) => {
      const user = await requireAuth(req);
      const result = await manualMarkReceived({ rmaId: req.params.id, userId: user.id });
      return mapServiceResult(result, reply);
    },
  );

  // ---- POST /:id/override-approve ------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/override-approve",
    async (req, reply) => {
      const user = await requireAuth(req);
      const parse = overrideApproveBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await overrideApproveRma({
        rmaId: req.params.id,
        userId: user.id,
        reason: parse.data.reason,
      });
      return mapServiceResult(result, reply);
    },
  );

  // ---- GET /:id/extensiv-export --------------------------------------------
  // Re-builds the Extensiv export file from current RMA state and returns it
  // as base64 JSON (frontend triggers download via Blob). Useful when the
  // original download was missed.
  app.get<{ Params: { id: string } }>(
    "/:id/extensiv-export",
    async (req, reply) => {
      await requireAuth(req);
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

      let seasonName = "";
      if (rma.seasonId) {
        const seasonRows = await db
          .select({ name: seasons.name })
          .from(seasons)
          .where(eq(seasons.id, rma.seasonId));
        seasonName = seasonRows[0]?.name ?? "";
      }

      const exportFile = buildExtensivExportFile({
        rma: { rmaNumber: rma.rmaNumber ?? null, extensivRef: rma.extensivRef ?? null },
        customer: { name: customer.displayName, qbCustomerId: rma.qbCustomerId ?? "" },
        season: { name: seasonName },
        items: rma.items.map((item) => ({
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
        })),
      });

      return {
        exportFile: {
          filename: exportFile.filename,
          content: Buffer.from(exportFile.content, "utf-8").toString("base64"),
          mimeType: "text/tab-separated-values",
        },
      };
    },
  );

  // ---- GET /:id/eligibility-pdf --------------------------------------------
  // Streams the denial PDF from Drive if denialPdfDriveId is set, or
  // re-renders it on the fly if not.
  app.get<{ Params: { id: string } }>(
    "/:id/eligibility-pdf",
    async (req, reply) => {
      // Trust requireAuth's resolved user — never the X-User-ID header,
      // which is client-supplied and would let any caller impersonate
      // another operator's Drive context.
      const user = await requireAuth(req);
      const rma = await getRmaById(req.params.id);
      if (!rma) {
        reply.code(404);
        return { error: "RMA not found" };
      }

      // If we have a Drive file ID, fetch from Drive and stream it.
      if (rma.denialPdfDriveId) {
        try {
          const { downloadFileContent } = await import("../../integrations/google-drive/client.js");
          const pdfBuffer = await downloadFileContent({
            userId: user.id,
            fileId: rma.denialPdfDriveId,
          });
          reply.header("Content-Type", "application/pdf");
          reply.header("Content-Disposition", `inline; filename="eligibility-${rma.id}.pdf"`);
          return reply.send(pdfBuffer);
        } catch (err) {
          // Fall through to re-render
          console.warn("[eligibility-pdf] Drive fetch failed, re-rendering:", err);
        }
      }

      // Re-render from current RMA state
      if (!rma.seasonId) {
        reply.code(409);
        return { error: "RMA has no season — cannot generate eligibility PDF" };
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

      const seasonRows = await db
        .select({ name: seasons.name })
        .from(seasons)
        .where(eq(seasons.id, rma.seasonId));
      const seasonName = seasonRows[0]?.name ?? "Season";

      const breakdown = await runEligibility({
        customerId: rma.customerId,
        qbCustomerId: rma.qbCustomerId ?? "",
        seasonId: rma.seasonId,
        proposedItems: rma.items.map((item) => ({
          lineTotal: item.lineTotal,
          classification: item.classification,
          qbItemId: item.qbItemId,
          originalInvoiceDocNumber: item.originalInvoiceDocNumber,
        })),
        excludeRmaId: rma.id,
      });

      const { generateEligibilityPdf } = await import("../../modules/returns/eligibility-pdf.js");
      const pdfBuffer = await generateEligibilityPdf({
        rma: { id: rma.id, rmaNumber: rma.rmaNumber ?? null },
        customer: { name: customer.displayName },
        season: { name: seasonName },
        breakdown,
        items: rma.items.map((item) => ({
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          classification: item.classification,
          priorSeasonId: item.priorSeasonId,
        })),
      });

      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `inline; filename="eligibility-${rma.id}.pdf"`);
      return reply.send(pdfBuffer);
    },
  );

  // ---- POST /qbo-eligibility-pdf -------------------------------------------
  // Customer-scoped PDF preview — generates the eligibility report from
  // wizard inputs without needing an existing RMA. Returns PDF binary.
  app.post("/qbo-eligibility-pdf", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      customerId: z.string().min(1),
      qbCustomerId: z.string().min(1),
      seasonId: z.string().min(1),
      items: z
        .array(
          z.object({
            sku: z.string(),
            name: z.string(),
            quantity: z.string(),
            unitPrice: z.string(),
            lineTotal: z.string(),
            classification: z.enum(RMA_ITEM_CLASSIFICATIONS),
            priorSeasonId: z.string().nullable().optional(),
            qbItemId: z.string().nullable().optional(),
            originalInvoiceDocNumber: z.string().nullable().optional(),
          }),
        )
        .default([]),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }

    // Lookup customer + season for the PDF header
    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, parse.data.customerId))
      .limit(1);
    const customer = customerRows[0];
    if (!customer) {
      reply.code(404);
      return { error: "Customer not found" };
    }
    const seasonRows = await db
      .select()
      .from(seasons)
      .where(eq(seasons.id, parse.data.seasonId))
      .limit(1);
    const season = seasonRows[0];
    if (!season) {
      reply.code(404);
      return { error: "Season not found" };
    }

    const breakdown = await runEligibility({
      customerId: parse.data.customerId,
      qbCustomerId: parse.data.qbCustomerId,
      seasonId: parse.data.seasonId,
      proposedItems: parse.data.items.map((it) => ({
        lineTotal: it.lineTotal,
        classification: it.classification,
        qbItemId: it.qbItemId ?? null,
        originalInvoiceDocNumber: it.originalInvoiceDocNumber ?? null,
      })),
    });

    const { generateEligibilityPdf } = await import(
      "../../modules/returns/eligibility-pdf.js"
    );
    const pdfBuffer = await generateEligibilityPdf({
      rma: { id: "preview", rmaNumber: null },
      customer: { name: customer.displayName },
      season: { name: season.name },
      breakdown,
      items: parse.data.items.map((it) => ({
        sku: it.sku,
        name: it.name,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal: it.lineTotal,
        classification: it.classification,
        priorSeasonId: it.priorSeasonId ?? null,
      })),
    });

    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `inline; filename="eligibility-preview.pdf"`,
    );
    return reply.send(pdfBuffer);
  });

  // ---- POST /qbo-run-eligibility -------------------------------------------
  // Customer-scoped eligibility — doesn't require a saved RMA. Used by the
  // wizard's eligibility step before the operator has approved.
  app.post("/qbo-run-eligibility", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      customerId: z.string().min(1),
      qbCustomerId: z.string().min(1),
      seasonId: z.string().min(1),
      items: z
        .array(
          z.object({
            lineTotal: z.string(),
            classification: z.enum(RMA_ITEM_CLASSIFICATIONS),
          }),
        )
        .default([]),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const breakdown = await runEligibility({
      customerId: parse.data.customerId,
      qbCustomerId: parse.data.qbCustomerId,
      seasonId: parse.data.seasonId,
      proposedItems: parse.data.items,
    });
    return { breakdown };
  });

  // ---- POST /:id/run-eligibility -------------------------------------------
  // Runs the eligibility module with the given seasonId + optionally overridden
  // items. Used by the live eligibility card on the frontend.
  app.post<{ Params: { id: string } }>(
    "/:id/run-eligibility",
    async (req, reply) => {
      await requireAuth(req);
      const parse = runEligibilityBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }

      const rma = await getRmaById(req.params.id);
      if (!rma) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      if (!rma.qbCustomerId) {
        reply.code(409);
        return { error: "RMA has no QBO customer ID" };
      }

      const proposedItems = parse.data.items
        ? parse.data.items
        : rma.items.map((item) => ({
            lineTotal: item.lineTotal,
            classification: item.classification,
          }));

      const breakdown = await runEligibility({
        customerId: rma.customerId,
        qbCustomerId: rma.qbCustomerId,
        seasonId: parse.data.seasonId,
        proposedItems,
        excludeRmaId: rma.id,
      });

      return { breakdown };
    },
  );

  // ---- POST /:id/preview-override-approval-email ---------------------------
  // Pre-renders the override-approval email template with override context vars
  // and the denial PDF drive link. Returns { subject, body, recipients, pdfDriveId }.
  // Fired when set-warehouse-number is clicked on an override-approved RMA.
  app.post<{ Params: { id: string } }>(
    "/:id/preview-override-approval-email",
    async (req, reply) => {
      await requireAuth(req);
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

      // Try the rma-override-approval template first; fall back to rma-approval.
      const templateRows = await db
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.slug, "rma-override-approval"))
        .limit(1);
      const overrideTemplate = templateRows[0];

      const fallbackRows = overrideTemplate
        ? []
        : await db
            .select()
            .from(emailTemplates)
            .where(eq(emailTemplates.slug, "rma-approval"))
            .limit(1);
      const template = overrideTemplate ?? fallbackRows[0];

      if (!template) {
        reply.code(404);
        return { error: "rma-approval template not found — run the seed script" };
      }

      const items = rma.items ?? [];
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

      const vars: Record<string, string> = {
        customer_name: customer.displayName,
        rma_number: rma.rmaNumber ?? rma.id,
        items_list: itemsList || "  (no items recorded)",
        override_reason: rma.overrideReason ?? "",
        approval_opening:
          "We have reviewed your return request and are pleased to approve it (approved with management override).",
        resolution_body: "A credit memo will be issued to your account once the return is received and processed.",
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
        pdfDriveId: rma.denialPdfDriveId ?? null,
      };
    },
  );

  // ---- POST /:id/preview-credit-memo-email ---------------------------------
  // Returns { subject, body, recipients } for the credit memo dialog so the
  // operator can review + edit before sending. Accepts optional overrides for
  // shippingDeduction, restockingFee, and receivedQuantity per item.
  // The CM doc number isn't allocated yet at preview time — for damage RMAs
  // the doc number equals the rmaNumber (allocated on approve), so we use that
  // as the preview placeholder.
  app.post<{ Params: { id: string } }>(
    "/:id/preview-credit-memo-email",
    async (req, reply) => {
      await requireAuth(req);

      const bodyParse = z
        .object({
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
          // Sales tax preview. The dialog passes both: applyTax controls
          // whether tax is included in totals, salesTaxRatePercent is the
          // rate from the source-invoice-tax lookup (e.g. 11 for 11%).
          applyTax: z.boolean().optional(),
          salesTaxRatePercent: z.number().min(0).max(100).optional(),
        })
        .safeParse(req.body);

      const overrides = bodyParse.success ? bodyParse.data : {};

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
        .where(eq(emailTemplates.slug, "rma-credit-memo"))
        .limit(1);
      const template = templateRows[0];
      if (!template) {
        reply.code(404);
        return {
          error:
            "rma-credit-memo template not found — run the seed script",
        };
      }

      // Apply received-quantity overrides and compute totals
      const items = rma.items ?? [];
      const itemsWithOverrides = items.map((item) => {
        const override = overrides.itemOverrides?.find(
          (o) => o.itemId === item.id,
        );
        const rcvdQty = override?.receivedQuantity ?? item.receivedQuantity ?? item.quantity;
        return {
          ...item,
          effectiveReceivedQty: parseFloat(rcvdQty) || 0,
        };
      });

      const goodsSubtotal = itemsWithOverrides.reduce((sum, item) => {
        return sum + item.effectiveReceivedQty * (parseFloat(item.unitPrice) || 0);
      }, 0);

      const shippingAmt = parseFloat(overrides.shippingDeduction ?? "0") || 0;
      const restockingAmt = parseFloat(overrides.restockingFee ?? "0") || 0;

      // Sales tax estimate. Tax is computed on the goods amount net of
      // deductions — i.e. the actual taxable credit the customer receives —
      // matching how QBO computes tax on the credit memo from line subtotal.
      const taxableBase = Math.max(0, goodsSubtotal - shippingAmt - restockingAmt);
      const salesTaxAmount =
        overrides.applyTax && overrides.salesTaxRatePercent
          ? taxableBase * (overrides.salesTaxRatePercent / 100)
          : 0;

      const totalCreditAmount = Math.max(
        0,
        goodsSubtotal - shippingAmt - restockingAmt + salesTaxAmount,
      );

      // For damage RMAs the CM doc number = RMA number (allocated on approve).
      // For preview before issuance, use rmaNumber or a "[pending]" placeholder.
      const creditMemoDocNumber =
        rma.creditMemoDocNumber ??
        rma.rmaNumber ??
        "[pending]";

      // Build the deductions_section block. One line per non-zero deduction
      // plus the sales-tax line when applicable. Empty when none apply. Sits
      // between goods_subtotal and total_credit_amount in the template.
      const deductionLines: string[] = [];
      if (shippingAmt > 0) {
        deductionLines.push(
          `Return shipping deducted: -$${shippingAmt.toFixed(2)}`,
        );
      }
      if (restockingAmt > 0) {
        deductionLines.push(`Restocking fee: -$${restockingAmt.toFixed(2)}`);
      }
      if (salesTaxAmount > 0) {
        deductionLines.push(`Sales tax: $${salesTaxAmount.toFixed(2)}`);
      }
      const deductionsSection = deductionLines.join("\n");

      const vars: Record<string, string> = {
        customer_name: customer.displayName,
        rma_number: rma.rmaNumber ?? rma.id,
        credit_memo_doc_number: creditMemoDocNumber,
        goods_subtotal: `$${goodsSubtotal.toFixed(2)}`,
        shipping_deduction_amount:
          shippingAmt > 0 ? `$${shippingAmt.toFixed(2)}` : "$0.00",
        restocking_fee_amount:
          restockingAmt > 0 ? `$${restockingAmt.toFixed(2)}` : "$0.00",
        sales_tax_amount: `$${salesTaxAmount.toFixed(2)}`,
        total_credit_amount: `$${totalCreditAmount.toFixed(2)}`,
        deductions_section: deductionsSection,
        company_name: "Feldart",
        user_name: "",
      };

      const subject = renderTemplate(template.subject, vars);
      const body = renderTemplate(template.body, vars);

      // Credit memos go to invoice recipients (not chase) — invoice billing is the customer-facing relationship for these.
      const resolved = await resolveRecipients("invoice", {
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

  // ==========================================================================
  // Phase 4 — Receipt routes
  // ==========================================================================

  // ---- POST /:id/attach-receipt -------------------------------------------
  // Manually links an existing extensiv_receipt to this RMA (operator-confirmed match).
  app.post<{ Params: { id: string } }>("/:id/attach-receipt", async (req, reply) => {
    await requireAuth(req);
    const parse = z.object({ receiptId: z.string().min(1) }).safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const { receiptId } = parse.data;
    const rma = await getRmaById(req.params.id);
    if (!rma) {
      reply.code(404);
      return { error: "RMA not found" };
    }
    const receiptRows = await db
      .select()
      .from(extensivReceipts)
      .where(eq(extensivReceipts.id, receiptId))
      .limit(1);
    if (receiptRows.length === 0) {
      reply.code(404);
      return { error: "Receipt not found" };
    }
    await db
      .update(extensivReceipts)
      .set({ rmaId: req.params.id, matchKind: "exact_tx_number" })
      .where(eq(extensivReceipts.id, receiptId));
    const updated = await db
      .select()
      .from(extensivReceipts)
      .where(eq(extensivReceipts.id, receiptId))
      .limit(1);
    return updated[0];
  });

  // ---- POST /from-receipt --------------------------------------------------
  // Creates a new RMA in "received" status from an unmatched receipt.
  app.post("/from-receipt", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = z
      .object({
        receiptId: z.string().min(1),
        customerId: z.string().min(1).max(24),
        qbCustomerId: z.string().min(1).max(64),
        returnType: z.enum(RMA_RETURN_TYPES),
        items: z
          .array(
            z.object({
              qbItemId: z.string().min(1).max(64),
              sku: z.string().min(1).max(64),
              name: z.string().min(1).max(500),
              quantity: z.string().min(1),
              unitPrice: z.string().min(1),
              classification: z.enum(RMA_ITEM_CLASSIFICATIONS),
              lineTotal: z.string().optional(),
            }),
          )
          .min(1),
      })
      .safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }

    // Cross-check the supplied customerId against our customers table and
    // verify qbCustomerId actually belongs to that customer. Without this,
    // a caller could attach an RMA to any customer they choose by tampering
    // with the body fields. Also confirm the receipt is still unconfirmed
    // and undismissed so a duplicate review submit fails cleanly instead
    // of silently double-creating RMAs.
    const customerRows = await db
      .select({ id: customers.id, qbCustomerId: customers.qbCustomerId })
      .from(customers)
      .where(eq(customers.id, parse.data.customerId))
      .limit(1);
    if (customerRows.length === 0) {
      reply.code(404);
      return { error: "Customer not found" };
    }
    if (customerRows[0]!.qbCustomerId !== parse.data.qbCustomerId) {
      reply.code(400);
      return {
        error:
          "qbCustomerId does not match the supplied customerId — refresh the receipt review.",
      };
    }

    const receiptRows = await db
      .select({
        id: extensivReceipts.id,
        rmaId: extensivReceipts.rmaId,
        confirmedAt: extensivReceipts.confirmedAt,
        dismissedAt: extensivReceipts.dismissedAt,
      })
      .from(extensivReceipts)
      .where(eq(extensivReceipts.id, parse.data.receiptId))
      .limit(1);
    if (receiptRows.length === 0) {
      reply.code(404);
      return { error: "Receipt not found" };
    }
    const existingReceipt = receiptRows[0]!;
    if (existingReceipt.confirmedAt || existingReceipt.dismissedAt || existingReceipt.rmaId) {
      reply.code(409);
      return {
        error:
          "Receipt has already been processed (confirmed, dismissed, or linked to an RMA).",
      };
    }

    try {
      const rma = await createRmaFromReceipt({
        receiptId: parse.data.receiptId,
        customerId: parse.data.customerId,
        qbCustomerId: parse.data.qbCustomerId,
        returnType: parse.data.returnType,
        items: parse.data.items.map((item) => ({
          id: "", // will be replaced in service
          rmaId: "", // will be replaced in service
          position: 0, // will be replaced in service
          qbItemId: item.qbItemId,
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal ?? "0",
          classification: item.classification,
          listUnitPrice: null,
          invoiceDiscountPct: null,
          reason: null,
          originalInvoiceDocNumber: null,
          originalInvoiceDate: null,
          receivedQuantity: item.quantity,
          priorSeasonId: null,
          priorSeasonOverrideReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        userId: user.id,
      });
      reply.code(201);
      return rma;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : "Failed to create RMA from receipt" };
    }
  });

  // ---- POST /extensiv-receipts/:receiptId/dismiss --------------------------
  app.post<{ Params: { receiptId: string } }>(
    "/extensiv-receipts/:receiptId/dismiss",
    async (req, reply) => {
      const user = await requireAuth(req);
      try {
        await dismissExtensivReceipt({ receiptId: req.params.receiptId, userId: user.id });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Dismiss failed";
        if (msg.includes("not found")) {
          reply.code(404);
          return { error: msg };
        }
        reply.code(500);
        return { error: msg };
      }
    },
  );

  // ---- POST /extensiv-receipts/:receiptId/confirm --------------------------
  app.post<{ Params: { receiptId: string } }>(
    "/extensiv-receipts/:receiptId/confirm",
    async (req, reply) => {
      const user = await requireAuth(req);
      try {
        const result = await confirmExtensivReceipt({
          receiptId: req.params.receiptId,
          userId: user.id,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Confirm failed";
        if (msg.includes("not found")) {
          reply.code(404);
          return { error: msg };
        }
        reply.code(500);
        return { error: msg };
      }
    },
  );

  // ---- POST /extensiv-receipts/:receiptId/dismiss-with-reason --------------
  // Soft-dismisses a receipt with a structured reason. Distinct from the
  // legacy `/dismiss` endpoint (which sets only dismissedAt/dismissedByUserId)
  // in that it also sets dismissedReason. The legacy endpoint is left intact
  // for backwards compatibility — both paths soft-dismiss.
  app.post<{ Params: { receiptId: string } }>(
    "/extensiv-receipts/:receiptId/dismiss-with-reason",
    async (req, reply) => {
      const user = await requireAuth(req);
      const parse = dismissWithReasonBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "invalid body", details: parse.error.flatten() };
      }
      const { reason, reasonText } = parse.data;
      const composedReason =
        reason === "other" && reasonText ? `other: ${reasonText}` : reason;

      const rows = await db
        .select({ id: extensivReceipts.id })
        .from(extensivReceipts)
        .where(eq(extensivReceipts.id, req.params.receiptId))
        .limit(1);
      if (rows.length === 0) {
        reply.code(404);
        return { error: "Receipt not found" };
      }

      await db
        .update(extensivReceipts)
        .set({
          dismissedAt: new Date(),
          dismissedReason: composedReason,
          dismissedByUserId: user.id,
        })
        .where(eq(extensivReceipts.id, req.params.receiptId));
      return { ok: true };
    },
  );

  // ---- GET /:id/parsed-receipts -------------------------------------------
  // Aggregates parsed-items entries from every undismissed extensiv_receipt
  // linked to this RMA. The credit-memo create page calls this to merge
  // warehouse-reported quantities into Line[] without depending on the
  // legacy receipt-review-dialog flow having ever run for this RMA.
  //
  // Response shape:
  //   { receiptCount: number,
  //     items: Array<{ sku: string; quantity: number }> }
  //
  // Items are deduplicated by SKU, summed across receipts, and ordered
  // by first-seen position so the credit memo page can append "unexpected"
  // SKUs (those not on the RMA) deterministically.
  app.get<{ Params: { id: string } }>("/:id/parsed-receipts", async (req, reply) => {
    await requireAuth(req);

    const rma = await getRmaById(req.params.id);
    if (!rma) {
      reply.code(404);
      return { error: "RMA not found" };
    }

    // Stable ordering across receipts: classifiedAt asc → first arrival wins
    // first-seen position. Without this, the order across multi-receipt RMAs
    // depends on row-id collation, which is fine but less obvious to debug.
    const receipts = await db
      .select({
        id: extensivReceipts.id,
        gmailMessageId: extensivReceipts.gmailMessageId,
        classifiedAt: extensivReceipts.classifiedAt,
        parsedItemsJson: extensivReceipts.parsedItemsJson,
      })
      .from(extensivReceipts)
      .where(
        and(
          eq(extensivReceipts.rmaId, req.params.id),
          isNull(extensivReceipts.dismissedAt),
        ),
      )
      .orderBy(asc(extensivReceipts.classifiedAt));

    // parsedItemsJson is a JSON column — Drizzle deserialises it for us.
    // Defensive coercion mirrors the Today-tab read in invoicing.ts:
    // tolerate null / non-array shapes (legacy rows, partial parses) and
    // coerce quantity to Number rather than 500ing.
    const merged = new Map<string, number>();
    const orderedSkus: string[] = [];
    const seen = new Set<string>();

    for (const r of receipts) {
      const raw = r.parsedItemsJson;
      if (!Array.isArray(raw)) continue;
      const parsed = (raw as Array<{ sku?: unknown; quantity?: unknown }>)
        .filter((item): item is { sku: string; quantity: unknown } =>
          !!item && typeof item === "object" && typeof (item as { sku?: unknown }).sku === "string",
        )
        .map((item) => ({ sku: item.sku, quantity: Number(item.quantity ?? 0) }));
      for (const item of parsed) {
        if (!seen.has(item.sku)) {
          seen.add(item.sku);
          orderedSkus.push(item.sku);
        }
        merged.set(item.sku, (merged.get(item.sku) ?? 0) + item.quantity);
      }
    }

    const items = orderedSkus.map((sku) => ({
      sku,
      quantity: merged.get(sku) ?? 0,
    }));

    return { receiptCount: receipts.length, items };
  });

  // ---- POST /:id/refresh-email-links ----------------------------------------
  // On-demand backfill: re-scans Gmail for emails that mention this RMA's
  // number and inserts missing email_rma_links rows. Called from the
  // "Check for emails" button on the RMA detail page.
  app.post<{ Params: { id: string } }>("/:id/refresh-email-links", async (req, reply) => {
    await requireAuth(req);
    try {
      const result = await backfillLinksForRma(req.params.id);
      return result;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : "Backfill failed" };
    }
  });
};

export default returnsRoute;
