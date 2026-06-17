// Shopify orders sync.
//
// Incrementally pulls orders updated since the last run (checkpoint in
// app_settings) and upserts them into the `orders` table with payment status,
// fulfilment status, and tracking — the data behind the per-customer Orders tab
// and the hold/overdue order alerts (added in later phases). Runs every ~15 min
// in the worker. Shopify uses a static admin token (no oauth row), so the
// checkpoint lives in app_settings rather than oauth_tokens.meta.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Job } from "bullmq";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { orders, type OrderLineItem } from "../../db/schema/catalog.js";
import { ShopifyClient } from "../../integrations/shopify/client.js";
import { listOrdersSince } from "../../integrations/shopify/orders.js";
import type {
  ShopifyOrder,
  ShopifyFulfillment,
} from "../../integrations/shopify/types.js";
import { buildCustomerEmailIndex } from "../../modules/crm/email-match.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.orders-sync" });

// Internal checkpoint key (not a canonical APP_SETTING — never surfaced in the
// Settings UI; read/written directly here).
const CHECKPOINT_KEY = "orders_sync_updated_at_min";
// First run with no checkpoint looks back this far so we don't pull the entire
// order history in one go.
const INITIAL_LOOKBACK_DAYS = 30;
const PAGE_SIZE = 250;

export type OrdersSyncJobData = { trigger?: "scheduled" | "manual" };
export type OrdersSyncJobResult = {
  fetched: number;
  upserted: number;
  matched: number;
  cursorAdvancedTo: string | null;
  durationMs: number;
};

async function readCheckpoint(): Promise<string | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, CHECKPOINT_KEY))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function writeCheckpoint(iso: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: CHECKPOINT_KEY, value: iso })
    .onDuplicateKeyUpdate({ set: { value: iso } });
}

// Pick the most informative fulfilment for tracking: the newest one that
// actually has a tracking number, else the newest fulfilment (for shipment
// status), else null.
function pickFulfilment(
  fulfilments: ShopifyFulfillment[] | undefined,
): ShopifyFulfillment | null {
  if (!fulfilments || fulfilments.length === 0) return null;
  const byNewest = [...fulfilments].sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );
  return byNewest.find((f) => f.tracking_number) ?? byNewest[0] ?? null;
}

// Legacy `status` enum value, derived for back-compat with existing callers.
// The granular financial/fulfilment/shipment columns are authoritative for the
// UI; this is a coarse rollup.
function deriveStatus(
  o: ShopifyOrder,
): "pending" | "paid" | "shipped" | "fulfilled" | "cancelled" | "refunded" {
  if (o.cancelled_at) return "cancelled";
  const fin = (o.financial_status ?? "").toLowerCase();
  if (fin.includes("refunded")) return "refunded";
  const ful = (o.fulfillment_status ?? "").toLowerCase();
  if (ful === "fulfilled") return "fulfilled";
  if (ful === "partial") return "shipped";
  if (fin === "paid") return "paid";
  return "pending";
}

function mapLineItems(o: ShopifyOrder): OrderLineItem[] {
  return o.line_items.map((li) => ({
    sku: li.sku ?? "",
    name: li.title ?? undefined,
    qty: li.quantity,
    unitPrice: li.price != null ? String(li.price) : undefined,
  }));
}

// Map a Shopify order to the columns we upsert. customerId resolved by the
// caller (email index). Exported for unit testing.
export function mapOrderToRow(o: ShopifyOrder, customerId: string | null) {
  const f = pickFulfilment(o.fulfillments);
  const trackingNumber = f?.tracking_number ?? f?.tracking_numbers?.[0] ?? null;
  const trackingUrl = f?.tracking_url ?? f?.tracking_urls?.[0] ?? null;
  const lineItems = mapLineItems(o);
  return {
    shopifyOrderId: String(o.id),
    customerId,
    orderNumber: o.name,
    orderDate: o.created_at ? new Date(o.created_at) : null,
    email: o.email ?? null,
    notesRaw: o.note ?? null,
    lineItems,
    total: o.total_price != null ? String(o.total_price) : null,
    itemCount: lineItems.reduce((n, li) => n + (li.qty || 0), 0),
    status: deriveStatus(o),
    financialStatus: o.financial_status ?? null,
    fulfillmentStatus: o.fulfillment_status ?? "unfulfilled",
    trackingNumber,
    trackingUrl,
    trackingCompany: f?.tracking_company ?? null,
    shipmentStatus: f?.shipment_status ?? null,
    cancelledAt: o.cancelled_at ? new Date(o.cancelled_at) : null,
  };
}

export async function processOrdersSync(
  job: Job<OrdersSyncJobData>,
): Promise<OrdersSyncJobResult> {
  const startedAt = Date.now();
  const jobLog = log.child({ jobId: job.id });

  const cursorIso = await readCheckpoint();
  const updatedAtMin =
    cursorIso ??
    new Date(
      Date.now() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

  jobLog.info(
    { stage: "started", updatedAtMin, trigger: job.data.trigger ?? "scheduled" },
    "orders-sync started",
  );

  const client = new ShopifyClient();
  const emailIndex = await buildCustomerEmailIndex();

  let fetched = 0;
  let upserted = 0;
  let matched = 0;
  let newestUpdatedAt = cursorIso;
  let pageToken: string | null = null;

  do {
    const page = await listOrdersSince(client, {
      updatedAtMin,
      status: "any",
      pageSize: PAGE_SIZE,
      pageToken,
    });
    for (const o of page.items) {
      fetched += 1;
      const customerId = o.email
        ? (emailIndex.get(o.email.trim().toLowerCase()) ?? null)
        : null;
      if (customerId) matched += 1;
      const row = mapOrderToRow(o, customerId);
      try {
        await db
          .insert(orders)
          .values({ id: nanoid(24), ...row })
          .onDuplicateKeyUpdate({
            set: {
              customerId: row.customerId,
              orderNumber: row.orderNumber,
              orderDate: row.orderDate,
              email: row.email,
              notesRaw: row.notesRaw,
              lineItems: row.lineItems,
              total: row.total,
              itemCount: row.itemCount,
              status: row.status,
              financialStatus: row.financialStatus,
              fulfillmentStatus: row.fulfillmentStatus,
              trackingNumber: row.trackingNumber,
              trackingUrl: row.trackingUrl,
              trackingCompany: row.trackingCompany,
              shipmentStatus: row.shipmentStatus,
              cancelledAt: row.cancelledAt,
            },
          });
        upserted += 1;
      } catch (err) {
        jobLog.warn(
          { err, shopifyOrderId: row.shopifyOrderId },
          "orders-sync: upsert failed for one order; skipping",
        );
      }
      if (o.updated_at && (!newestUpdatedAt || o.updated_at > newestUpdatedAt)) {
        newestUpdatedAt = o.updated_at;
      }
    }
    pageToken = page.next;
  } while (pageToken);

  // Advance the checkpoint (Shopify updated_at is inclusive; the unique index
  // dedups the re-fetched boundary order).
  if (newestUpdatedAt && newestUpdatedAt !== cursorIso) {
    await writeCheckpoint(newestUpdatedAt);
  }

  // Fire hold / payment-upfront alerts for any recent un-alerted violations.
  // Isolated in its own try/catch so an alert hiccup never fails the sync (the
  // alert is idempotent and retries next run).
  try {
    const { runOrderHoldAlerts } = await import(
      "../../modules/orders/hold-alerts.js"
    );
    const alertResult = await runOrderHoldAlerts();
    if (alertResult.candidates > 0) {
      jobLog.info({ stage: "hold-alerts", ...alertResult }, "order hold alerts");
    }
  } catch (err) {
    jobLog.error({ err }, "orders-sync: hold-alert pass failed (non-fatal)");
  }

  const durationMs = Date.now() - startedAt;
  jobLog.info(
    { stage: "completed", fetched, upserted, matched, durationMs },
    "orders-sync completed",
  );
  return {
    fetched,
    upserted,
    matched,
    cursorAdvancedTo: newestUpdatedAt ?? null,
    durationMs,
  };
}
