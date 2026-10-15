// Returns / RMA report (Feldart AI task N) for a date range, filtered on
// the RMA's created date. Two views: one row per RMA, or one row per
// returned line. Drafts are excluded — they're unsent work-in-progress.
// Reads the RMA tables only (no invoice_lines), so the sku/name sync
// swap doesn't touch it.

import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { rmaItems, rmas } from "../../db/schema/returns.js";
import {
  dayOf,
  isoDay,
  money,
  num,
  shapeRows,
  sumKeys,
  usd,
  type DateLike,
  type ReportRow,
  type ReportColumn,
  type ReportTable,
} from "./table.js";

export type ReturnsView = "rmas" | "lines";

export type ReturnsRmaInput = {
  id: string;
  rmaNumber: string | null;
  customerName: string;
  status: string;
  returnType: string;
  resolutionType: string | null;
  totalValue: string | number;
  creditMemoDocNumber: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type ReturnsLineInput = {
  rmaId: string;
  sku: string;
  name: string;
  quantity: string | number;
  receivedQuantity: string | number | null;
  unitPrice: string | number;
  lineTotal: string | number;
  classification: string;
  reason: string | null;
  originalInvoiceDocNumber: string | null;
  originalInvoiceDate: DateLike;
};

const STATUS_LABEL: Record<string, string> = {
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting warehouse no.",
  sent_to_warehouse: "Sent to warehouse",
  received: "Received",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
};
const TYPE_LABEL: Record<string, string> = {
  damage: "Damage",
  seasonal: "Seasonal",
  non_seasonal: "Non-seasonal",
};
const CLASS_LABEL: Record<string, string> = {
  seasonal_current: "Seasonal (current)",
  seasonal_prior: "Seasonal (prior)",
  non_seasonal: "Non-seasonal",
  damage: "Damage",
};
const label = (map: Record<string, string>, v: string | null): string | null =>
  v === null ? null : (map[v] ?? v);

export const RETURNS_RMA_COLUMNS: ReportColumn[] = [
  { key: "rma", label: "RMA", type: "text" },
  { key: "customer", label: "Customer", type: "text" },
  { key: "created", label: "Created", type: "date" },
  { key: "status", label: "Status", type: "text" },
  { key: "type", label: "Return type", type: "text" },
  { key: "resolution", label: "Resolution", type: "text" },
  { key: "lines", label: "Lines", type: "number" },
  { key: "qty", label: "Units", type: "number" },
  usd("value", "Return value"),
  { key: "creditMemo", label: "Credit memo", type: "text" },
  { key: "completed", label: "Completed", type: "date" },
  { key: "url", label: "Finance link", type: "url" },
];

export const RETURNS_LINE_COLUMNS: ReportColumn[] = [
  { key: "rma", label: "RMA", type: "text" },
  { key: "customer", label: "Customer", type: "text" },
  { key: "created", label: "Created", type: "date" },
  { key: "status", label: "Status", type: "text" },
  { key: "sku", label: "SKU", type: "text" },
  { key: "name", label: "Product", type: "text" },
  { key: "qty", label: "Qty", type: "number" },
  { key: "received", label: "Received qty", type: "number" },
  usd("unitPrice", "Unit price"),
  usd("lineTotal", "Line total"),
  { key: "classification", label: "Classification", type: "text" },
  { key: "reason", label: "Reason", type: "text" },
  { key: "invoice", label: "Original invoice", type: "text" },
  { key: "invoiceDate", label: "Invoice date", type: "date" },
  { key: "url", label: "Finance link", type: "url" },
];

export function buildReturnsReport(input: {
  view: ReturnsView;
  from: string;
  to: string;
  customerName: string | null;
  rmas: ReturnsRmaInput[];
  lines: ReturnsLineInput[];
  now: Date;
  rmaUrl: (id: string) => string;
}): ReportTable {
  const linesByRma = new Map<string, ReturnsLineInput[]>();
  for (const l of input.lines) {
    const list = linesByRma.get(l.rmaId) ?? [];
    list.push(l);
    linesByRma.set(l.rmaId, list);
  }
  // null (not a placeholder) when the warehouse number isn't set yet: the
  // hub joins these rows to inbox return requests on this key.
  const rmaRef = (r: ReturnsRmaInput) => r.rmaNumber;

  let columns: ReportColumn[];
  let records: ReportRow[];
  let totalKeys: string[];
  if (input.view === "rmas") {
    columns = RETURNS_RMA_COLUMNS;
    totalKeys = ["lines", "qty", "value"];
    records = input.rmas.map((r) => {
      const lines = linesByRma.get(r.id) ?? [];
      return {
        rma: rmaRef(r),
        customer: r.customerName,
        created: isoDay(r.createdAt),
        status: label(STATUS_LABEL, r.status),
        type: label(TYPE_LABEL, r.returnType),
        resolution: r.resolutionType === null ? null : r.resolutionType === "credit" ? "Credit" : "Replacement",
        lines: lines.length,
        qty: lines.reduce((s, l) => s + num(l.quantity), 0),
        value: money(num(r.totalValue)),
        creditMemo: r.creditMemoDocNumber,
        completed: r.completedAt ? isoDay(r.completedAt) : null,
        url: input.rmaUrl(r.id),
      };
    });
  } else {
    columns = RETURNS_LINE_COLUMNS;
    totalKeys = ["qty", "received", "lineTotal"];
    records = input.rmas.flatMap((r) =>
      (linesByRma.get(r.id) ?? []).map((l) => ({
        rma: rmaRef(r),
        customer: r.customerName,
        created: isoDay(r.createdAt),
        status: label(STATUS_LABEL, r.status),
        sku: l.sku,
        name: l.name,
        qty: num(l.quantity),
        received: l.receivedQuantity === null ? null : num(l.receivedQuantity),
        unitPrice: money(num(l.unitPrice)),
        lineTotal: money(num(l.lineTotal)),
        classification: label(CLASS_LABEL, l.classification),
        reason: l.reason,
        invoice: l.originalInvoiceDocNumber,
        invoiceDate: dayOf(l.originalInvoiceDate),
        url: input.rmaUrl(r.id),
      })),
    );
  }

  const rows = shapeRows(columns, records);
  const who = input.customerName ? ` — ${input.customerName}` : "";
  return {
    title: `Returns ${input.from} to ${input.to}${who}`,
    asOf: input.now.toISOString(),
    columns,
    rows,
    totals: sumKeys(rows, totalKeys),
    warnings: rows.length === 0 ? ["No returns in this date range."] : [],
  };
}

/** "YYYY-MM-DD" → UTC midnight; the `to` bound is inclusive (next day exclusive). */
export function dateRangeBounds(from: string, to: string): { start: Date; endExclusive: Date } {
  const start = new Date(`${from}T00:00:00Z`);
  const endExclusive = new Date(`${to}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { start, endExclusive };
}

export async function loadReturnsReport(input: {
  view: ReturnsView;
  from: string;
  to: string;
  customerId?: string;
  now: Date;
  rmaUrl: (id: string) => string;
}): Promise<ReportTable> {
  const { start, endExclusive } = dateRangeBounds(input.from, input.to);
  const conds = [
    gte(rmas.createdAt, start),
    lt(rmas.createdAt, endExclusive),
    ne(rmas.status, "draft"),
  ];
  if (input.customerId) conds.push(eq(rmas.customerId, input.customerId));

  const rmaRows = await db
    .select({
      id: rmas.id,
      rmaNumber: rmas.rmaNumber,
      customerName: customers.displayName,
      status: rmas.status,
      returnType: rmas.returnType,
      resolutionType: rmas.resolutionType,
      totalValue: rmas.totalValue,
      creditMemoDocNumber: rmas.creditMemoDocNumber,
      createdAt: rmas.createdAt,
      completedAt: rmas.completedAt,
    })
    .from(rmas)
    .innerJoin(customers, eq(customers.id, rmas.customerId))
    .where(and(...conds))
    .orderBy(asc(rmas.createdAt));

  const lineRows =
    rmaRows.length === 0
      ? []
      : await db
          .select({
            rmaId: rmaItems.rmaId,
            sku: rmaItems.sku,
            name: rmaItems.name,
            quantity: rmaItems.quantity,
            receivedQuantity: rmaItems.receivedQuantity,
            unitPrice: rmaItems.unitPrice,
            lineTotal: rmaItems.lineTotal,
            classification: rmaItems.classification,
            reason: rmaItems.reason,
            originalInvoiceDocNumber: rmaItems.originalInvoiceDocNumber,
            originalInvoiceDate: rmaItems.originalInvoiceDate,
          })
          .from(rmaItems)
          .where(inArray(rmaItems.rmaId, rmaRows.map((r) => r.id)))
          .orderBy(asc(rmaItems.position));

  return buildReturnsReport({
    view: input.view,
    from: input.from,
    to: input.to,
    customerName: input.customerId ? (rmaRows[0]?.customerName ?? null) : null,
    rmas: rmaRows,
    lines: lineRows,
    now: input.now,
    rmaUrl: input.rmaUrl,
  });
}
