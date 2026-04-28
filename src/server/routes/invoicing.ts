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
import { searchEmails, getMessageHtmlBody } from "../../integrations/gmail/client.js";
import { QboClient } from "../../integrations/qb/client.js";
import { ShopifyClient, getOrderByName } from "../../integrations/shopify/index.js";
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
});

const invoicingRoutes: FastifyPluginAsync = async (app) => {
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

    const rows: InvoicingTodayRow[] = await Promise.all(
      emails.map((email) => buildRow(email.id, email.emailDate, qbClient, shopifyClient)),
    );

    return reply.send({ rows, shadowMode: env.SHADOW_MODE });
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
          // Live POST hook: forwards the prepared sparse-update payload to
          // QboClient.updateInvoice. Only invoked when shadowMode=false.
          postUpdate: async (payload) => qbClient.updateInvoice(payload),
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
  qb: QboClient,
  shopify: ShopifyClient,
): Promise<InvoicingTodayRow> {
  let html = "";
  try {
    html = await getMessageHtmlBody(gmailId);
  } catch (err) {
    log.warn({ err, gmailId }, "gmail message fetch failed");
  }
  const parseResult = parseShipmentHtml(html);

  const docNumber = parseResult.shipment.shopifyOrderNumber;

  // Parallel: QB invoice + Shopify order. Either may fail independently.
  const [qbInvoice, qbInvoiceError, shopifyOrder, shopifyOrderError] =
    await fetchLookups(docNumber, qb, shopify);

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
        }
      : null,
    shopifyOrderError,
    reconcileResult,
  };
}

async function fetchLookups(
  docNumber: string | null,
  qb: QboClient,
  shopify: ShopifyClient,
): Promise<[QboInvoice | null, string | null, Awaited<ReturnType<typeof getOrderByName>>, string | null]> {
  if (!docNumber) {
    return [null, "no shopify order number parsed", null, "no shopify order number parsed"];
  }
  const [qbInv, shopOrder] = await Promise.all([
    qb.getInvoiceByDocNumber(docNumber).catch((err: Error) => err),
    getOrderByName(shopify, docNumber).catch((err: Error) => err),
  ]);
  const qbInvoice = qbInv instanceof Error ? null : qbInv;
  const qbErr =
    qbInv instanceof Error
      ? qbInv.message
      : qbInv === null
        ? `no QB invoice with DocNumber=${docNumber}`
        : null;
  const shopifyOrder = shopOrder instanceof Error ? null : shopOrder;
  const shopErr =
    shopOrder instanceof Error
      ? shopOrder.message
      : shopOrder === null
        ? `no Shopify order matching ${docNumber}`
        : null;
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
