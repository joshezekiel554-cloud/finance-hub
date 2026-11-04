// Feldart AI ops wave 3 — generic QuickBooks READ access, so the agent can
// answer anything QBO knows without a tool per question (alice's "one
// generic read tool per system", 2026-11-04):
//   qbo_query  — one QBO SQL SELECT (query endpoint is GET-only: can't write)
//   qbo_report — a named QBO report (P&L, balance sheet, aged receivables…)
// Results are trimmed to the 40KB budget with a note. Ops-gated.

import { z } from "zod";
import { QboClient } from "../../integrations/qb/client.js";
import { createLogger } from "../../lib/logger.js";
import { fitRows, parse, RESULT_BUDGET_BYTES, ToolInputError, type ToolDef } from "./finance-tools.js";

const log = createLogger({ component: "ai-tools.qbo" });

export const QBO_MAX_RESULTS = 100;

/** Validate + normalise a model-written QBO query. Throws ToolInputError. */
export function normalizeQboQuery(raw: string): string {
  const q = raw.trim().replace(/\s+/g, " ");
  if (q.length === 0 || q.length > 1500) throw new ToolInputError("query: 1–1500 characters");
  if (!/^select\s/i.test(q)) throw new ToolInputError("query: must be a single SELECT (QuickBooks queries are read-only)");
  if (q.includes(";")) throw new ToolInputError("query: one statement only, no ';'");
  if (/\bcount\s*\(\s*\*\s*\)/i.test(q)) return q;
  const m = q.match(/\bmaxresults\s+(\d+)/i);
  if (m) {
    const n = Math.min(Number(m[1]), QBO_MAX_RESULTS);
    return q.replace(/\bmaxresults\s+\d+/i, `MAXRESULTS ${n}`);
  }
  return `${q} MAXRESULTS 50`;
}

function qboError(err: unknown): string {
  const data = (err as { response?: { data?: unknown } }).response?.data as
    | { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } }
    | undefined;
  const e = data?.Fault?.Error?.[0];
  if (e) return `${e.Message ?? "QuickBooks error"}${e.Detail ? `: ${e.Detail}` : ""}`;
  return err instanceof Error ? err.message : "QuickBooks error";
}

const qboQuery: ToolDef = {
  name: "qbo_query",
  ops: true,
  description:
    "Run ONE read-only QuickBooks Online query (QBO SQL) against the live Feldart company (both books — Feldart and Torah Judaica — are in this one company; TJ invoice numbers start with 2). Use when no finance tool covers the question: bills, vendors, expenses (Purchase), deposits, journal entries, accounts, items, estimates, sales receipts, refunds, any field on invoices/payments/customers. Syntax: SELECT * | SELECT COUNT(*) | SELECT Id, DocNumber FROM <Entity> [WHERE …] [ORDERBY <field> DESC] [STARTPOSITION n] [MAXRESULTS n]. No JOINs, no OR across different fields, strings in single quotes, LIKE '%x%' only on name-ish fields, dates 'YYYY-MM-DD', MetaData.LastUpdatedTime and TxnDate are filterable. Max 100 rows per call (page with STARTPOSITION). Examples: SELECT * FROM Bill WHERE TxnDate >= '2026-10-01' ORDERBY TxnDate DESC; SELECT * FROM Customer WHERE DisplayName LIKE '%Eichler%'; SELECT COUNT(*) FROM Invoice WHERE Balance > '0'.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "One QBO SQL SELECT statement." } },
    required: ["query"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const { query } = parse(z.object({ query: z.string() }), input);
    const q = normalizeQboQuery(query);
    let resp: Record<string, unknown>;
    try {
      resp = await new QboClient().runReadQuery(q);
    } catch (err) {
      log.warn({ err: qboError(err), q }, "qbo_query failed");
      throw new ToolInputError(`QuickBooks rejected the query: ${qboError(err)}`);
    }
    const entity = Object.keys(resp).find((k) => Array.isArray(resp[k]));
    const rows = entity ? (resp[entity] as unknown[]) : [];
    const { rows: kept, note } = fitRows(rows, RESULT_BUDGET_BYTES - 2_000);
    return {
      asOf: ctx.now.toISOString(),
      query: q,
      entity: entity ?? null,
      ...(typeof resp.totalCount === "number" ? { totalCount: resp.totalCount } : {}),
      startPosition: resp.startPosition ?? null,
      returned: rows.length,
      rows: kept,
      warnings: [
        ...(note ? [note.replace(/Ask for a narrower range.*$/, "Select fewer fields or page with STARTPOSITION.")] : []),
        ...(rows.length === QBO_MAX_RESULTS ? [`Hit the ${QBO_MAX_RESULTS}-row cap — there may be more (page with STARTPOSITION).`] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------------------

export const QBO_REPORTS = [
  "ProfitAndLoss",
  "ProfitAndLossDetail",
  "BalanceSheet",
  "CashFlow",
  "AgedReceivables",
  "AgedReceivableDetail",
  "AgedPayables",
  "AgedPayableDetail",
  "CustomerBalance",
  "CustomerBalanceDetail",
  "CustomerIncome",
  "CustomerSales",
  "ItemSales",
  "VendorBalance",
  "VendorExpenses",
  "TransactionList",
  "GeneralLedger",
  "TrialBalance",
  "AccountList",
] as const;

type ReportNode = {
  Header?: { ColData?: Array<{ value?: string }> };
  ColData?: Array<{ value?: string }>;
  Rows?: { Row?: ReportNode[] };
  Summary?: { ColData?: Array<{ value?: string }> };
  type?: string;
};

/** Flatten a QBO report tree into readable lines, indented by depth. */
export function flattenReport(report: unknown): { title: string | null; columns: string[]; lines: string[] } {
  const r = report as {
    Header?: { ReportName?: string; StartPeriod?: string; EndPeriod?: string; ReportBasis?: string };
    Columns?: { Column?: Array<{ ColTitle?: string }> };
    Rows?: { Row?: ReportNode[] };
  };
  const cells = (cd?: Array<{ value?: string }>) => (cd ?? []).map((c) => c.value ?? "").join(" | ").replace(/( \| )+$/, "");
  const lines: string[] = [];
  const walk = (rows: ReportNode[] | undefined, depth: number) => {
    for (const row of rows ?? []) {
      const pad = "  ".repeat(depth);
      if (row.Header?.ColData) lines.push(`${pad}${cells(row.Header.ColData)}`);
      if (row.ColData) lines.push(`${pad}${cells(row.ColData)}`);
      walk(row.Rows?.Row, depth + 1);
      if (row.Summary?.ColData) lines.push(`${pad}${cells(row.Summary.ColData)}`);
    }
  };
  walk(r.Rows?.Row, 0);
  const h = r.Header;
  const title = h?.ReportName
    ? `${h.ReportName}${h.StartPeriod ? ` ${h.StartPeriod} to ${h.EndPeriod}` : ""}${h.ReportBasis ? ` (${h.ReportBasis})` : ""}`
    : null;
  return { title, columns: (r.Columns?.Column ?? []).map((c) => c.ColTitle ?? ""), lines: lines.filter((l) => l.trim()) };
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const qboReport: ToolDef = {
  name: "qbo_report",
  ops: true,
  description:
    "Run a standard QuickBooks report on the live Feldart company and get it as readable lines (section headers, rows, totals): ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables/AgedPayables (+Detail), CustomerBalance(+Detail), CustomerIncome, CustomerSales, ItemSales, VendorBalance, VendorExpenses, TransactionList, GeneralLedger, TrialBalance, AccountList. Use for accounting questions (profit, cash, what we owe vendors, sales by customer/item over a period). Both books are in this one company. Big reports are trimmed — narrow the dates.",
  input_schema: {
    type: "object",
    properties: {
      report: { type: "string", enum: [...QBO_REPORTS] },
      startDate: { type: "string", description: "YYYY-MM-DD" },
      endDate: { type: "string", description: "YYYY-MM-DD" },
      dateMacro: { type: "string", description: "Instead of dates, e.g. \"This Month\", \"Last Month\", \"This Year\", \"Last Year\", \"This Quarter\"." },
      accountingMethod: { type: "string", enum: ["Accrual", "Cash"] },
      summarizeColumnBy: { type: "string", enum: ["Total", "Month", "Quarter", "Year", "Customers", "Vendors", "ProductsAndServices"], description: "Columns breakdown (P&L, sales reports)." },
      customerQbId: { type: "string", description: "Optional QuickBooks customer id to filter to one customer." },
    },
    required: ["report"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = parse(
      z.object({
        report: z.enum(QBO_REPORTS),
        startDate: isoDay.optional(),
        endDate: isoDay.optional(),
        dateMacro: z.string().max(40).optional(),
        accountingMethod: z.enum(["Accrual", "Cash"]).optional(),
        summarizeColumnBy: z.enum(["Total", "Month", "Quarter", "Year", "Customers", "Vendors", "ProductsAndServices"]).optional(),
        customerQbId: z.string().regex(/^\d{1,20}$/).optional(),
      }),
      input,
    );
    const params: Record<string, string> = {};
    if (p.startDate) params.start_date = p.startDate;
    if (p.endDate) params.end_date = p.endDate;
    if (p.dateMacro) params.date_macro = p.dateMacro;
    if (p.accountingMethod) params.accounting_method = p.accountingMethod;
    if (p.summarizeColumnBy) params.summarize_column_by = p.summarizeColumnBy;
    if (p.customerQbId) params.customer = p.customerQbId;
    let raw: unknown;
    try {
      raw = await new QboClient().getReport(p.report, params);
    } catch (err) {
      throw new ToolInputError(`QuickBooks couldn't run that report: ${qboError(err)}`);
    }
    const flat = flattenReport(raw);
    const { rows: lines, note } = fitRows(flat.lines, RESULT_BUDGET_BYTES - 3_000);
    return {
      asOf: ctx.now.toISOString(),
      report: flat.title ?? p.report,
      columns: flat.columns,
      lines,
      warnings: note ? [`Report trimmed to fit (${lines.length} of ${flat.lines.length} lines). Narrow the dates or use summarizeColumnBy=Total.`] : [],
    };
  },
};

export const OPS_QBO_TOOLS: ToolDef[] = [qboQuery, qboReport];
