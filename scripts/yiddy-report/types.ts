// Shared shapes for the yiddy-roster report pipeline.
// gather (VPS) → GatheredData JSON → compute → ReportData JSON → render.

export type GatheredDoc = {
  // "inv" rows come from the local invoices table; "sr" rows from the
  // QBO SalesReceipt API. Merged everywhere downstream.
  kind: "inv" | "sr";
  docNumber: string | null;
  date: string; // ISO YYYY-MM-DD
  total: number;
  // invoices: balance>0 && status not paid/void ⇒ open. SRs: always paid.
  open: boolean;
  openBalance: number;
  origin: "feldart" | "tj";
  status: string;
  lines: Array<{
    sku: string | null;
    name: string | null;
    qty: number;
    lineTotal: number;
  }>;
};

export type GatheredCustomer = {
  id: string;
  displayName: string;
  phone: string | null;
  additionalPhones: Array<{ label: string; number: string }>;
  primaryEmail: string | null;
  contacts: Array<{
    name: string | null;
    email: string | null;
    role: string | null;
    phone: string | null;
  }>;
  paymentTerms: string | null;
  holdStatus: "active" | "hold" | "payment_upfront";
  balance: number;
  overdueBalance: number;
  internalNotes: string | null;
  aiCustomerContext: string | null;
  firstOrderDate: string | null; // lifetime min local-invoice date (SR-only stores fall back in compute)
  lifetimeOrderDates: string[]; // lifetime local-invoice dates, ascending (cadence baseline)
  docs: GatheredDoc[]; // 25-month window, invoices + SRs merged, ascending date
  holdPeriods: Array<{ from: string; to: string | null; reason: string | null }>; // activities hold_on/hold_off
  orderHoldNotes: Array<{ date: string; reason: string | null; note: string | null }>; // shopify order-hold lifecycle
  creditMemos: Array<{ date: string; total: number }>;
};

export type GatheredData = {
  generatedAt: string;
  genDate: string; // YYYY-MM-DD anchoring all windows
  products: Array<{
    sku: string;
    name: string;
    b2bPrice: number | null;
    createdAt: string;
  }>;
  // Products tagged "new july26" in Shopify — the curated definition of
  // "new product" (operator decision 2026-09-01). When non-empty this
  // REPLACES the CreateTime heuristic in compute.
  shopifyNewProducts: Array<{ sku: string; title: string }>;
  customers: GatheredCustomer[];
};

export type TrendBadge = "growing" | "steady" | "declining" | "dormant";

export type StoreReport = {
  id: string;
  name: string;
  // call-sheet
  phones: Array<{ label: string; number: string }>;
  emails: string[];
  contacts: Array<{
    name: string | null;
    role: string | null;
    email: string | null;
    phone: string | null;
  }>;
  paymentTerms: string | null;
  holdStatus: string;
  balance: number;
  overdueBalance: number;
  // headline metrics
  ttmSpend: number;
  priorYearSpend: number;
  yoyPct: number | null; // null when priorYearSpend is 0
  ttmOrders: number;
  priorYearOrders: number;
  daysSinceLastOrder: number | null;
  medianGapDays: number | null;
  trend: TrendBadge;
  seasonFlag: boolean;
  firstOrderDate: string | null;
  bookSplit: { feldart: number; tj: number }; // TTM spend per book
  // chart — priorSpend/priorOrders are the SAME calendar month one year
  // earlier (index-aligned), for the prior-year overlay
  monthly: Array<{
    month: string;
    orders: number;
    spend: number;
    held: boolean;
    priorSpend: number;
    priorOrders: number;
  }>;
  // averages
  aovTtm: number | null;
  aovPriorYear: number | null;
  distinctSkusTtm: number;
  // drill-down
  orders: Array<{
    docNumber: string | null;
    kind: "inv" | "sr";
    date: string;
    total: number;
    origin: string;
    status: string;
  }>; // TTM only, newest first
  openInvoiceTotal: number;
  topProducts: Array<{ sku: string; name: string | null; value: number }>;
  newProductsTaken: Array<{ sku: string; name: string }>;
  newProductsNotTaken: Array<{ sku: string; name: string }>;
  popularGaps: Array<{ sku: string; name: string; storesBuying: number }>;
  returns: { count: number; value: number };
  holdPeriods: Array<{ from: string; to: string | null; reason: string | null }>;
  note: string | null; // sanitized, injected at render time
};

export type ReportData = {
  genDate: string;
  generatedAt: string;
  rosterCount: number;
  totals: {
    ttmSpend: number;
    priorYearSpend: number;
    ttmOrders: number;
    trendCounts: Record<TrendBadge, number>;
  };
  winBack: Array<{
    id: string;
    name: string;
    priorSpend: number;
    daysSinceLastOrder: number | null;
    trend: TrendBadge;
  }>;
  seasonFlags: Array<{ id: string; name: string; lastYearSeasonSpend: number }>;
  stores: StoreReport[];
};
