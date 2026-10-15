// Sales reports from QBO invoice lines (Feldart AI tasks M + D, operator
// go 2026-10-15). Both rely on the 2026-10-15 sync fix: invoice_lines.sku
// is the real code and sku_source NULL marks a legacy line (title in sku)
// that is left out and counted in a warning rather than guessed.
// Invoices dated after today are QBO placeholders and never count as sales.

import { and, asc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { invoiceLines, invoices } from "../../db/schema/invoices.js";
import { seasonalProducts, seasons } from "../../db/schema/returns.js";
import { booksFor, type Book, type BookScope } from "./aged-debtors.js";
import { ReportNotFoundError } from "./open-invoices.js";
import {
  dayOf,
  isoDay,
  money,
  num,
  shapeRows,
  sumKeys,
  usd,
  type DateLike,
  type ReportColumn,
  type ReportRow,
  type ReportTable,
} from "./table.js";

const BOOK_LABEL: Record<Book, string> = { feldart: "Feldart", tj: "Torah Judaica" };

// ---------------------------------------------------------------------------
// Customer purchase history (task D)
// ---------------------------------------------------------------------------

export type HistoryLineInput = {
  sku: string | null;
  itemName: string | null;
  description: string | null;
  qty: string | number | null;
  unitPrice: string | number | null;
  lineTotal: string | number | null;
  issueDate: DateLike;
  origin: Book;
};

export type HistoryItem = {
  sku: string | null;
  product: string | null;
  qty: number;
  value: number;
  lines: number;
  lastBought: string | null;
  lastUnitPrice: number | null;
  books: string;
};

/** One entry per SKU (lines without a SKU grouped by product name), biggest value first. */
export function buildCustomerHistory(lines: HistoryLineInput[]): HistoryItem[] {
  type Acc = {
    sku: string | null;
    product: string | null;
    qty: number;
    value: number;
    lines: number;
    lastDate: string | null;
    lastUnitPrice: number | null;
    books: Set<string>;
  };
  const by = new Map<string, Acc>();
  for (const l of lines) {
    const key = l.sku ?? `name:${l.itemName ?? l.description ?? "?"}`;
    const a =
      by.get(key) ??
      { sku: l.sku, product: l.itemName ?? l.description, qty: 0, value: 0, lines: 0, lastDate: null, lastUnitPrice: null, books: new Set<string>() };
    a.qty += num(l.qty);
    a.value += num(l.lineTotal);
    a.lines += 1;
    a.books.add(l.origin);
    const d = dayOf(l.issueDate);
    if (d && (!a.lastDate || d >= a.lastDate)) {
      a.lastDate = d;
      a.lastUnitPrice = l.unitPrice === null ? null : money(num(l.unitPrice));
    }
    by.set(key, a);
  }
  return [...by.values()]
    .sort((x, y) => y.value - x.value)
    .map((a) => ({
      sku: a.sku,
      product: a.product,
      qty: Math.round(a.qty * 1000) / 1000,
      value: money(a.value),
      lines: a.lines,
      lastBought: a.lastDate,
      lastUnitPrice: a.lastUnitPrice,
      books: [...a.books].sort().join("+"),
    }));
}

export const CUSTOMER_HISTORY_COLUMNS: ReportColumn[] = [
  { key: "sku", label: "SKU", type: "text" },
  { key: "product", label: "Product", type: "text" },
  { key: "qty", label: "Units", type: "number" },
  usd("value", "Value"),
  { key: "lines", label: "Invoice lines", type: "number" },
  { key: "lastBought", label: "Last bought", type: "date" },
  usd("lastUnitPrice", "Last unit price"),
  { key: "books", label: "Book", type: "text" },
];

export type SalesLineRow = HistoryLineInput & {
  skuSource: string | null;
  customerId: string;
  qbItemId: string | null;
};

/** Clamp `to` to today: future-dated invoices are QBO placeholders, not sales. */
export function salesWindow(from: string | null, to: string | null, now: Date): { from: string | null; to: string } {
  const today = isoDay(now);
  return { from, to: to && to < today ? to : today };
}

function pendingWarning(pending: number, total: number): string[] {
  return pending > 0
    ? [`${pending} of ${total} invoice lines predate the SKU rebuild (invoices deleted in QuickBooks) and are left out.`]
    : [];
}

export async function loadCustomerHistory(input: {
  customerId: string;
  from?: string;
  to?: string;
  now: Date;
}): Promise<ReportTable> {
  const [c] = await db
    .select({ name: customers.displayName })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  if (!c) throw new ReportNotFoundError("customer not found");
  const win = salesWindow(input.from ?? null, input.to ?? null, input.now);
  const rows = await loadSalesLines({ customerIds: [input.customerId], from: win.from, to: win.to, books: ["feldart", "tj"] });
  const usable = rows.filter((r) => r.skuSource !== null);
  const items = buildCustomerHistory(usable);
  const tableRows = shapeRows(CUSTOMER_HISTORY_COLUMNS, items as unknown as ReportRow[]);
  const warnings = pendingWarning(rows.length - usable.length, rows.length);
  if (rows.length === 0) warnings.push("No invoices for this customer in that range.");
  const range = win.from ? `${win.from} to ${win.to}` : `to ${win.to}`;
  return {
    title: `${c.name} — purchase history ${range}`,
    asOf: input.now.toISOString(),
    columns: CUSTOMER_HISTORY_COLUMNS,
    rows: tableRows,
    totals: sumKeys(tableRows, ["qty", "value", "lines"]),
    warnings,
  };
}

/** Invoice lines joined to their invoice, for non-void invoices dated in the window. */
async function loadSalesLines(input: {
  customerIds?: string[];
  qbItemIds?: string[];
  skus?: string[];
  from: string | null;
  to: string;
  books: Book[];
}): Promise<SalesLineRow[]> {
  const conds = [
    ne(invoices.status, "void"),
    isNotNull(invoices.issueDate),
    lte(invoices.issueDate, new Date(`${input.to}T00:00:00Z`)),
    inArray(invoices.origin, input.books),
  ];
  if (input.from) conds.push(gte(invoices.issueDate, new Date(`${input.from}T00:00:00Z`)));
  if (input.customerIds) conds.push(inArray(invoices.customerId, input.customerIds));
  const productMatch = [];
  if (input.qbItemIds && input.qbItemIds.length > 0) productMatch.push(inArray(invoiceLines.qbItemId, input.qbItemIds));
  if (input.skus && input.skus.length > 0) productMatch.push(inArray(invoiceLines.sku, input.skus));
  if (input.qbItemIds || input.skus) {
    if (productMatch.length === 0) return [];
    conds.push(productMatch.length === 1 ? productMatch[0]! : or(...productMatch)!);
  }
  return db
    .select({
      sku: invoiceLines.sku,
      itemName: invoiceLines.itemName,
      description: invoiceLines.description,
      qty: invoiceLines.qty,
      unitPrice: invoiceLines.unitPrice,
      lineTotal: invoiceLines.lineTotal,
      skuSource: invoiceLines.skuSource,
      qbItemId: invoiceLines.qbItemId,
      issueDate: invoices.issueDate,
      origin: invoices.origin,
      customerId: invoices.customerId,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(...conds));
}

// ---------------------------------------------------------------------------
// Season sales (task M)
// ---------------------------------------------------------------------------

export type SeasonOption = { id: string; name: string; startDate: string | null; endDate: string | null; products: number };

export async function listSeasons(): Promise<SeasonOption[]> {
  const rows = await db
    .select({
      id: seasons.id,
      name: seasons.name,
      startDate: seasons.startDate,
      endDate: seasons.endDate,
      products: sql<number>`COUNT(${seasonalProducts.id})`,
    })
    .from(seasons)
    .leftJoin(seasonalProducts, eq(seasonalProducts.seasonId, seasons.id))
    .groupBy(seasons.id)
    .orderBy(asc(seasons.startDate));
  return rows
    .map((r) => ({ ...r, startDate: dayOf(r.startDate), endDate: dayOf(r.endDate), products: Number(r.products) }))
    .reverse();
}

export type SeasonView = "skus" | "customers" | "lines";

export const SEASON_SKU_COLUMNS: ReportColumn[] = [
  { key: "sku", label: "SKU", type: "text" },
  { key: "product", label: "Product", type: "text" },
  { key: "qty", label: "Units", type: "number" },
  usd("value", "Value"),
  { key: "customers", label: "Stores", type: "number" },
  { key: "lines", label: "Invoice lines", type: "number" },
];
export const SEASON_CUSTOMER_COLUMNS: ReportColumn[] = [
  { key: "customer", label: "Store", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "qty", label: "Units", type: "number" },
  usd("value", "Value"),
  { key: "skus", label: "Season SKUs bought", type: "number" },
  { key: "url", label: "Finance link", type: "url" },
];
export const SEASON_LINE_COLUMNS: ReportColumn[] = [
  { key: "customer", label: "Store", type: "text" },
  { key: "sku", label: "SKU", type: "text" },
  { key: "product", label: "Product", type: "text" },
  { key: "qty", label: "Units", type: "number" },
  usd("value", "Value"),
  { key: "lastBought", label: "Last bought", type: "date" },
];

export function buildSeasonSales(input: {
  seasonName: string;
  from: string;
  to: string;
  view: SeasonView;
  books: Book[];
  lines: SalesLineRow[];
  productNames: Map<string, string>; // sku → season product name
  customers: Map<string, { name: string; email: string | null }>;
  now: Date;
  customerUrl: (id: string) => string;
}): ReportTable {
  const usable = input.lines.filter((l) => l.skuSource !== null && l.sku);
  const name = (sku: string, fallback: string | null) => input.productNames.get(sku) ?? fallback;
  const cust = (id: string) => input.customers.get(id) ?? { name: id, email: null };

  let columns: ReportColumn[];
  let rows: ReportRow[];
  if (input.view === "skus") {
    columns = SEASON_SKU_COLUMNS;
    const by = new Map<string, { product: string | null; qty: number; value: number; customers: Set<string>; lines: number }>();
    for (const l of usable) {
      const a = by.get(l.sku!) ?? { product: name(l.sku!, l.itemName), qty: 0, value: 0, customers: new Set<string>(), lines: 0 };
      a.qty += num(l.qty);
      a.value += num(l.lineTotal);
      a.customers.add(l.customerId);
      a.lines += 1;
      by.set(l.sku!, a);
    }
    rows = [...by.entries()]
      .map(([sku, a]) => ({ sku, product: a.product, qty: a.qty, value: money(a.value), customers: a.customers.size, lines: a.lines }))
      .sort((x, y) => y.value - x.value);
  } else if (input.view === "customers") {
    columns = SEASON_CUSTOMER_COLUMNS;
    const by = new Map<string, { qty: number; value: number; skus: Set<string> }>();
    for (const l of usable) {
      const a = by.get(l.customerId) ?? { qty: 0, value: 0, skus: new Set<string>() };
      a.qty += num(l.qty);
      a.value += num(l.lineTotal);
      a.skus.add(l.sku!);
      by.set(l.customerId, a);
    }
    rows = [...by.entries()]
      .map(([id, a]) => ({ customer: cust(id).name, email: cust(id).email, qty: a.qty, value: money(a.value), skus: a.skus.size, url: input.customerUrl(id) }))
      .sort((x, y) => y.value - x.value);
  } else {
    columns = SEASON_LINE_COLUMNS;
    const by = new Map<string, { customerId: string; sku: string; product: string | null; qty: number; value: number; last: string | null }>();
    for (const l of usable) {
      const k = `${l.customerId}|${l.sku}`;
      const a = by.get(k) ?? { customerId: l.customerId, sku: l.sku!, product: name(l.sku!, l.itemName), qty: 0, value: 0, last: null };
      a.qty += num(l.qty);
      a.value += num(l.lineTotal);
      const d = dayOf(l.issueDate);
      if (d && (!a.last || d > a.last)) a.last = d;
      by.set(k, a);
    }
    rows = [...by.values()]
      .map((a) => ({ customer: cust(a.customerId).name, sku: a.sku, product: a.product, qty: a.qty, value: money(a.value), lastBought: a.last }))
      .sort((x, y) => String(x.customer).localeCompare(String(y.customer)) || y.value - x.value);
  }

  const shaped = shapeRows(columns, rows);
  const warnings = pendingWarning(input.lines.length - usable.length, input.lines.length);
  if (shaped.length === 0) warnings.push("No sales of this season's products in that window.");
  const scope = input.books.length === 2 ? "" : ` (${BOOK_LABEL[input.books[0]!]})`;
  return {
    title: `${input.seasonName} sales ${input.from} to ${input.to}${scope}`,
    asOf: input.now.toISOString(),
    columns,
    rows: shaped,
    totals: sumKeys(shaped, input.view === "skus" ? ["qty", "value", "lines"] : ["qty", "value"]),
    warnings,
  };
}

export async function loadSeasonSales(input: {
  seasonId: string;
  from?: string;
  to?: string;
  view: SeasonView;
  book: BookScope;
  now: Date;
  customerUrl: (id: string) => string;
}): Promise<ReportTable> {
  const [season] = await db
    .select({ name: seasons.name, startDate: seasons.startDate, endDate: seasons.endDate })
    .from(seasons)
    .where(eq(seasons.id, input.seasonId))
    .limit(1);
  if (!season) throw new ReportNotFoundError("season not found");
  const products = await db
    .select({ qbItemId: seasonalProducts.qbItemId, sku: seasonalProducts.sku, name: seasonalProducts.name })
    .from(seasonalProducts)
    .where(eq(seasonalProducts.seasonId, input.seasonId));

  const win = salesWindow(input.from ?? dayOf(season.startDate), input.to ?? dayOf(season.endDate), input.now);
  const from = win.from ?? win.to;
  const books = booksFor(input.book);
  // Match on the QBO item (exact) or the SKU (covers lines whose item was
  // re-created in QBO); the season list stores both.
  const lines = await loadSalesLines({
    qbItemIds: products.map((p) => p.qbItemId),
    skus: products.map((p) => p.sku),
    from,
    to: win.to,
    books,
  });
  const customerIds = [...new Set(lines.map((l) => l.customerId))];
  const custRows =
    customerIds.length === 0
      ? []
      : await db
          .select({ id: customers.id, name: customers.displayName, email: customers.primaryEmail })
          .from(customers)
          .where(inArray(customers.id, customerIds));

  return buildSeasonSales({
    seasonName: season.name,
    from,
    to: win.to,
    view: input.view,
    books,
    lines,
    productNames: new Map(products.map((p) => [p.sku, p.name])),
    customers: new Map(custRows.map((c) => [c.id, { name: c.name, email: c.email }])),
    now: input.now,
    customerUrl: input.customerUrl,
  });
}
