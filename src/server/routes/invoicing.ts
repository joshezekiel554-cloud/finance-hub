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
import { eq } from "drizzle-orm";
import {
  parseShipmentHtml,
  reconcile,
  sendInvoiceUpdate,
  type ReconcileAction,
  type InvoiceLineForReconcile,
  type ShipmentForReconcile,
  type ShopifyOrderLineForReconcile,
} from "../../modules/b2b-invoicing/index.js";
import type { QboInvoice } from "../../integrations/qb/types.js";
import { db } from "../../db/index.js";
import {
  dismissedShipments,
  DISMISS_REASONS,
} from "../../db/schema/dismissed-shipments.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

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
    id: string;
    docNumber: string;
    syncToken: string;
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
    // SKU → retail price for the UI's "Shopify price" column.
    lineItems: Array<{ sku: string; retailPrice: number }>;
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
  app.get("/terms", async (_req, reply) => {
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
    let qbBatchError: string | null = null;
    try {
      qbInvoiceMap = await qbClient.getInvoicesByDocNumbers(docNumbers);
    } catch (err) {
      qbBatchError = (err as Error).message;
      log.error({ err }, "batched qbo invoice lookup failed");
    }

    // Phase 3: Shopify lookups in parallel (their rate limits are looser),
    // then assemble. Keep parallelism since we no longer compete with QBO.
    const rows: InvoicingTodayRow[] = await Promise.all(
      parsed.map((p) =>
        buildRow(
          p.gmailId,
          p.receivedAt,
          p.parseResult,
          qbInvoiceMap,
          qbBatchError,
          shopifyClient,
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
    const parse = sendBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const {
      invoiceId,
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

    try {
      const outcome = await sendInvoiceUpdate(
        invoice,
        actions as ReconcileAction[],
        {
          shadowMode: env.SHADOW_MODE,
          discountPercent,
          salesTermId,
          salesTermName,
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
  qbBatchError: string | null,
  shopify: ShopifyClient,
): Promise<InvoicingTodayRow> {
  const docNumber = parseResult.shipment.shopifyOrderNumber;

  // Resolve QB invoice from the batched lookup map; Shopify still goes
  // per-row but parallel-safe since QBO isn't competing.
  const [qbInvoice, qbInvoiceError, shopifyOrder, shopifyOrderError] =
    await resolveLookups(docNumber, qbInvoiceMap, qbBatchError, shopify);

  // Run reconciler only when we have a QB invoice + complete shipment metadata.
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
    qbInvoice: qbInvoice
      ? {
          id: qbInvoice.Id,
          docNumber: qbInvoice.DocNumber ?? "",
          syncToken: qbInvoice.SyncToken ?? "0",
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
          billEmail:
            (qbInvoice as unknown as { BillEmail?: { Address?: string } }).BillEmail
              ?.Address ?? null,
          billEmailCc:
            (qbInvoice as unknown as { BillEmailCc?: { Address?: string } }).BillEmailCc
              ?.Address ?? null,
          billEmailBcc:
            (qbInvoice as unknown as { BillEmailBcc?: { Address?: string } }).BillEmailBcc
              ?.Address ?? null,
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
            .map((li) => ({
              sku: li.sku as string,
              retailPrice: Number(li.price),
            })),
        }
      : null,
    shopifyOrderError,
    reconcileResult,
  };
}

async function resolveLookups(
  docNumber: string | null,
  qbInvoiceMap: Map<string, QboInvoice>,
  qbBatchError: string | null,
  shopify: ShopifyClient,
): Promise<[QboInvoice | null, string | null, Awaited<ReturnType<typeof getOrderByName>>, string | null]> {
  if (!docNumber) {
    return [null, "no shopify order number parsed", null, "no shopify order number parsed"];
  }
  const qbInvoice = qbInvoiceMap.get(docNumber) ?? null;
  const qbErr =
    qbInvoice === null
      ? qbBatchError ?? `no QB invoice with DocNumber=${docNumber}`
      : null;

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

  return [qbInvoice, qbErr, shopifyOrder, shopErr];
}

// Map a QboInvoice's SalesItemLineDetail rows into the reconciler's narrow
// input shape. SKU lives in Description per the 3rd-party Shopify→QB sync
// convention. Skip subtotal lines.
export function invoiceLinesForReconcile(
  invoice: QboInvoice,
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
