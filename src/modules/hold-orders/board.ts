// Hold Orders board loader: every held / recently-released / at-risk order
// with why-held, ladder stage, QBO invoice, shipped status and mismatch flag.
//
// Data sources (all batched, no per-row calls):
//   - orders + customers (status record + customer context)
//   - customer_hold_rules + open invoices (rule engine → at-risk + why)
//   - listFlaggedOverdueOrders (the SAME qualification the dashboard's
//     "Orders to review" uses → standard at-risk)
//   - invoices by DocNumber == order number (the app's existing order↔invoice
//     link, see hold-actions cancelHoldOrder) → "invoiced"
//   - Extensiv (Blue Chip WMS) shipment notifications already stored in
//     email_log (the same emails Invoicing Today parses; PO "SHOP<n>" → order
//     <n>) → "shipped", cached 5 min; falls back to Shopify fulfilment.
//     No live Extensiv API call: finance's Extensiv creds are read-only and
//     the order API keys by Extensiv's own order id, which the shipment email
//     already gives us.

import { and, desc, eq, gte, inArray, isNull, like, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { emailLog } from "../../db/schema/crm.js";
import { parseShipmentHtml } from "../b2b-invoicing/parser.js";
import { listFlaggedOverdueOrders } from "../orders/overdue-alerts.js";
import { classifyOrderHoldAlert } from "../orders/hold-alerts.js";
import { loadCandidateOrders, loadEffectiveRules, loadOpenInvoices } from "./rules-store.js";
import { loadAppSettings } from "../statements/settings.js";
import { parseHoldsConfig } from "./holds-settings.js";
import { loadPromiseSources } from "./promise-source.js";
import { evaluateCustomerRule, isOrderOpen, ordersRuleWouldHold } from "./rule-engine.js";
import {
  daysBetween,
  humanHoldReason,
  isChasing,
  ladderStage,
  mismatchFor,
  normalizeOrderNumber,
  promiseActive,
  type HoldTab,
  type LadderStage,
  type Mismatch,
  type ShippedInfo,
} from "./board-classify.js";
import { describeRule } from "./presets.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "hold-orders.board" });

export const RELEASED_LOOKBACK_DAYS = 30;
const SHIPMENT_LOOKBACK_DAYS = 60;
const SHIPMENT_SENDER = "notifications@secure-wms.com";
const SHIPMENT_SUBJECT = "requested transaction notification";

export type HoldBoardRow = {
  orderId: string;
  orderNumber: string;
  shopifyOrderId: string;
  orderDate: string | null;
  amount: string | null;
  customerId: string | null;
  customerName: string | null;
  // Present only when the viewer may see balances.
  balance?: string | null;
  overdueBalance?: string | null;
  holdState: string;
  holdReason: string | null;
  why: string;
  holdStartedAt: string | null;
  daysHeld: number;
  ladderStage: LadderStage;
  chasing: boolean;
  pausedUntil: string | null;
  pauseNote: string | null;
  // Active customer promise-to-pay. emailUrl = hub inbox link to the email
  // it came from (null when typed by hand / no matching scan).
  promise: { payBy: string; note: string | null; emailUrl: string | null } | null;
  releasedAt: string | null;
  invoiced: { docNumber: string; status: string | null; balance: string } | null;
  shipped: ShippedInfo | null;
  mismatch: Mismatch | null;
  atRisk: boolean;
  tabs: HoldTab[];
  links: { shopify: string; financeCustomer: string | null };
};

export type HoldBoard = {
  rows: HoldBoardRow[];
  counts: Record<HoldTab, number>;
  generatedAt: string;
};

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

// ---- Extensiv shipment index (email_log), cached ---------------------------

let shipmentCache: { at: number; map: Map<string, ShippedInfo> } | null = null;
const SHIPMENT_CACHE_MS = 5 * 60_000;

export function invalidateShipmentCache(): void {
  shipmentCache = null;
}

async function loadExtensivShipments(now: Date): Promise<Map<string, ShippedInfo>> {
  if (shipmentCache && now.getTime() - shipmentCache.at < SHIPMENT_CACHE_MS) return shipmentCache.map;
  const map = new Map<string, ShippedInfo>();
  try {
    const rows = await db
      .select({ bodyHtml: emailLog.bodyHtml, emailDate: emailLog.emailDate })
      .from(emailLog)
      .where(
        and(
          like(emailLog.fromAddress, `%${SHIPMENT_SENDER}%`),
          like(emailLog.subject, `%${SHIPMENT_SUBJECT}%`),
          gte(emailLog.emailDate, new Date(now.getTime() - SHIPMENT_LOOKBACK_DAYS * 86_400_000)),
        ),
      )
      .orderBy(desc(emailLog.emailDate))
      .limit(3000);
    for (const r of rows) {
      if (!r.bodyHtml) continue;
      const s = parseShipmentHtml(r.bodyHtml).shipment;
      const key = normalizeOrderNumber(s.shopifyOrderNumber);
      if (!key || map.has(key)) continue; // newest first wins
      map.set(key, {
        source: "extensiv",
        trackingNumber: s.trackingNumber,
        shipDate: s.shipDate,
        carrier: s.carrierShort ?? s.carrierLong,
        transactionNumber: s.transactionNumber,
      });
    }
  } catch (err) {
    log.error({ err }, "extensiv shipment index failed — shipped column falls back to Shopify");
  }
  shipmentCache = { at: now.getTime(), map };
  return map;
}

function shopifyShipped(o: {
  fulfillmentStatus: string | null;
  shipmentStatus: string | null;
  trackingNumber: string | null;
  trackingCompany: string | null;
}): ShippedInfo | null {
  const f = (o.fulfillmentStatus ?? "").toLowerCase();
  if (f === "fulfilled" || f === "partial" || (o.shipmentStatus ?? "") !== "" || o.trackingNumber) {
    if (f === "restocked") return null;
    return {
      source: "shopify",
      trackingNumber: o.trackingNumber,
      shipDate: null,
      carrier: o.trackingCompany,
    };
  }
  return null;
}

// ---- main loader -----------------------------------------------------------

const orderCols = {
  orderId: orders.id,
  orderNumber: orders.orderNumber,
  shopifyOrderId: orders.shopifyOrderId,
  orderDate: orders.orderDate,
  total: orders.total,
  financialStatus: orders.financialStatus,
  fulfillmentStatus: orders.fulfillmentStatus,
  shipmentStatus: orders.shipmentStatus,
  trackingNumber: orders.trackingNumber,
  trackingCompany: orders.trackingCompany,
  cancelledAt: orders.cancelledAt,
  holdState: orders.holdState,
  holdReason: orders.holdReason,
  holdNote: orders.holdNote,
  holdLadderEnabled: orders.holdLadderEnabled,
  holdLadderPausedUntil: orders.holdLadderPausedUntil,
  holdLadderPauseNote: orders.holdLadderPauseNote,
  holdStartedAt: orders.holdStartedAt,
  holdReleasedAt: orders.holdReleasedAt,
  holdNoticeAt: orders.holdNoticeAt,
  holdWarnedAt: orders.holdWarnedAt,
  holdCancelNotifiedAt: orders.holdCancelNotifiedAt,
  customerId: orders.customerId,
  customerName: customers.displayName,
  customerHoldStatus: customers.holdStatus,
  balance: customers.balance,
  overdueBalance: customers.overdueBalance,
  promisedPayBy: customers.promisedPayBy,
  promiseNote: customers.promiseNote,
};

export async function loadHoldBoard(opts: {
  seeBalances: boolean;
  financeLinks: boolean;
  now?: Date;
  extraOrderIds?: string[];
}): Promise<HoldBoard> {
  const now = opts.now ?? new Date();
  const config = parseHoldsConfig(await loadAppSettings());
  const releasedCutoff = new Date(now.getTime() - RELEASED_LOOKBACK_DAYS * 86_400_000);

  // 1) Held + recently released.
  const statusRows = await db
    .select(orderCols)
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(
      or(
        eq(orders.holdState, "on_hold"),
        and(eq(orders.holdState, "released"), gte(orders.holdReleasedAt, releasedCutoff)),
      ),
    )
    .orderBy(desc(orders.holdStartedAt))
    .limit(1500);

  // 2) At risk: would be held by a rule / standard detection but isn't yet.
  const atRiskWhy = new Map<string, string[]>();
  const addRisk = (orderId: string, why: string) => {
    const list = atRiskWhy.get(orderId) ?? [];
    if (!list.includes(why)) list.push(why);
    atRiskWhy.set(orderId, list);
  };
  const rules = await loadEffectiveRules(config);
  const ruleIds = [...rules.entries()].filter(([, r]) => r.preset !== "never").map(([id]) => id);
  if (ruleIds.length > 0) {
    const [inv, ord] = await Promise.all([
      loadOpenInvoices(ruleIds),
      loadCandidateOrders(ruleIds, now, config.ruleOrderLookbackDays),
    ]);
    for (const id of ruleIds) {
      const rule = rules.get(id)!;
      const ev = evaluateCustomerRule(rule, inv.get(id) ?? [], now);
      for (const o of ordersRuleWouldHold(ev, ord.get(id) ?? [])) {
        addRisk(o.orderId, ev.why ?? `Rule: ${describeRule(rule)}`);
      }
    }
  }
  try {
    for (const f of await listFlaggedOverdueOrders(200)) {
      addRisk(
        f.orderId,
        `Standard review: $${Number(f.overdueBalance).toFixed(2)} overdue and not in contact`,
      );
    }
  } catch (err) {
    log.error({ err }, "at-risk: overdue review query failed");
  }
  // Account-state holds that standard detection didn't catch (it only
  // auto-holds orders inside its short new-order window).
  const lookback = new Date(now.getTime() - config.ruleOrderLookbackDays * 86_400_000);
  const acctRows = await db
    .select({
      orderId: orders.id,
      cancelledAt: orders.cancelledAt,
      financialStatus: orders.financialStatus,
      holdStatus: customers.holdStatus,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(
      and(
        eq(orders.holdState, "none"),
        isNull(orders.cancelledAt),
        gte(orders.orderDate, lookback),
        inArray(customers.holdStatus, ["hold", "payment_upfront"]),
      ),
    )
    .limit(500);
  for (const a of acctRows) {
    const reason = classifyOrderHoldAlert({
      cancelledAt: a.cancelledAt,
      holdStatus: a.holdStatus,
      financialStatus: a.financialStatus,
    });
    if (reason === "customer_on_hold") addRisk(a.orderId, "Customer account is on hold");
    if (reason === "payment_upfront_unpaid") addRisk(a.orderId, "Payment upfront — order not paid yet");
  }

  const known = new Set(statusRows.map((r) => r.orderId));
  const riskIds = [...atRiskWhy.keys()].filter((id) => !known.has(id));
  const riskRows =
    riskIds.length > 0
      ? await db
          .select(orderCols)
          .from(orders)
          .leftJoin(customers, eq(orders.customerId, customers.id))
          .where(and(inArray(orders.id, riskIds), eq(orders.holdState, "none")))
      : [];
  const all = [...statusRows, ...riskRows.filter((r) => isOrderOpen(r))];
  // Explicitly requested orders (the drawer for any order, e.g. one found by
  // number to hold manually).
  const extra = (opts.extraOrderIds ?? []).filter((id) => !all.some((r) => r.orderId === id));
  const extraSet = new Set(extra);
  if (extra.length > 0) {
    all.push(
      ...(await db
        .select(orderCols)
        .from(orders)
        .leftJoin(customers, eq(orders.customerId, customers.id))
        .where(inArray(orders.id, extra))),
    );
  }

  // 3) QBO invoices by DocNumber.
  const docNumbers = Array.from(
    new Set(all.map((r) => normalizeOrderNumber(r.orderNumber)).filter((d): d is string => Boolean(d))),
  );
  const invoiceBy = new Map<string, { docNumber: string; status: string | null; balance: string }>();
  for (let i = 0; i < docNumbers.length; i += 500) {
    const chunk = docNumbers.slice(i, i + 500);
    const inv = await db
      .select({ docNumber: invoices.docNumber, status: invoices.status, balance: invoices.balance })
      .from(invoices)
      .where(and(inArray(invoices.docNumber, chunk), sql`(${invoices.status} IS NULL OR ${invoices.status} <> 'void')`));
    for (const v of inv) {
      if (v.docNumber) invoiceBy.set(v.docNumber, { docNumber: v.docNumber, status: v.status, balance: v.balance });
    }
  }

  // 4) Shipped.
  const extensiv = await loadExtensivShipments(now);

  // 5) Promise source emails (customers with an active promise only).
  const promised = new Map<string, string>();
  for (const r of all) {
    if (r.customerId && r.promisedPayBy && promiseActive(r.promisedPayBy, now)) promised.set(r.customerId, r.promisedPayBy);
  }
  let promiseSources = new Map<string, { url: string }>();
  try {
    promiseSources = await loadPromiseSources([...promised].map(([customerId, payBy]) => ({ customerId, payBy })));
  } catch (err) {
    log.error({ err }, "promise source lookup failed — promises shown without email links");
  }

  const counts: Record<HoldTab, number> = {
    held: 0,
    chasing: 0,
    at_risk: 0,
    shipped_while_held: 0,
    released: 0,
  };
  const shopDomain = env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const rows: HoldBoardRow[] = all.map((r) => {
    const num = r.orderNumber ?? `#${r.shopifyOrderId}`;
    const key = normalizeOrderNumber(num);
    const shipped = (key ? extensiv.get(key) : undefined) ?? shopifyShipped(r);
    const holdState = r.holdState ?? "none";
    const stage = ladderStage(
      {
        holdState,
        ladderEnabled: r.holdLadderEnabled,
        pausedUntil: r.holdLadderPausedUntil,
        promisedPayBy: r.promisedPayBy,
        noticeAt: r.holdNoticeAt,
        warnedAt: r.holdWarnedAt,
        cancelNotifiedAt: r.holdCancelNotifiedAt,
      },
      now,
    );
    const mismatch = mismatchFor({ holdState, shipped, customerHoldStatus: r.customerHoldStatus });
    const risk = holdState === "none" ? (atRiskWhy.get(r.orderId) ?? []) : [];
    const tabs: HoldTab[] = [];
    if (holdState === "on_hold") tabs.push("held");
    if (isChasing(stage)) tabs.push("chasing");
    if (risk.length > 0) tabs.push("at_risk");
    if (mismatch === "shipped_while_held") tabs.push("shipped_while_held");
    if (holdState === "released") tabs.push("released");
    // Extra (drawer-only) rows aren't part of any tab.
    if (extraSet.has(r.orderId)) tabs.length = 0;
    for (const t of tabs) counts[t] += 1;

    const row: HoldBoardRow = {
      orderId: r.orderId,
      orderNumber: num,
      shopifyOrderId: r.shopifyOrderId,
      orderDate: iso(r.orderDate),
      amount: r.total,
      customerId: r.customerId,
      customerName: r.customerName ?? null,
      holdState,
      holdReason: r.holdReason,
      why: risk.length > 0 ? `Would hold: ${risk.join("; ")}` : humanHoldReason(r.holdReason, r.holdNote),
      holdStartedAt: iso(r.holdStartedAt),
      daysHeld: holdState === "on_hold" ? daysBetween(r.holdStartedAt, now) : 0,
      ladderStage: stage,
      chasing: isChasing(stage),
      pausedUntil: iso(r.holdLadderPausedUntil),
      pauseNote: r.holdLadderPauseNote,
      promise: r.promisedPayBy && promiseActive(r.promisedPayBy, now)
        ? {
            payBy: r.promisedPayBy,
            note: r.promiseNote ?? null,
            emailUrl: (r.customerId ? promiseSources.get(r.customerId)?.url : undefined) ?? null,
          }
        : null,
      releasedAt: iso(r.holdReleasedAt),
      invoiced: key ? (invoiceBy.get(key) ?? null) : null,
      shipped,
      mismatch,
      atRisk: risk.length > 0,
      tabs,
      links: {
        shopify: `https://${shopDomain}/admin/orders/${r.shopifyOrderId}`,
        financeCustomer:
          opts.financeLinks && r.customerId ? `${env.PUBLIC_URL}/customers/${r.customerId}` : null,
      },
    };
    if (opts.seeBalances) {
      row.balance = r.balance ?? null;
      row.overdueBalance = r.overdueBalance ?? null;
    }
    return row;
  });

  return { rows, counts, generatedAt: now.toISOString() };
}
