// B2B invoicing route — drives the /invoicing/today UI.
//
// GET  /today  → For each Feldart shipment email in the last N days, return
//                a record bundling: parsed shipment, matched QB invoice
//                (by DocNumber), matched Shopify order (by name), and the
//                reconciler's proposed action list. Live read every call —
//                no DB caching of parsed shipments at this stage.
// POST /send   → Apply user-confirmed actions to a QB invoice (sparse
//                update). Honors SHADOW_MODE: in shadow, returns the payload
//                that WOULD have been posted; in live, posts and returns
//                the QBO response.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { searchEmails } from "../../integrations/gmail/client.js";
import { QboClient } from "../../integrations/qb/client.js";
import { ShopifyClient, getOrderByName } from "../../integrations/shopify/index.js";
import { eq, inArray } from "drizzle-orm";
import {
  parseShipmentHtml,
  reconcile,
  sendInvoiceUpdate,
  type ReconcileAction,
  type InvoiceLineForReconcile,
  type ShipmentForReconcile,
  type ShopifyOrderLineForReconcile,
} from "../../modules/b2b-invoicing/index.js";
import type {
  QboInvoice,
  QboSalesReceipt,
} from "../../integrations/qb/types.js";
import { db } from "../../db/index.js";
import {
  dismissedShipments,
  DISMISS_REASONS,
} from "../../db/schema/dismissed-shipments.js";
import { customers } from "../../db/schema/customers.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { requireAuth } from "../lib/auth.js";
import { resolveRecipientsWithRules } from "../../modules/customer-emails/recipients.js";
import {
  emailRoutingRules,
  type RoutingRuleAction,
} from "../../db/schema/email-routing-rules.js";
import type { Customer } from "../../db/schema/customers.js";

const log = createLogger({ component: "invoicing-route" });

const SENDER = "notifications@secure-wms.com";
const SUBJECT = "requested transaction notification";
const DEFAULT_LOOKBACK_DAYS = 7;

// Public response type — feeds the UI directly. Kept narrow so the page can
// render without bringing in QBO/Shopify type internals.
export type InvoicingTodayRow = {
  gmailId: string;
  receivedAt: string | null;
  parseConfidence: number;
  parseMissingFields: string[];
  parsed: {
    poNumber: string | null;
    shopifyOrderNumber: string | null;
    transactionNumber: string | null;
    endCustomerName: string | null;
    carrierShort: string | null;
    carrierLong: string | null;
    trackingNumber: string | null;
    shipDate: string | null;
    lineItems: Array<{ sku: string; quantity: string }>;
  };
  qbInvoice: {
    // Keeps the field name "qbInvoice" for back-compat; the docType
    // discriminator tells the UI whether the matched QBO record is
    // an Invoice (editable, the default) or a SalesReceipt (paid
    // upfront via Shopify; advisory-only — no doc mutation, just
    // shortage warnings to drive an external refund).
    docType: "invoice" | "salesreceipt";
    id: string;
    docNumber: string;
    syncToken: string;
    // finance-hub's local customers.id, looked up via qbCustomerId.
    // Null when there's no matching local mirror — UI uses this to
    // link follow-up actions (refund tasks, etc.) to the customer.
    customerId: string | null;
    customerName: string | null;
    totalAmt: number;
    balance: number;
    currency: string | null;
    existingTrackingNum: string | null;
    existingShipDate: string | null;
    existingShipVia: string | null;
    existingTermsId: string | null;
    existingTermsName: string | null;
    // QBO email status + delivery history
    emailStatus: string | null; // "EmailSent" | "NotSet" | etc
    lastSentAt: string | null; // ISO from DeliveryInfo.DeliveryTime when present
    billEmail: string | null;
    billEmailCc: string | null;
    billEmailBcc: string | null;
    lines: Array<{
      lineId: string;
      sku: string | null;
      qty: number;
      unitPrice: number;
      itemName: string | null;
    }>;
  } | null;
  qbInvoiceError: string | null;
  shopifyOrder: {
    id: number;
    name: string;
    orderNumber: number;
    customerEmail: string | null;
    lineCount: number;
    note: string | null;
    // SKU → per-unit price the customer is paying on this Shopify
    // order (after line-level discounts, pre-tax). NOT the retail
    // list price. The reconciler still uses li.price separately for
    // its B2B 50%-of-retail calc on auto-added lines.
    lineItems: Array<{ sku: string; paidPrice: number }>;
  } | null;
  shopifyOrderError: string | null;
  reconcileResult: {
    actions: ReconcileAction[];
    summary: {
      keep: number;
      qty_change: number;
      add: number;
      addsNeedingPrice: string[];
    };
  } | null;
};

const sendBodySchema = z.object({
  invoiceId: z.string().min(1),
  // Whether the matched QBO doc is an Invoice (default — full
  // reconcile + send) or a SalesReceipt (advisory-only — server
  // ignores `actions`, only PATCHes BillEmail/Cc/Bcc and calls
  // /salesreceipt/{id}/send). Defaults to "invoice" so unupgraded
  // clients keep working.
  docType: z.enum(["invoice", "salesreceipt"]).default("invoice"),
  // Pass actions through verbatim so the UI can edit qty / unitPrice before
  // confirming. Server doesn't trust the client's reconciler output blindly:
  // we re-fetch the invoice and verify SyncToken matches before sending.
  expectedSyncToken: z.string().min(1),
  actions: z.array(z.any()),
  // Optional invoice-level percent discount (0-100). Only applied when > 0;
  // any pre-existing DiscountLineDetail on the invoice is replaced.
  discountPercent: z.number().min(0).max(100).optional(),
  // Optional QBO Term Id override. When set, replaces SalesTermRef on the
  // invoice. When omitted, sparse update leaves existing terms in place.
  salesTermId: z.string().optional(),
  salesTermName: z.string().optional(),
  // Optional customer-facing message rendered on the invoice + statement.
  // Empty/omitted → blanked (clears the auto-sync junk).
  customerMemo: z.string().max(4000).optional(),
  // Optional DocNumber suffix (e.g. "-SP" for special-offer invoices).
  // Idempotent server-side: skipped if the current DocNumber already ends
  // with this suffix.
  docNumberSuffix: z.string().max(20).optional(),
  // Optional email recipient overrides. When provided, persisted on the
  // invoice's BillEmail* fields before /send fires.
  billEmailTo: z.string().max(2000).optional(),
  billEmailCc: z.string().max(2000).optional(),
  billEmailBcc: z.string().max(2000).optional(),
});

const invoicingRoutes: FastifyPluginAsync = async (app) => {
  // Item search for the add-line picker. Returns up to 20 matches.
  app.get("/items/search", async (req, reply) => {
    await requireAuth(req);
    const q = (req.query as { q?: string }).q ?? "";
    if (q.trim().length < 2) {
      return reply.send({ items: [] });
    }
    try {
      const qb = new QboClient();
      const items = await qb.searchItems(q, 20);
      return reply.send({
        items: items.map((it) => ({
          id: it.Id,
          name: it.Name,
          sku: it.Sku ?? null,
          unitPrice: it.UnitPrice ?? null,
          type: it.Type ?? null,
        })),
      });
    } catch (err) {
      log.error({ err, q }, "qbo item search failed");
      return reply.code(502).send({ error: "qbo item search failed" });
    }
  });

  // Fetch active QBO Term entities for the UI dropdown. Cached client-side via
  // TanStack Query; the underlying QBO query is fast (<10 terms typical).
  app.get("/terms", async (req, reply) => {
    await requireAuth(req);
    try {
      const qb = new QboClient();
      const terms = await qb.getTerms();
      const active = terms
        .filter((t) => t.Active !== false)
        .map((t) => ({
          id: t.Id,
          name: t.Name,
          dueDays: t.DueDays ?? null,
        }));
      return reply.send({ terms: active });
    } catch (err) {
      log.error({ err }, "qbo terms fetch failed");
      return reply.code(502).send({ error: "qbo terms fetch failed" });
    }
  });

  app.get("/today", async (req, reply) => {
    await requireAuth(req);
    const lookbackDays = DEFAULT_LOOKBACK_DAYS;
    const sinceMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    const sinceQuery = `from:${SENDER} subject:"${SUBJECT}" after:${Math.floor(sinceMs / 1000)}`;

    let emails;
    try {
      emails = await searchEmails(sinceQuery, 50);
    } catch (err) {
      log.error({ err }, "gmail search failed");
      return reply.code(502).send({ error: "gmail search failed" });
    }

    log.info({ count: emails.length, lookbackDays }, "found feldart shipment emails");

    const qbClient = new QboClient();
    const shopifyClient = new ShopifyClient();

    // Phase 1: parse htmlBody already populated by searchEmails. The Gmail
    // client extracts text/html alongside text/plain in one messages.get
    // pass, so no second round-trip is needed here.
    const parsed = emails.map((email) => ({
      gmailId: email.id,
      receivedAt: email.emailDate,
      parseResult: parseShipmentHtml(email.htmlBody),
    }));

    // Phase 2: ONE batched QBO query for all docNumbers we managed to parse.
    // Replaces the N parallel per-row queries that were tripping QBO's
    // leaky-bucket rate limit (HTTP 429).
    const docNumbers = parsed
      .map((p) => p.parseResult.shipment.shopifyOrderNumber)
      .filter((d): d is string => Boolean(d));
    let qbInvoiceMap = new Map<string, QboInvoice>();
    let qbSalesReceiptMap = new Map<string, QboSalesReceipt>();
    let qbBatchError: string | null = null;
    try {
      // Run both lookups in parallel — the two entity types share QBO's
      // rate limit, but each lookup is one query per CHUNK so paral-
      // lelizing two requests is fine for the leaky bucket.
      const [invoices, salesReceipts] = await Promise.all([
        qbClient.getInvoicesByDocNumbers(docNumbers),
        qbClient.getSalesReceiptsByDocNumbers(docNumbers),
      ]);
      qbInvoiceMap = invoices;
      qbSalesReceiptMap = salesReceipts;
    } catch (err) {
      qbBatchError = (err as Error).message;
      log.error({ err }, "batched qbo invoice/salesreceipt lookup failed");
    }

    // Phase 2.5: batch-load finance-hub customer records for the
    // docs we just fetched, plus all email routing rules in one shot.
    // The buildRow helper needs both to resolve TO/CC/BCC for each
    // doc's pre-fill (per-channel arrays + tag-driven adds), AND it
    // needs the customerType to decide whether to surface a matching
    // SalesReceipt (B2B-only). Doing this once at the top means
    // buildRow stays synchronous on the recipient-resolution path —
    // no per-row DB query.
    const qbCustomerIds = Array.from(
      new Set(
        [
          ...Array.from(qbInvoiceMap.values()).map(
            (inv) => inv.CustomerRef?.value,
          ),
          ...Array.from(qbSalesReceiptMap.values()).map(
            (sr) => sr.CustomerRef?.value,
          ),
        ].filter((v): v is string => Boolean(v)),
      ),
    );
    const customerByQbId = new Map<string, Customer>();
    if (qbCustomerIds.length > 0) {
      const rows = await db
        .select()
        .from(customers)
        .where(inArray(customers.qbCustomerId, qbCustomerIds));
      for (const c of rows) {
        if (c.qbCustomerId) customerByQbId.set(c.qbCustomerId, c);
      }
    }
    const allRoutingRules: Array<{
      tag: string;
      action: RoutingRuleAction;
      value: string;
    }> = await db
      .select({
        tag: emailRoutingRules.tag,
        action: emailRoutingRules.action,
        value: emailRoutingRules.value,
      })
      .from(emailRoutingRules);

    // Phase 3: Shopify lookups in parallel (their rate limits are looser),
    // then assemble. Keep parallelism since we no longer compete with QBO.
    const rows: InvoicingTodayRow[] = await Promise.all(
      parsed.map((p) =>
        buildRow(
          p.gmailId,
          p.receivedAt,
          p.parseResult,
          qbInvoiceMap,
          qbSalesReceiptMap,
          qbBatchError,
          shopifyClient,
          customerByQbId,
          allRoutingRules,
        ),
      ),
    );

    // Phase 4: load the dismissed-shipments map so the UI can split rows
    // into Active vs Dismissed tabs. We always send all rows; the tab
    // toggle is purely client-side filtering.
    const dismissedRows = await db.select().from(dismissedShipments);
    const dismissed: Record<
      string,
      { reason: string; reasonNote: string | null; dismissedAt: string }
    > = {};
    for (const row of dismissedRows) {
      dismissed[row.gmailId] = {
        reason: row.reason,
        reasonNote: row.reasonNote,
        dismissedAt: row.dismissedAt.toISOString(),
      };
    }

    return reply.send({ rows, dismissed, shadowMode: env.SHADOW_MODE });
  });

  // Batch dismiss for the "Dismiss all visible" page-level button.
  app.post("/dismiss-bulk", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      gmailIds: z.array(z.string().min(1).max(64)).min(1).max(200),
      reason: z.enum(DISMISS_REASONS),
      reasonNote: z.string().max(500).optional(),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { gmailIds, reason, reasonNote } = parse.data;
    const now = new Date();
    // Bulk insert via a single VALUES clause; on duplicate, refresh reason +
    // timestamp so a re-bulk overrides the prior categorization.
    await db
      .insert(dismissedShipments)
      .values(
        gmailIds.map((gmailId) => ({
          gmailId,
          reason,
          reasonNote: reasonNote ?? null,
          dismissedAt: now,
        })),
      )
      .onDuplicateKeyUpdate({
        set: { reason, reasonNote: reasonNote ?? null, dismissedAt: now },
      });
    return reply.send({ ok: true, count: gmailIds.length });
  });

  app.post("/dismiss", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      gmailId: z.string().min(1).max(64),
      reason: z.enum(DISMISS_REASONS),
      reasonNote: z.string().max(500).optional(),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { gmailId, reason, reasonNote } = parse.data;
    // Upsert so re-dismissing a previously dismissed shipment refreshes the
    // reason without a unique-constraint error.
    await db
      .insert(dismissedShipments)
      .values({
        gmailId,
        reason,
        reasonNote: reasonNote ?? null,
      })
      .onDuplicateKeyUpdate({
        set: {
          reason,
          reasonNote: reasonNote ?? null,
          dismissedAt: new Date(),
        },
      });
    return reply.send({ ok: true });
  });

  app.post("/restore", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({ gmailId: z.string().min(1).max(64) });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body" });
    }
    await db
      .delete(dismissedShipments)
      .where(eq(dismissedShipments.gmailId, parse.data.gmailId));
    return reply.send({ ok: true });
  });

  app.post("/send", async (req, reply) => {
    await requireAuth(req);
    const parse = sendBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const {
      invoiceId,
      docType,
      expectedSyncToken,
      actions,
      discountPercent,
      salesTermId,
      salesTermName,
      customerMemo,
      docNumberSuffix,
      billEmailTo,
      billEmailCc,
      billEmailBcc,
    } = parse.data;

    const qbClient = new QboClient();

    // SalesReceipt branch — paid upfront on Shopify, line items are
    // settled, no doc mutation. Just PATCH the email recipients onto
    // the receipt and POST /salesreceipt/{id}/send. Shortage actions
    // (if any) are advisory and surface in the UI as "refund needed"
    // hints; they don't change the QBO record. The operator handles
    // the refund externally via Shopify.
    if (docType === "salesreceipt") {
      let receipt;
      try {
        receipt = await qbClient.getSalesReceiptById(invoiceId);
      } catch (err) {
        log.error(
          { err, invoiceId },
          "qbo salesreceipt refetch before send failed",
        );
        return reply.code(502).send({ error: "qbo refetch failed" });
      }
      if (!receipt)
        return reply.code(404).send({ error: "sales receipt not found" });
      if (receipt.SyncToken !== expectedSyncToken) {
        return reply.code(409).send({
          error:
            "sync token mismatch — sales receipt changed since preview",
          currentSyncToken: receipt.SyncToken,
        });
      }

      if (env.SHADOW_MODE) {
        log.info(
          {
            salesReceiptId: receipt.Id,
            docNumber: receipt.DocNumber,
            billEmailTo,
            billEmailCc,
            billEmailBcc,
          },
          "shadow mode: sales receipt PATCH + send prepared, NOT sent",
        );
        return reply.send({
          outcome: {
            status: "shadow",
            payload: {
              Id: receipt.Id,
              SyncToken: receipt.SyncToken,
              sparse: true,
              BillEmail: billEmailTo ? { Address: billEmailTo } : undefined,
              BillEmailCc: billEmailCc ? { Address: billEmailCc } : undefined,
              BillEmailBcc: billEmailBcc
                ? { Address: billEmailBcc }
                : undefined,
            },
          },
          shadowMode: true,
        });
      }

      try {
        // Sparse update: header email fields only. Line array NOT
        // touched — the receipt is a settled record.
        const patchPayload: Record<string, unknown> = {
          Id: receipt.Id,
          SyncToken: receipt.SyncToken,
          sparse: true,
        };
        if (billEmailTo && billEmailTo.trim()) {
          patchPayload.BillEmail = { Address: billEmailTo.trim() };
        }
        if (billEmailCc && billEmailCc.trim()) {
          patchPayload.BillEmailCc = { Address: billEmailCc.trim() };
        }
        if (billEmailBcc && billEmailBcc.trim()) {
          patchPayload.BillEmailBcc = { Address: billEmailBcc.trim() };
        }
        const updated = await qbClient.updateSalesReceipt(patchPayload);
        const sent = await qbClient.sendSalesReceiptEmail(updated.Id);
        log.info(
          {
            salesReceiptId: sent.Id,
            docNumber: sent.DocNumber,
          },
          "sales receipt emailed",
        );
        return reply.send({
          outcome: {
            status: "sent",
            email: {
              sentTo: sent.BillEmail?.Address ?? null,
              sentAt: new Date().toISOString(),
            },
          },
          shadowMode: false,
        });
      } catch (err) {
        log.error({ err, invoiceId }, "salesreceipt send failed");
        return reply.code(500).send({ error: (err as Error).message });
      }
    }

    // Default Invoice branch — the existing reconcile + send flow.
    let invoice: QboInvoice | null = null;
    try {
      invoice = await qbClient.getInvoiceById(invoiceId);
    } catch (err) {
      log.error({ err, invoiceId }, "qbo refetch before send failed");
      return reply.code(502).send({ error: "qbo refetch failed" });
    }
    if (!invoice) return reply.code(404).send({ error: "invoice not found" });
    if (invoice.SyncToken !== expectedSyncToken) {
      return reply.code(409).send({
        error: "sync token mismatch — invoice changed since preview",
        currentSyncToken: invoice.SyncToken,
      });
    }

    // Look up DueDays for the chosen term so the sender can recompute
    // DueDate. Without this QBO leaves the old DueDate in place when
    // SalesTermRef changes (sparse update doesn't cascade). Best-effort:
    // a terms-fetch failure logs + falls back to no DueDate update so the
    // rest of the send still proceeds.
    let salesTermDueDays: number | undefined;
    if (salesTermId) {
      try {
        const terms = await qbClient.getTerms();
        const t = terms.find((x) => x.Id === salesTermId);
        if (t && typeof t.DueDays === "number") {
          salesTermDueDays = t.DueDays;
        }
      } catch (err) {
        log.warn(
          { err, invoiceId, salesTermId },
          "qbo terms lookup failed; DueDate will not be recomputed",
        );
      }
    }

    try {
      const outcome = await sendInvoiceUpdate(
        invoice,
        actions as ReconcileAction[],
        {
          shadowMode: env.SHADOW_MODE,
          discountPercent,
          salesTermId,
          salesTermName,
          salesTermDueDays,
          customerMemo,
          docNumberSuffix,
          billEmailTo,
          billEmailCc,
          billEmailBcc,
          // Live POST hook: forwards the prepared sparse-update payload to
          // QboClient.updateInvoice. Only invoked when shadowMode=false.
          postUpdate: async (payload) => qbClient.updateInvoice(payload),
          // After update, email the invoice to the customer's BillEmail.
          // Skipped in shadow mode by sendInvoiceUpdate's own logic.
          postSendEmail: async (id) => qbClient.sendInvoiceEmail(id),
        },
      );
      return reply.send({ outcome, shadowMode: env.SHADOW_MODE });
    } catch (err) {
      log.error({ err, invoiceId }, "send failed");
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
};

export default invoicingRoutes;

// ---------- helpers ----------

async function buildRow(
  gmailId: string,
  receivedAt: Date | null,
  parseResult: ReturnType<typeof parseShipmentHtml>,
  qbInvoiceMap: Map<string, QboInvoice>,
  qbSalesReceiptMap: Map<string, QboSalesReceipt>,
  qbBatchError: string | null,
  shopify: ShopifyClient,
  customerByQbId: Map<string, Customer>,
  routingRules: Array<{
    tag: string;
    action: RoutingRuleAction;
    value: string;
  }>,
): Promise<InvoicingTodayRow> {
  const docNumber = parseResult.shipment.shopifyOrderNumber;

  // Resolve the matched QBO doc — Invoice first (the common case),
  // SalesReceipt only if the matched customer is B2B (B2C upfront-
  // paid orders are intentionally hidden — operator doesn't need to
  // reconcile + send those). The resolved record is a discriminated
  // union so downstream code can branch by docType.
  const [resolved, qbInvoiceError, shopifyOrder, shopifyOrderError] =
    await resolveLookups(
      docNumber,
      qbInvoiceMap,
      qbSalesReceiptMap,
      customerByQbId,
      qbBatchError,
      shopify,
    );
  const qbInvoice = resolved?.doc ?? null;
  const docType = resolved?.docType ?? null;

  // Run reconciler only when we have a QB doc + complete shipment metadata.
  let reconcileResult: InvoicingTodayRow["reconcileResult"] = null;
  if (
    qbInvoice &&
    parseResult.shipment.trackingNumber &&
    parseResult.shipment.carrierShort &&
    parseResult.shipment.shipDate
  ) {
    const invoiceLines = invoiceLinesForReconcile(qbInvoice);
    const shipment: ShipmentForReconcile = {
      trackingNumber: parseResult.shipment.trackingNumber,
      shipVia: parseResult.shipment.carrierShort,
      shipDate: parseResult.shipment.shipDate,
      lineItems: parseResult.shipment.lineItems.map((l) => ({
        sku: l.sku,
        qty: Number(l.quantity),
      })),
    };
    const shopifyOrderLines: ShopifyOrderLineForReconcile[] | undefined = shopifyOrder
      ? shopifyOrder.line_items
          .filter((li) => li.sku !== null)
          .map((li) => ({
            sku: li.sku as string,
            retailPrice: Number(li.price),
          }))
      : undefined;
    const result = reconcile({ shipment, invoiceLines, shopifyOrderLines });
    reconcileResult = result;
  }

  return {
    gmailId,
    receivedAt: receivedAt?.toISOString() ?? null,
    parseConfidence: parseResult.confidence,
    parseMissingFields: parseResult.missingFields,
    parsed: {
      poNumber: parseResult.shipment.poNumber,
      shopifyOrderNumber: parseResult.shipment.shopifyOrderNumber,
      transactionNumber: parseResult.shipment.transactionNumber,
      endCustomerName: parseResult.shipment.endCustomerName,
      carrierShort: parseResult.shipment.carrierShort,
      carrierLong: parseResult.shipment.carrierLong,
      trackingNumber: parseResult.shipment.trackingNumber,
      shipDate: parseResult.shipment.shipDate,
      lineItems: parseResult.shipment.lineItems,
    },
    qbInvoice: qbInvoice && docType
      ? {
          docType,
          id: qbInvoice.Id,
          docNumber: qbInvoice.DocNumber ?? "",
          syncToken: qbInvoice.SyncToken ?? "0",
          customerId:
            customerByQbId.get(qbInvoice.CustomerRef?.value ?? "")?.id ??
            null,
          customerName: qbInvoice.CustomerRef?.name ?? null,
          totalAmt: qbInvoice.TotalAmt ?? 0,
          balance: qbInvoice.Balance ?? 0,
          currency: qbInvoice.CurrencyRef?.value ?? null,
          existingTrackingNum:
            (qbInvoice as unknown as { TrackingNum?: string }).TrackingNum ?? null,
          existingShipDate:
            (qbInvoice as unknown as { ShipDate?: string }).ShipDate ?? null,
          existingShipVia:
            (qbInvoice as unknown as { ShipMethodRef?: { name?: string } }).ShipMethodRef?.name ??
            null,
          existingTermsId:
            (qbInvoice as unknown as { SalesTermRef?: { value?: string } }).SalesTermRef?.value ??
            null,
          existingTermsName:
            (qbInvoice as unknown as { SalesTermRef?: { name?: string } }).SalesTermRef?.name ??
            null,
          emailStatus:
            (qbInvoice as unknown as { EmailStatus?: string }).EmailStatus ?? null,
          lastSentAt:
            (qbInvoice as unknown as { DeliveryInfo?: { DeliveryTime?: string } })
              .DeliveryInfo?.DeliveryTime ?? null,
          // BillEmail/Cc/Bcc are pre-filled from finance-hub's
          // per-channel arrays + tag rules (resolveRecipientsWithRules)
          // — NOT from whatever's currently on the QBO invoice.
          // QBO's customer entity has no per-customer CC/BCC slot, so
          // those fields on the invoice are usually empty when QBO
          // creates it. Pre-filling from our resolver means tag rules
          // (e.g. yiddy → BCC sales@feldart.com) automatically appear
          // on the form, and the operator's manual edits override on
          // send.
          ...buildResolvedRecipients(
            qbInvoice,
            customerByQbId,
            routingRules,
          ),
          lines: invoiceLinesForReconcile(qbInvoice).map((l) => ({
            lineId: l.lineId,
            sku: l.sku,
            qty: l.qty,
            unitPrice: l.unitPrice,
            itemName: l.description ?? null,
          })),
        }
      : null,
    qbInvoiceError,
    shopifyOrder: shopifyOrder
      ? {
          id: shopifyOrder.id,
          name: shopifyOrder.name,
          orderNumber: shopifyOrder.order_number,
          customerEmail: shopifyOrder.email,
          lineCount: shopifyOrder.line_items.length,
          note: shopifyOrder.note,
          lineItems: shopifyOrder.line_items
            .filter((li) => li.sku !== null)
            .map((li) => {
              // Per-unit paid price = (list × qty − total discount) ÷ qty.
              // total_discount is the Shopify-allocated discount for the
              // whole line, so dividing by qty gives the per-unit number
              // we want to show on the form.
              const list = Number(li.price);
              const qty = li.quantity;
              const discount = Number(li.total_discount ?? "0");
              const paid =
                qty > 0 ? (list * qty - discount) / qty : list;
              return {
                sku: li.sku as string,
                paidPrice: Math.round(paid * 100) / 100,
              };
            }),
        }
      : null,
    shopifyOrderError,
    reconcileResult,
  };
}

// Pre-fill the form's BillEmail/Cc/Bcc fields from finance-hub's
// per-channel arrays + tag rules. Returns the three fields (joined
// strings since the form expects strings, not arrays). Falls back to
// the values currently on the QBO invoice if the customer is missing
// from finance-hub's local mirror — defensive against orphaned rows
// while a fresh sync catches up.
function buildResolvedRecipients(
  qbInvoice: QboInvoice | QboSalesReceipt,
  customerByQbId: Map<string, Customer>,
  routingRules: Array<{
    tag: string;
    action: RoutingRuleAction;
    value: string;
  }>,
): {
  billEmail: string | null;
  billEmailCc: string | null;
  billEmailBcc: string | null;
} {
  const qbCustomerId = qbInvoice.CustomerRef?.value;
  const customer = qbCustomerId
    ? customerByQbId.get(qbCustomerId)
    : undefined;
  if (!customer) {
    return {
      billEmail:
        (qbInvoice as unknown as { BillEmail?: { Address?: string } })
          .BillEmail?.Address ?? null,
      billEmailCc:
        (qbInvoice as unknown as { BillEmailCc?: { Address?: string } })
          .BillEmailCc?.Address ?? null,
      billEmailBcc:
        (qbInvoice as unknown as { BillEmailBcc?: { Address?: string } })
          .BillEmailBcc?.Address ?? null,
    };
  }
  const resolved = resolveRecipientsWithRules(
    "invoice",
    {
      primaryEmail: customer.primaryEmail,
      billingEmails: customer.billingEmails,
      invoiceToEmails: customer.invoiceToEmails,
      invoiceCcEmails: customer.invoiceCcEmails,
      invoiceBccEmails: customer.invoiceBccEmails,
      statementToEmails: customer.statementToEmails,
      statementCcEmails: customer.statementCcEmails,
      statementBccEmails: customer.statementBccEmails,
      tags: customer.tags,
    },
    routingRules,
  );
  return {
    billEmail: resolved.to.length > 0 ? resolved.to.join(", ") : null,
    billEmailCc: resolved.cc.length > 0 ? resolved.cc.join(", ") : null,
    billEmailBcc:
      resolved.bcc.length > 0 ? resolved.bcc.join(", ") : null,
  };
}

// Discriminated union — buildRow uses docType to branch behaviour
// (advisory-only on receipts, no SalesTermRef on receipts, etc.).
// QboSalesReceipt.Line has the same QboInvoiceLine shape as Invoice
// so the reconciler input mapping works uniformly across both.
type ResolvedQbDoc =
  | { docType: "invoice"; doc: QboInvoice }
  | { docType: "salesreceipt"; doc: QboSalesReceipt };

async function resolveLookups(
  docNumber: string | null,
  qbInvoiceMap: Map<string, QboInvoice>,
  qbSalesReceiptMap: Map<string, QboSalesReceipt>,
  customerByQbId: Map<string, Customer>,
  qbBatchError: string | null,
  shopify: ShopifyClient,
): Promise<
  [
    ResolvedQbDoc | null,
    string | null,
    Awaited<ReturnType<typeof getOrderByName>>,
    string | null,
  ]
> {
  if (!docNumber) {
    return [null, "no shopify order number parsed", null, "no shopify order number parsed"];
  }
  const qbInvoice = qbInvoiceMap.get(docNumber) ?? null;
  const qbSalesReceipt = qbSalesReceiptMap.get(docNumber) ?? null;

  let resolved: ResolvedQbDoc | null = null;
  let qbErr: string | null = null;

  if (qbInvoice) {
    resolved = { docType: "invoice", doc: qbInvoice };
  } else if (qbSalesReceipt) {
    // Gate SalesReceipt surfacing on customerType=b2b. The 99% B2C
    // case (paid upfront on the consumer Shopify storefront) silently
    // drops out — those don't need an emailed doc; Shopify already
    // sent the order confirmation. The 1% B2B-prepay case stays on
    // the form so the operator can reconcile + send.
    const cust = customerByQbId.get(
      qbSalesReceipt.CustomerRef?.value ?? "",
    );
    if (cust?.customerType === "b2b") {
      resolved = { docType: "salesreceipt", doc: qbSalesReceipt };
    } else {
      qbErr = `paid upfront sales receipt — customer is ${cust?.customerType ?? "unknown"}, hidden by default`;
    }
  } else {
    qbErr =
      qbBatchError ?? `no QB invoice/receipt with DocNumber=${docNumber}`;
  }

  // Shopify per-row — fast and rarely the bottleneck.
  let shopifyOrder: Awaited<ReturnType<typeof getOrderByName>> = null;
  let shopErr: string | null = null;
  try {
    shopifyOrder = await getOrderByName(shopify, docNumber);
    if (shopifyOrder === null) {
      shopErr = `no Shopify order matching ${docNumber}`;
    }
  } catch (err) {
    shopErr = (err as Error).message;
  }

  return [resolved, qbErr, shopifyOrder, shopErr];
}

// Map a QboInvoice or QboSalesReceipt's SalesItemLineDetail rows into the
// reconciler's narrow input shape. Both entities share the QboInvoiceLine
// shape, so this works uniformly. SKU lives in Description per the 3rd-
// party Shopify→QB sync convention. Skip subtotal lines.
export function invoiceLinesForReconcile(
  invoice: QboInvoice | QboSalesReceipt,
): InvoiceLineForReconcile[] {
  const out: InvoiceLineForReconcile[] = [];
  for (const line of invoice.Line ?? []) {
    if (line.DetailType !== "SalesItemLineDetail") continue;
    if (!line.Id) continue;
    out.push({
      lineId: line.Id,
      sku: line.Description ?? null,
      qty: line.SalesItemLineDetail?.Qty ?? 0,
      unitPrice: line.SalesItemLineDetail?.UnitPrice ?? 0,
      description: line.SalesItemLineDetail?.ItemRef?.name ?? null,
    });
  }
  return out;
}
