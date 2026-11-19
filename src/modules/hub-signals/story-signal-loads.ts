// DB side of the phase-3 signals (builders in finance-signals.ts). Kept
// cheap for GET /signals (polled every 30 min + on demand):
//   1. four small candidate queries run in parallel — customers with
//      overdue invoices, big Shopify orders this week, Feldart invoice
//      totals per customer-day (2 y), and season-SKU lines (only while a
//      season is live and the SKU map is configured);
//   2. ledgers + promise history only for the money customers (overdue
//      candidates, big-order customers, customers already in the feed),
//      customer heads (name, email, country) for everyone in the feed.
// Every step is batched (chunked IN lists), never one query per customer.

import { and, eq, gte, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { invoiceLines, invoices } from "../../db/schema/invoices.js";
import { loadCustomerHeads, loadLedgers, loadPromiseHistory, type CustomerHead } from "../hub-stories/load.js";
import { findSeasonMisses, liveSeasons, seasonIndex, seasonLookbackFrom, type SeasonMiss, type SkuMap } from "../hub-stories/seasons.js";
import { getSkuMap } from "../hub-stories/sku-map.js";
import {
  addDaysYmd,
  buildMoney,
  buildPayBehaviour,
  emptyLedger,
  judgePromises,
  promiseRecordTag,
  STORY_RULES,
  summarisePromises,
  type InvoiceDay,
  type Money,
  type PayBehaviour,
} from "../hub-stories/story.js";
import { todayYmd, toYmd } from "../promises/promise-state.js";
import type { BigOrderFacts, PaySlipFacts, ReorderFacts, SeasonMissFacts, SignalCustomerInfo } from "./finance-signals.js";

const DAY_MS = 86_400_000;
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const toNum = (v: string | number | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const notVoid = (): SQL => or(isNull(invoices.status), ne(invoices.status, "void")) as SQL;

/** Customers with ≥ $50 of overdue (past-due, real-dated) invoices. */
async function loadOverdueCustomerIds(now: Date): Promise<string[]> {
  const today = dayStart(todayYmd(now));
  const rows = await db
    .select({ customerId: invoices.customerId })
    .from(invoices)
    .where(
      and(
        gt(invoices.balance, "0"),
        notVoid(),
        isNotNull(invoices.issueDate),
        lte(invoices.issueDate, today),
        or(lt(invoices.dueDate, today), and(isNull(invoices.dueDate), lt(invoices.issueDate, today))),
      ),
    )
    .groupBy(invoices.customerId)
    .having(sql`SUM(${invoices.balance}) >= 50`);
  return rows.map((r) => r.customerId);
}

type BigOrderRow = { orderId: string; orderNumber: string | null; orderDate: Date; orderTotal: number; customerId: string };

async function loadBigOrders(now: Date): Promise<BigOrderRow[]> {
  const rows = await db
    .select({ id: orders.id, number: orders.orderNumber, orderDate: orders.orderDate, total: orders.total, customerId: orders.customerId })
    .from(orders)
    .where(
      and(
        isNotNull(orders.customerId),
        gte(orders.orderDate, new Date(now.getTime() - 7 * DAY_MS)),
        gte(orders.total, "1000"),
        isNull(orders.cancelledAt),
        or(isNull(orders.status), ne(orders.status, "cancelled")),
      ),
    );
  return rows
    .filter((r) => r.customerId && r.orderDate)
    .map((r) => ({
      orderId: r.id,
      orderNumber: r.number,
      orderDate: r.orderDate instanceof Date ? r.orderDate : new Date(r.orderDate as unknown as string),
      orderTotal: toNum(r.total),
      customerId: r.customerId as string,
    }));
}

/** Feldart invoice totals per customer per day over 2 years (voids and future placeholders out). */
async function loadInvoiceDays(now: Date): Promise<Map<string, InvoiceDay[]>> {
  const today = todayYmd(now);
  const rows = await db
    .select({ customerId: invoices.customerId, day: invoices.issueDate, total: sql<string>`SUM(${invoices.total})` })
    .from(invoices)
    .where(
      and(
        eq(invoices.origin, "feldart"),
        notVoid(),
        gte(invoices.issueDate, dayStart(addDaysYmd(today, -STORY_RULES.lookbackDays))),
        lte(invoices.issueDate, dayStart(today)),
        gt(invoices.total, "0"),
      ),
    )
    .groupBy(invoices.customerId, invoices.issueDate);
  const out = new Map<string, InvoiceDay[]>();
  for (const r of rows) {
    const d = toYmd(r.day);
    if (!d) continue;
    const arr = out.get(r.customerId) ?? [];
    arr.push({ date: d, total: toNum(r.total) });
    out.set(r.customerId, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  // Fewer than 4 invoice days can't make a reorder rhythm — drop early.
  for (const [k, arr] of out) if (arr.length < STORY_RULES.minOrderDays) out.delete(k);
  return out;
}

/** Season misses, or [] when the map is off or no season is live. */
async function loadSeasonMisses(now: Date, getMap: () => Promise<SkuMap | null>): Promise<SeasonMiss[]> {
  const map = await getMap();
  if (!map) return [];
  const today = todayYmd(now);
  const from = seasonLookbackFrom(map, today);
  if (!from) return [];
  const live = new Set(liveSeasons(map, today).map((s) => s.name));
  const skus = Array.from(seasonIndex(map)).filter(([, ss]) => Array.from(ss).some((s) => live.has(s))).map(([k]) => k);
  if (skus.length === 0) return [];
  const parts: Array<Array<{ customerId: string; day: Date | string | null; sku: string | null; description: string | null; itemName: string | null; amount: string | null }>> = [];
  for (let i = 0; i < skus.length; i += 500) {
    const c = skus.slice(i, i + 500);
    parts.push(
      await db
        .select({
          customerId: invoices.customerId,
          day: invoices.issueDate,
          sku: invoiceLines.sku,
          description: sql<string | null>`LEFT(${invoiceLines.description}, 64)`,
          itemName: invoiceLines.itemName,
          amount: invoiceLines.lineTotal,
        })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(
          and(
            eq(invoices.origin, "feldart"),
            notVoid(),
            gte(invoices.issueDate, dayStart(from)),
            lte(invoices.issueDate, dayStart(today)),
            // sku and name columns are swapped on most rows — match any of them.
            or(
              inArray(invoiceLines.sku, c),
              inArray(invoiceLines.itemName, c),
              sql`LEFT(${invoiceLines.description}, 64) IN (${sql.join(c.map((s) => sql`${s}`), sql`, `)})`,
            ),
          ),
        ),
    );
  }
  const purchases = parts.flat().flatMap((r) => {
    const d = toYmd(r.day);
    return d ? [{ customerId: r.customerId, date: d, values: [r.sku, r.description, r.itemName], amount: toNum(r.amount) }] : [];
  });
  return findSeasonMisses(map, purchases, today);
}

export type StorySignalFacts = {
  paySlip: PaySlipFacts[];
  bigOrders: BigOrderFacts[];
  reorder: ReorderFacts[];
  season: SeasonMissFacts[];
  /** Per customer: email + pay/promise tags for every customer we loaded. */
  info: Map<string, SignalCustomerInfo>;
};

export async function loadStorySignalFacts(opts: {
  now: Date;
  /** Customers already in the feed (resolved by the phase 1–2 loaders). */
  feedCustomerIds: Promise<string[]>;
  fail: (name: string) => (err: unknown) => never[];
  getMap?: () => Promise<SkuMap | null>;
}): Promise<StorySignalFacts> {
  const { now, fail } = opts;
  const today = todayYmd(now);
  const [overdueIds, big, days, misses, feedIds] = await Promise.all([
    loadOverdueCustomerIds(now).catch(fail("pay-slipping")) as Promise<string[]>,
    loadBigOrders(now).catch(fail("big-order-overdue")) as Promise<BigOrderRow[]>,
    loadInvoiceDays(now).catch((err: unknown) => (fail("reorder-due")(err), new Map<string, InvoiceDay[]>())),
    loadSeasonMisses(now, opts.getMap ?? getSkuMap).catch(fail("season-missed")) as Promise<SeasonMiss[]>,
    opts.feedCustomerIds.catch(() => [] as string[]),
  ]);

  const moneyIds = Array.from(new Set([...overdueIds, ...big.map((b) => b.customerId), ...feedIds]));
  const headIds = Array.from(new Set([...moneyIds, ...days.keys(), ...misses.map((m) => m.customerId)]));

  const [ledgersRes, promisesRes, headsRes] = await Promise.allSettled([
    loadLedgers(moneyIds, now),
    loadPromiseHistory(moneyIds, now),
    loadCustomerHeads(headIds),
  ]);
  const out: StorySignalFacts = { paySlip: [], bigOrders: [], reorder: [], season: [], info: new Map() };
  if (headsRes.status === "rejected") {
    // Without names nothing new can be built; the phase 1–2 signals still go out.
    for (const n of ["pay-slipping", "big-order-overdue", "reorder-due", "season-missed"]) fail(n)(headsRes.reason);
    return out;
  }
  const heads = headsRes.value;
  const ledgers = ledgersRes.status === "fulfilled" ? ledgersRes.value : null;
  const promises = promisesRes.status === "fulfilled" ? promisesRes.value : null;
  if (!ledgers) {
    fail("pay-slipping")(ledgersRes.status === "rejected" ? ledgersRes.reason : null);
    fail("big-order-overdue")(ledgersRes.status === "rejected" ? ledgersRes.reason : null);
  }
  if (!promises && promisesRes.status === "rejected") fail("story-promises")(promisesRes.reason);

  const money = new Map<string, Money>();
  const pay = new Map<string, PayBehaviour>();
  for (const id of moneyIds) {
    const h = heads.get(id);
    if (!h || !ledgers) continue;
    const l = ledgers.get(id) ?? emptyLedger();
    const m = buildMoney(l, h.balance, today);
    const p = buildPayBehaviour(l, today, m.oldestOverdueAgeDays);
    money.set(id, m);
    pay.set(id, p);
    const record = promises ? promiseRecordTag(summarisePromises(judgePromises(promises.get(id) ?? [], l, today))) : null;
    out.info.set(id, { email: h.emails[0] ?? null, payUsualDays: p.usualDaysToPay, promiseRecord: record });
  }
  for (const h of heads.values()) if (!out.info.has(h.id)) out.info.set(h.id, { email: h.emails[0] ?? null });

  const overdueSet = new Set(overdueIds);
  for (const id of overdueSet) {
    const h = heads.get(id);
    const m = money.get(id);
    const p = pay.get(id);
    if (h && m && p) out.paySlip.push({ customerId: id, customerName: h.name, money: m, pay: p, promisedPayBy: h.promisedPayBy });
  }
  for (const b of big) {
    const h = heads.get(b.customerId);
    const m = money.get(b.customerId);
    if (h && m) out.bigOrders.push({ ...b, customerName: h.name, money: m });
  }
  for (const [id, d] of days) {
    const h: CustomerHead | undefined = heads.get(id);
    if (h) out.reorder.push({ customerId: id, customerName: h.name, country: h.country, customerType: h.customerType, holdStatus: h.holdStatus, days: d });
  }
  for (const m of misses) {
    const h = heads.get(m.customerId);
    // Same rule as reorder-due: a customer on hold can't order anyway.
    if (h && h.holdStatus !== "hold" && h.customerType !== "b2c") out.season.push({ ...m, customerName: h.name });
  }
  return out;
}
