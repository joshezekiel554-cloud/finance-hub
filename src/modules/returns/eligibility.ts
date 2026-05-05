// Cumulative seasonal return eligibility checker.
//
// Given a customer, season, and a proposed set of return items, computes
// whether the proposed return would push the customer over the configured
// return threshold for the season. The math:
//
//   cumulativeReturnPct =
//     (alreadyReturnedThisSeason + proposedCounting) / customerSeasonalPurchases × 100
//
// "proposedCounting" = seasonal_current + seasonal_prior items only.
// "non_seasonal" items are included in the breakdown for display but
// excluded from the threshold denominator.
//
// QBO invoice data is queried live via findInvoicesForCustomer — we filter
// client-side for invoices within the season date window (cheaper than
// a per-invoice item query against QBO's DSL, which isn't reliable across
// minor versions). Only line items whose ItemRef.value is in the season's
// seasonal_products set are counted.

import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import {
  rmas,
  seasons,
  seasonalProducts,
  type RmaItemClassification,
} from "../../db/schema/returns.js";
import { QboClient } from "../../integrations/qb/client.js";

export type EligibilityInput = {
  customerId: string;
  qbCustomerId: string;
  seasonId: string;
  proposedItems: Array<{
    lineTotal: string;
    classification: RmaItemClassification;
    // qbItemId + originalInvoiceDocNumber are optional but if both are
    // supplied we can mark the matching invoice line as "being proposed
    // for return" in the per-line PDF breakdown.
    qbItemId?: string | null;
    originalInvoiceDocNumber?: string | null;
  }>;
  excludeRmaId?: string;
};

export type EligibilityInvoiceLine = {
  qbItemId: string;
  description: string;
  quantity: string;
  lineTotal: string;
  // True when this exact line is being proposed for return on the current
  // RMA. Determined by matching qbItemId + invoiceDocNumber against the
  // RMA's items. Always false when proposedItems lacks qbItemId/docNumber.
  isProposed: boolean;
};

export type EligibilityBreakdown = {
  customerSeasonalPurchases: string;
  alreadyReturnedThisSeason: string;
  proposedCurrentSeason: string;
  proposedPriorSeason: string;
  proposedNonSeasonal: string;
  proposedSubtotalCountingTowardThreshold: string;
  totalReturnsThisSeason: string;
  cumulativeReturnPct: string;
  thresholdPct: string;
  passesThreshold: boolean;
  perInvoice: Array<{
    invoiceDocNumber: string;
    invoiceDate: string;
    amount: string;
    lines: EligibilityInvoiceLine[];
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDecimal(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtDecimal(n: number): string {
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runEligibility(
  input: EligibilityInput,
): Promise<EligibilityBreakdown> {
  const { customerId, qbCustomerId, seasonId, proposedItems, excludeRmaId } =
    input;

  // 1. Read threshold from app_settings (default 50).
  const thresholdRows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "seasonal_threshold_pct"));
  const thresholdPct = thresholdRows[0]
    ? parseDecimal(thresholdRows[0].value)
    : 50;

  // 2. Look up the season to get start/end dates.
  const seasonRows = await db
    .select()
    .from(seasons)
    .where(eq(seasons.id, seasonId));
  const season = seasonRows[0];
  if (!season) {
    throw new Error(`Season not found: ${seasonId}`);
  }
  const seasonStart =
    season.startDate instanceof Date
      ? season.startDate.toISOString().slice(0, 10)
      : String(season.startDate);
  const seasonEnd =
    season.endDate instanceof Date
      ? season.endDate.toISOString().slice(0, 10)
      : String(season.endDate);

  // 3. Load seasonal products for this season → set of qb_item_ids.
  const products = await db
    .select({ qbItemId: seasonalProducts.qbItemId })
    .from(seasonalProducts)
    .where(eq(seasonalProducts.seasonId, seasonId));
  const seasonalItemIds = new Set(products.map((p) => p.qbItemId));

  // 4. Query QBO invoices for the customer; filter by season date window +
  //    seasonal item membership. Aggregate per-invoice totals AND capture
  //    each seasonal line so the eligibility PDF can show what the customer
  //    actually bought (drilled down) vs. just per-invoice rollups.
  type LineCapture = {
    qbItemId: string;
    description: string;
    quantity: number;
    lineTotal: number;
  };
  const perInvoiceMap = new Map<
    string,
    {
      invoiceDocNumber: string;
      invoiceDate: string;
      total: number;
      lines: LineCapture[];
    }
  >();
  let customerSeasonalPurchases = 0;

  if (seasonalItemIds.size > 0) {
    const qbo = new QboClient();
    const invoices = await qbo.findInvoicesForCustomer(qbCustomerId);

    for (const inv of invoices) {
      const txnDate = inv.TxnDate ?? "";
      if (!txnDate || txnDate < seasonStart || txnDate > seasonEnd) continue;
      if (!inv.Line || inv.Line.length === 0) continue;

      let invSeasonalTotal = 0;
      const invLines: LineCapture[] = [];
      for (const line of inv.Line) {
        if (line.DetailType !== "SalesItemLineDetail") continue;
        const itemId = line.SalesItemLineDetail?.ItemRef?.value;
        if (!itemId || !seasonalItemIds.has(itemId)) continue;
        const amount = parseDecimal(line.Amount);
        invSeasonalTotal += amount;
        invLines.push({
          qbItemId: itemId,
          description: line.Description ?? "",
          quantity: parseDecimal(line.SalesItemLineDetail?.Qty ?? null),
          lineTotal: amount,
        });
      }
      if (invSeasonalTotal === 0) continue;

      const docNum = inv.DocNumber ?? inv.Id;
      const existing = perInvoiceMap.get(docNum);
      if (existing) {
        existing.total += invSeasonalTotal;
        existing.lines.push(...invLines);
      } else {
        perInvoiceMap.set(docNum, {
          invoiceDocNumber: docNum,
          invoiceDate: txnDate,
          total: invSeasonalTotal,
          lines: invLines,
        });
      }
      customerSeasonalPurchases += invSeasonalTotal;
    }
  }

  // Build a lookup of (docNumber, qbItemId) → "is being proposed for return"
  // from the proposed items. Used to highlight matching lines in the per-
  // invoice breakdown. Only items with both fields populated count.
  const proposedKeySet = new Set<string>();
  for (const p of proposedItems) {
    if (!p.qbItemId || !p.originalInvoiceDocNumber) continue;
    proposedKeySet.add(`${p.originalInvoiceDocNumber}::${p.qbItemId}`);
  }

  const perInvoice = Array.from(perInvoiceMap.values())
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate))
    .map((r) => ({
      invoiceDocNumber: r.invoiceDocNumber,
      invoiceDate: r.invoiceDate,
      amount: fmtDecimal(r.total),
      lines: r.lines.map((l) => ({
        qbItemId: l.qbItemId,
        description: l.description,
        quantity: fmtDecimal(l.quantity),
        lineTotal: fmtDecimal(l.lineTotal),
        isProposed: proposedKeySet.has(
          `${r.invoiceDocNumber}::${l.qbItemId}`,
        ),
      })),
    }));

  // 5. Sum eligible_amount (or total_value) from approved+ RMAs for this
  //    customer × season — excluding the current draft if excludeRmaId given.
  // Use the typed RMA_STATUSES enum values directly so Drizzle's inArray
  // overload resolves to the enum-typed column variant (not the string[] overload).
  const approvedStatuses: Array<
    | "approved"
    | "awaiting_warehouse_number"
    | "sent_to_warehouse"
    | "received"
    | "completed"
  > = [
    "approved",
    "awaiting_warehouse_number",
    "sent_to_warehouse",
    "received",
    "completed",
  ];

  const baseConditions = [
    eq(rmas.customerId, customerId),
    eq(rmas.seasonId, seasonId),
    inArray(rmas.status, approvedStatuses),
  ];
  if (excludeRmaId) {
    baseConditions.push(ne(rmas.id, excludeRmaId));
  }

  const existingRmaRows = await db
    .select({
      totalValue: rmas.totalValue,
      eligibleAmount: rmas.eligibleAmount,
    })
    .from(rmas)
    .where(and(...baseConditions));

  let alreadyReturnedThisSeason = 0;
  for (const row of existingRmaRows) {
    const amount = row.eligibleAmount ?? row.totalValue;
    alreadyReturnedThisSeason += parseDecimal(amount);
  }

  // 6. Sum proposed items by classification.
  let proposedCurrentSeason = 0;
  let proposedPriorSeason = 0;
  let proposedNonSeasonal = 0;

  for (const item of proposedItems) {
    const amt = parseDecimal(item.lineTotal);
    switch (item.classification) {
      case "seasonal_current":
        proposedCurrentSeason += amt;
        break;
      case "seasonal_prior":
        proposedPriorSeason += amt;
        break;
      case "non_seasonal":
      case "damage":
        proposedNonSeasonal += amt;
        break;
    }
  }

  const proposedSubtotalCountingTowardThreshold =
    proposedCurrentSeason + proposedPriorSeason;
  const totalReturnsThisSeason =
    alreadyReturnedThisSeason + proposedSubtotalCountingTowardThreshold;

  // 7. Compute cumulative %.
  let cumulativeReturnPct = 0;
  if (customerSeasonalPurchases > 0) {
    cumulativeReturnPct =
      (totalReturnsThisSeason / customerSeasonalPurchases) * 100;
  }

  // 8. Threshold check.
  const passesThreshold = cumulativeReturnPct <= thresholdPct;

  return {
    customerSeasonalPurchases: fmtDecimal(customerSeasonalPurchases),
    alreadyReturnedThisSeason: fmtDecimal(alreadyReturnedThisSeason),
    proposedCurrentSeason: fmtDecimal(proposedCurrentSeason),
    proposedPriorSeason: fmtDecimal(proposedPriorSeason),
    proposedNonSeasonal: fmtDecimal(proposedNonSeasonal),
    proposedSubtotalCountingTowardThreshold: fmtDecimal(
      proposedSubtotalCountingTowardThreshold,
    ),
    totalReturnsThisSeason: fmtDecimal(totalReturnsThisSeason),
    cumulativeReturnPct: fmtDecimal(cumulativeReturnPct),
    thresholdPct: fmtDecimal(thresholdPct),
    passesThreshold,
    perInvoice,
  };
}
