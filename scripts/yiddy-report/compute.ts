// Crunches gathered.json → report-data.json + notes-input.json.
// Usage: npx tsx scripts/yiddy-report/compute.ts [--gen-date YYYY-MM-DD]
import { readFileSync, writeFileSync } from "node:fs";
import type { GatheredData, ReportData, StoreReport } from "./types";
import {
  bucketMonthly,
  bucketByMonths,
  windowTotals,
  ttmMonths,
  priorYearMonths,
  monthOf,
  medianGapDays,
  daysBetween,
  trendBadge,
  seasonFlag,
  spendInDayWindow,
  newProducts,
  purchasedSkus,
  popularGaps,
  topProducts,
} from "./metrics";

const OUT = "scripts/yiddy-report-out";
const data: GatheredData = JSON.parse(
  readFileSync(`${OUT}/gathered.json`, "utf8"),
);
const genDateArgIdx = process.argv.indexOf("--gen-date");
const genDate =
  genDateArgIdx >= 0 ? process.argv[genDateArgIdx + 1]! : data.genDate;

const ttm = ttmMonths(genDate);
const prior = priorYearMonths(genDate);
const ttmSet = new Set(ttm);
const skuNames = new Map(data.products.map((p) => [p.sku, p.name]));
// "New products" = the curated Shopify "new july26" tag when present
// (operator decision 2026-09-01); CreateTime heuristic only as fallback.
const fresh =
  data.shopifyNewProducts && data.shopifyNewProducts.length > 0
    ? [
        ...new Map(
          data.shopifyNewProducts.map((p) => [
            p.sku,
            { sku: p.sku, name: skuNames.get(p.sku) ?? p.title },
          ]),
        ).values(),
      ]
    : newProducts(data.products, genDate);

// breadth base: what every roster store bought across the whole window
const purchasedByStore = new Map(
  data.customers.map((c) => [c.id, purchasedSkus(c.docs)]),
);

const stores: StoreReport[] = data.customers.map((c) => {
  const ttmDocs = c.docs.filter((d) => ttmSet.has(monthOf(d.date)));
  const t = windowTotals(c.docs, ttm);
  const p = windowTotals(c.docs, prior);
  // cadence: lifetime invoice dates; SR-only stores fall back to the
  // windowed docs (documented caveat — 25-month view, not lifetime).
  // Future-dated docs (QBO placeholder invoices parked on e.g.
  // 2030-01-01) are excluded — they corrupt last-order and cadence.
  const lifetimePast = c.lifetimeOrderDates.filter((d) => d <= genDate);
  const docsPastDates = c.docs.map((d) => d.date).filter((d) => d <= genDate);
  const cadenceDates =
    lifetimePast.length >= 3 ? lifetimePast : docsPastDates;
  const gap = medianGapDays(cadenceDates);
  const allDates = [...new Set([...lifetimePast, ...docsPastDates])].sort();
  const last = allDates.length > 0 ? allDates[allDates.length - 1]! : null;
  const dsl = last ? daysBetween(last, genDate) : null;
  const trend = trendBadge({
    t90Spend: spendInDayWindow(c.docs, genDate, 0, 90),
    prior90Spend: spendInDayWindow(c.docs, genDate, 90, 180),
    daysSinceLastOrder: dsl,
    medianGap: gap,
  });
  const season = seasonFlag(c.docs, genDate);
  const priorMonthly = bucketByMonths(c.docs, prior);
  const monthly = bucketMonthly(c.docs, genDate).map((m, i) => ({
    ...m,
    held: c.holdPeriods.some(
      (h) =>
        monthOf(h.from) <= m.month && (h.to === null || monthOf(h.to) >= m.month),
    ),
    priorSpend: priorMonthly[i]?.spend ?? 0,
    priorOrders: priorMonthly[i]?.orders ?? 0,
  }));
  const own = purchasedByStore.get(c.id) ?? new Set<string>();
  const cmTtm = c.creditMemos.filter((m) => ttmSet.has(monthOf(m.date)));
  return {
    id: c.id,
    name: c.displayName,
    phones: [
      ...(c.phone ? [{ label: "Main", number: c.phone }] : []),
      ...c.additionalPhones,
    ],
    emails: [
      ...new Set(
        [c.primaryEmail, ...c.contacts.map((x) => x.email)].filter(
          (e): e is string => !!e,
        ),
      ),
    ],
    contacts: c.contacts,
    paymentTerms: c.paymentTerms,
    holdStatus: c.holdStatus,
    balance: c.balance,
    overdueBalance: c.overdueBalance,
    ttmSpend: t.spend,
    priorYearSpend: p.spend,
    yoyPct:
      p.spend > 0 ? Math.round(((t.spend - p.spend) / p.spend) * 100) : null,
    ttmOrders: t.orders,
    priorYearOrders: p.orders,
    daysSinceLastOrder: dsl,
    medianGapDays: gap,
    trend,
    seasonFlag: season.flagged,
    firstOrderDate: c.firstOrderDate ?? c.docs[0]?.date ?? null,
    bookSplit: {
      feldart: ttmDocs
        .filter((d) => d.origin === "feldart")
        .reduce((a, d) => a + d.total, 0),
      tj: ttmDocs
        .filter((d) => d.origin === "tj")
        .reduce((a, d) => a + d.total, 0),
    },
    monthly,
    aovTtm: t.orders > 0 ? t.spend / t.orders : null,
    aovPriorYear: p.orders > 0 ? p.spend / p.orders : null,
    distinctSkusTtm: purchasedSkus(ttmDocs).size,
    orders: ttmDocs
      .map((d) => ({
        docNumber: d.docNumber,
        kind: d.kind,
        date: d.date,
        total: d.total,
        origin: d.origin,
        status: d.status,
      }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    openInvoiceTotal: ttmDocs.reduce((a, d) => a + d.openBalance, 0),
    // Line descriptions are often just the SKU — prefer the catalog name.
    topProducts: topProducts(ttmDocs).map((tp) => ({
      ...tp,
      name: skuNames.get(tp.sku) ?? tp.name ?? tp.sku,
    })),
    newProductsTaken: fresh
      .filter((pr) => own.has(pr.sku))
      .map(({ sku, name }) => ({ sku, name })),
    newProductsNotTaken: fresh
      .filter((pr) => !own.has(pr.sku))
      .map(({ sku, name }) => ({ sku, name })),
    popularGaps: popularGaps(c.id, purchasedByStore, skuNames),
    returns: {
      count: cmTtm.length,
      value: cmTtm.reduce((a, m) => a + m.total, 0),
    },
    holdPeriods: c.holdPeriods,
    note: null, // injected at render from reviewed notes
  };
});

const trendCounts = { growing: 0, steady: 0, declining: 0, dormant: 0 };
for (const s of stores) trendCounts[s.trend]++;

const report: ReportData = {
  genDate,
  generatedAt: data.generatedAt,
  rosterCount: stores.length,
  totals: {
    ttmSpend: stores.reduce((a, s) => a + s.ttmSpend, 0),
    priorYearSpend: stores.reduce((a, s) => a + s.priorYearSpend, 0),
    ttmOrders: stores.reduce((a, s) => a + s.ttmOrders, 0),
    trendCounts,
  },
  winBack: stores
    .filter((s) => s.trend === "dormant" || s.trend === "declining")
    .sort((a, b) => b.priorYearSpend - a.priorYearSpend)
    .slice(0, 15)
    .map((s) => ({
      id: s.id,
      name: s.name,
      priorSpend: s.priorYearSpend,
      daysSinceLastOrder: s.daysSinceLastOrder,
      trend: s.trend,
    })),
  seasonFlags: data.customers
    .map((c) => ({ c, f: seasonFlag(c.docs, genDate) }))
    .filter((x) => x.f.flagged)
    .sort((a, b) => b.f.lastYearSeasonSpend - a.f.lastYearSeasonSpend)
    .map((x) => ({
      id: x.c.id,
      name: x.c.displayName,
      lastYearSeasonSpend: x.f.lastYearSeasonSpend,
    })),
  stores: stores.sort((a, b) => b.ttmSpend - a.ttmSpend),
};

writeFileSync(`${OUT}/report-data.json`, JSON.stringify(report));

// notes-input for the sanitization review gate
writeFileSync(
  `${OUT}/notes-input.json`,
  JSON.stringify(
    data.customers
      .filter(
        (c) =>
          c.internalNotes || c.aiCustomerContext || c.orderHoldNotes.length > 0,
      )
      .map((c) => ({
        id: c.id,
        name: c.displayName,
        internalNotes: c.internalNotes,
        aiCustomerContext: c.aiCustomerContext,
        orderHoldNotes: c.orderHoldNotes,
        holdPeriods: c.holdPeriods,
      })),
    null,
    2,
  ),
);
console.log(
  `stores: ${stores.length}; winBack: ${report.winBack.length}; seasonFlags: ${report.seasonFlags.length}; newProducts: ${fresh.length}; trendCounts: ${JSON.stringify(trendCounts)}`,
);
