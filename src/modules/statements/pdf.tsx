// Statement PDF renderer (QBO-style, 5-column open-items layout).
//
// Renders via @react-pdf/renderer in Node — no headless browser, no
// external service. Fonts: Helvetica (built-in to PDFKit, used by
// react-pdf's default font shipping). Colors + spacing mirror the user's
// locked spec; hex codes are documented inline so future tweaks don't
// require re-reading the brief.
//
// The function returns a Buffer; the caller (send.ts or the preview
// route) decides whether to attach it to an email or stream it back to
// the browser.
//
// Pagination: react-pdf paginates automatically when content exceeds a
// page. The table header is a `View` rendered with `fixed` so it
// repeats on every page. The footer summary is rendered inline after
// the table so it sits right under the rows when they fit, and on a
// later page when they don't — same behavior the locked spec describes
// ("at the bottom of the last page OR right after the table if it fits").

/* eslint-disable @typescript-eslint/no-unused-vars */
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import {
  Document,
  Image,
  Link,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import * as React from "react";
import { createLogger } from "../../lib/logger.js";
import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type { AppSettingsMap } from "./settings.js";

const log = createLogger({ module: "statements.pdf" });

// Color palette per the brief.
const COLOR_TITLE = "#5B9BD5";
const COLOR_LINK = "#1E73BE";
const COLOR_OVERDUE = "#D14747";
const COLOR_TABLE_HEADER_BG = "#5B9BD5";
const COLOR_TABLE_HEADER_TEXT = "#FFFFFF";
const COLOR_ROW_ALT = "#F8F8F8";
const COLOR_TEXT = "#1F2937";
const COLOR_LABEL = "#6B7280";
const COLOR_BORDER = "#E5E7EB";
const COLOR_FOOTER_NOTE = "#6B7280";

// Typesafe input. Caller composes this from DB rows + the settings map +
// the resolved statement number; the renderer doesn't reach back to QBO
// or the DB itself.
export type StatementInvoiceInput = Invoice & {
  invoiceLink?: string | null;
};

export type StatementCreditMemoInput = {
  qbId: string;
  docNumber?: string | null;
  txnDate: string | Date | null; // ISO YYYY-MM-DD or Date
  balance: number; // positive number; renderer flips sign for display
  description?: string | null;
};

export type RenderStatementPdfInput = {
  customer: Customer;
  openInvoices: StatementInvoiceInput[];
  creditMemos: StatementCreditMemoInput[];
  settings: AppSettingsMap;
  statementNumber: number;
  // Optional generation timestamp — exposed so callers (and tests) can
  // freeze "today". Defaults to a fresh Date when not supplied.
  generatedAt?: Date;
};

// Type-safe label-value summary row helper input. Used by the footer
// summary table — keeps the JSX flat and removes a few dozen lines of
// repeated style noise.
type SummaryRow = {
  label: string;
  value: string;
  emphasizeValue?: boolean;
  valueColor?: string;
};

// A tagged-union row used by the per-invoice + credit-memo table so we
// can sort the combined list by date once and render each kind in the
// right shape downstream.
type TableRow =
  | {
      kind: "invoice";
      sortDate: string; // YYYY-MM-DD; missing → "" so they sort first
      invoiceDate: string;
      description: string;
      dueDate: string;
      isOverdue: boolean;
      amount: string;
      openAmount: string;
      paymentLink: string | null;
    }
  | {
      kind: "credit_memo";
      sortDate: string;
      invoiceDate: string;
      description: string;
      dueDate: ""; // always empty for credit memos
      isOverdue: false;
      amount: string;
      openAmount: string;
      paymentLink: null;
    };

// PDF stylesheet. Sizing is in points; react-pdf's default unit on
// `Page` props is point. 36pt margins on all sides per the brief.
const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: COLOR_TEXT,
    paddingTop: 36,
    paddingBottom: 64, // larger bottom margin so the page-number footer doesn't crowd content
    paddingHorizontal: 36,
  },
  // Header band — company info (left) + logo (right).
  headerBand: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14,
  },
  companyBlock: {
    flexDirection: "column",
    flex: 1,
    paddingRight: 12,
  },
  companyName: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  companyMeta: {
    fontSize: 9,
    color: COLOR_TEXT,
    lineHeight: 1.35,
  },
  logoWrap: {
    width: 100,
    height: 60,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  logo: {
    maxWidth: 100,
    maxHeight: 60,
    objectFit: "contain",
  },
  statementTitle: {
    fontSize: 22,
    color: COLOR_TITLE,
    marginBottom: 14,
    fontFamily: "Helvetica-Bold",
  },
  // Customer + statement metadata row.
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  metaCol: {
    flexDirection: "column",
    flex: 1,
  },
  metaLeftCol: {
    flexDirection: "column",
    flex: 1,
    paddingRight: 12,
  },
  metaRightCol: {
    flexDirection: "column",
    flex: 1,
    alignItems: "flex-end",
  },
  metaLabel: {
    fontSize: 8,
    color: COLOR_LABEL,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  metaName: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    marginBottom: 2,
  },
  metaAddrLine: {
    fontSize: 9,
    lineHeight: 1.35,
  },
  metaPair: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 2,
  },
  metaPairLabel: {
    fontSize: 8,
    color: COLOR_LABEL,
    fontFamily: "Helvetica-Bold",
    marginRight: 6,
    letterSpacing: 0.4,
  },
  metaPairValue: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
  },
  // Table.
  tableHeader: {
    flexDirection: "row",
    backgroundColor: COLOR_TABLE_HEADER_BG,
    color: COLOR_TABLE_HEADER_TEXT,
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
    paddingVertical: 6,
    paddingHorizontal: 4,
    letterSpacing: 0.3,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR_BORDER,
    minHeight: 18,
  },
  tableRowAlt: {
    backgroundColor: COLOR_ROW_ALT,
  },
  cell: {
    fontSize: 9,
    paddingHorizontal: 2,
  },
  cellRight: {
    fontSize: 9,
    paddingHorizontal: 2,
    textAlign: "right",
  },
  cellHeader: {
    fontSize: 8.5,
    paddingHorizontal: 2,
    color: COLOR_TABLE_HEADER_TEXT,
  },
  cellHeaderRight: {
    fontSize: 8.5,
    paddingHorizontal: 2,
    color: COLOR_TABLE_HEADER_TEXT,
    textAlign: "right",
  },
  overdueText: {
    color: COLOR_OVERDUE,
    fontFamily: "Helvetica-Bold",
  },
  paymentLink: {
    color: COLOR_LINK,
    textDecoration: "underline",
    fontSize: 9,
  },
  // Footer summary.
  summaryWrap: {
    marginTop: 16,
    flexDirection: "column",
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR_BORDER,
  },
  summaryLabel: {
    fontSize: 9.5,
    color: COLOR_TEXT,
  },
  summaryValue: {
    fontSize: 9.5,
    color: COLOR_TEXT,
    fontFamily: "Helvetica-Bold",
  },
  paymentMethodsHeader: {
    fontSize: 8,
    color: COLOR_LABEL,
    fontFamily: "Helvetica-Bold",
    marginTop: 16,
    marginBottom: 4,
    letterSpacing: 0.4,
  },
  paymentMethodsBody: {
    fontSize: 9,
    lineHeight: 1.4,
  },
  footerNote: {
    fontSize: 9,
    fontStyle: "italic",
    color: COLOR_FOOTER_NOTE,
    marginTop: 12,
    lineHeight: 1.4,
  },
  pageNumber: {
    position: "absolute",
    fontSize: 8,
    bottom: 24,
    left: 36,
    right: 36,
    textAlign: "center",
    color: COLOR_LABEL,
  },
});

// Column widths for the 5-column invoice/credit-memo table. Spec calls
// for INVOICE DATE 14% / DESCRIPTION 38% / DUE DATE 14% / AMOUNT 14% /
// OPEN AMOUNT 12% / PAYMENT 8% — six headers, totaling 100%. The "5
// columns" label in the brief was off-by-one; we render all six.
const COL_WIDTHS = {
  invoiceDate: "14%",
  description: "38%",
  dueDate: "14%",
  amount: "14%",
  openAmount: "12%",
  payment: "8%",
} as const;

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB sanity cap
// react-pdf supports PNG + JPEG out of the box. GIF is not supported by
// the underlying PDFKit image pipeline, so we reject it during the
// readLogo step rather than letting it crash render time.
const ALLOWED_LOGO_EXTS = new Set([".png", ".jpg", ".jpeg"]);

// Money formatter — same shape as email-compose's formatMoney but local
// so the PDF module is decoupled from the email module. en-US currency
// matches what the rest of the app renders.
function formatMoney(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  const rounded = Math.round((safe + Number.EPSILON) * 100) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(rounded);
}

// Format an ISO/Date as MM/DD/YYYY (US style per spec). Returns "" for
// null/blank so callers can decide whether to render a placeholder.
function formatDateUs(input: string | Date | null | undefined): string {
  if (!input) return "";
  let d: Date;
  if (input instanceof Date) {
    d = input;
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
    d = m
      ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`)
      : new Date(input);
  }
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

// Drizzle returns date columns as Date | null. Normalize either a Date
// or an ISO string to YYYY-MM-DD for sorting + due-date comparisons.
function isoDateString(d: string | Date | null | undefined): string {
  if (!d) return "";
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function parseAmount(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Read the configured logo path off disk and return the raw bytes plus
// a MIME type suitable for the react-pdf <Image src=...> prop. Returns
// null (and warn-logs) on any failure mode — missing file, oversized,
// unreadable. The PDF should never crash because of a logo problem.
function readLogo(
  logoPath: string,
): { data: Buffer; mimeType: string } | null {
  if (!logoPath) return null;
  try {
    if (!existsSync(logoPath)) {
      log.warn({ logoPath }, "company_logo_path missing on disk; skipping");
      return null;
    }
    const ext = extname(logoPath).toLowerCase();
    if (!ALLOWED_LOGO_EXTS.has(ext)) {
      log.warn(
        { logoPath, ext },
        "company_logo_path has unsupported extension; skipping",
      );
      return null;
    }
    const data = readFileSync(logoPath);
    if (data.byteLength > MAX_LOGO_BYTES) {
      log.warn(
        { logoPath, bytes: data.byteLength },
        "company_logo_path exceeds 5 MB; skipping",
      );
      return null;
    }
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    return { data, mimeType };
  } catch (err) {
    log.warn({ err, logoPath }, "company_logo_path read failed; skipping");
    return null;
  }
}

// Splits a multi-line string ("\n", "\r\n") into trimmed lines, dropping
// blanks. Used for company_address + payment_methods — caller types
// these as raw text in /settings; we render each line as its own <Text>.
function splitLines(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---- Components --------------------------------------------------------

function CompanyBlock({
  settings,
}: {
  settings: AppSettingsMap;
}): React.ReactElement {
  const addressLines = splitLines(settings.company_address);
  return (
    <View style={styles.companyBlock}>
      {settings.company_name ? (
        <Text style={styles.companyName}>{settings.company_name}</Text>
      ) : null}
      {addressLines.map((line, i) => (
        <Text key={`addr-${i}`} style={styles.companyMeta}>
          {line}
        </Text>
      ))}
      {settings.company_phone ? (
        <Text style={styles.companyMeta}>{settings.company_phone}</Text>
      ) : null}
      {settings.company_email ? (
        <Text style={styles.companyMeta}>{settings.company_email}</Text>
      ) : null}
      {settings.company_website ? (
        <Text style={styles.companyMeta}>{settings.company_website}</Text>
      ) : null}
    </View>
  );
}

function LogoBlock({
  logo,
}: {
  logo: { data: Buffer; mimeType: string } | null;
}): React.ReactElement | null {
  if (!logo) return null;
  // react-pdf accepts { data: Buffer, format: "png"|"jpg" } as an image
  // source. The format is derived from mimeType; we filter inputs at
  // readLogo time so anything that survives is one of those two.
  const format: "png" | "jpg" =
    logo.mimeType === "image/png" ? "png" : "jpg";
  return (
    <View style={styles.logoWrap}>
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      <Image
        style={styles.logo}
        src={{ data: logo.data, format }}
      />
    </View>
  );
}

function CustomerMetaBlock({
  customer,
}: {
  customer: Customer;
}): React.ReactElement {
  const addrLines = [
    customer.billingAddressLine1,
    customer.billingAddressLine2,
    [
      customer.billingAddressCity,
      customer.billingAddressRegion,
      customer.billingAddressPostal,
    ]
      .filter((s) => s && String(s).trim())
      .join(", "),
    customer.billingAddressCountry,
  ].filter((line): line is string => Boolean(line && String(line).trim()));

  return (
    <View style={styles.metaLeftCol}>
      <Text style={styles.metaLabel}>TO</Text>
      <Text style={styles.metaName}>{customer.displayName}</Text>
      {addrLines.map((line, i) => (
        <Text key={`cust-addr-${i}`} style={styles.metaAddrLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function StatementHeaderRight({
  statementNumber,
  generatedAt,
  totalDue,
}: {
  statementNumber: number;
  generatedAt: Date;
  totalDue: number;
}): React.ReactElement {
  const rows: { label: string; value: string }[] = [
    { label: "STATEMENT NO.", value: String(statementNumber) },
    { label: "DATE", value: formatDateUs(generatedAt) },
    { label: "TOTAL DUE", value: formatMoney(totalDue) },
  ];
  return (
    <View style={styles.metaRightCol}>
      {rows.map((r, i) => (
        <View key={`mr-${i}`} style={styles.metaPair}>
          <Text style={styles.metaPairLabel}>{r.label}</Text>
          <Text style={styles.metaPairValue}>{r.value}</Text>
        </View>
      ))}
    </View>
  );
}

function TableHeader(): React.ReactElement {
  return (
    <View style={styles.tableHeader} fixed>
      <Text style={[styles.cellHeader, { width: COL_WIDTHS.invoiceDate }]}>
        INVOICE DATE
      </Text>
      <Text style={[styles.cellHeader, { width: COL_WIDTHS.description }]}>
        DESCRIPTION
      </Text>
      <Text style={[styles.cellHeader, { width: COL_WIDTHS.dueDate }]}>
        DUE DATE
      </Text>
      <Text style={[styles.cellHeaderRight, { width: COL_WIDTHS.amount }]}>
        AMOUNT
      </Text>
      <Text
        style={[styles.cellHeaderRight, { width: COL_WIDTHS.openAmount }]}
      >
        OPEN AMOUNT
      </Text>
      <Text style={[styles.cellHeader, { width: COL_WIDTHS.payment }]}>
        PAYMENT
      </Text>
    </View>
  );
}

function TableBody({ rows }: { rows: TableRow[] }): React.ReactElement {
  return (
    <View>
      {rows.map((r, i) => {
        const rowStyle = [
          styles.tableRow,
          i % 2 === 1 ? styles.tableRowAlt : {},
        ];
        return (
          <View key={`row-${i}`} style={rowStyle} wrap={false}>
            <Text style={[styles.cell, { width: COL_WIDTHS.invoiceDate }]}>
              {r.invoiceDate}
            </Text>
            <Text style={[styles.cell, { width: COL_WIDTHS.description }]}>
              {r.description}
            </Text>
            <Text
              style={[
                styles.cell,
                { width: COL_WIDTHS.dueDate },
                r.kind === "invoice" && r.isOverdue ? styles.overdueText : {},
              ]}
            >
              {r.dueDate}
            </Text>
            <Text style={[styles.cellRight, { width: COL_WIDTHS.amount }]}>
              {r.amount}
            </Text>
            <Text style={[styles.cellRight, { width: COL_WIDTHS.openAmount }]}>
              {r.openAmount}
            </Text>
            <View style={[styles.cell, { width: COL_WIDTHS.payment }]}>
              {r.kind === "invoice" && r.paymentLink ? (
                <Link src={r.paymentLink} style={styles.paymentLink}>
                  View and pay
                </Link>
              ) : (
                <Text> </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function FooterSummary({
  rows,
}: {
  rows: SummaryRow[];
}): React.ReactElement {
  return (
    <View style={styles.summaryWrap} wrap={false}>
      {rows.map((r, i) => (
        <View key={`s-${i}`} style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{r.label}</Text>
          <Text
            style={[
              styles.summaryValue,
              r.valueColor ? { color: r.valueColor } : {},
            ]}
          >
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PaymentMethodsBlock({
  settings,
}: {
  settings: AppSettingsMap;
}): React.ReactElement | null {
  const lines = splitLines(settings.payment_methods);
  if (lines.length === 0 && !settings.footer_note) return null;
  return (
    <View wrap={false}>
      {lines.length > 0 ? (
        <>
          <Text style={styles.paymentMethodsHeader}>PAYMENT METHODS</Text>
          {lines.map((line, i) => (
            <Text key={`pm-${i}`} style={styles.paymentMethodsBody}>
              {line}
            </Text>
          ))}
        </>
      ) : null}
      {settings.footer_note ? (
        <Text style={styles.footerNote}>{settings.footer_note}</Text>
      ) : null}
    </View>
  );
}

// Pure helper — given the input rows, produce a UTC-truthy "is overdue"
// flag without mutating callers. Today is UTC-midnight per the spec.
function isOverdue(
  due: string | Date | null | undefined,
  balance: number,
  todayUtcMs: number,
): boolean {
  if (!due) return false;
  if (balance <= 0) return false;
  const iso = isoDateString(due);
  if (!iso) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return false;
  const dueMs = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`).getTime();
  return dueMs < todayUtcMs;
}

// Build the unified, date-sorted row list consumed by the table body.
// Invoices use issueDate as the sort key; credit memos use txnDate.
// Falsy dates sort to the top (rare; QBO-side "missing" data).
function buildTableRows(
  invoices: StatementInvoiceInput[],
  creditMemos: StatementCreditMemoInput[],
  todayUtcMs: number,
): TableRow[] {
  const rows: TableRow[] = [];

  for (const inv of invoices) {
    const balance = parseAmount(inv.balance);
    const total = parseAmount(inv.total);
    const overdue = isOverdue(inv.dueDate, balance, todayUtcMs);
    rows.push({
      kind: "invoice",
      sortDate: isoDateString(inv.issueDate),
      invoiceDate: formatDateUs(inv.issueDate),
      description: `Invoice #${inv.docNumber ?? `(${inv.qbInvoiceId})`}`,
      dueDate: formatDateUs(inv.dueDate),
      isOverdue: overdue,
      amount: formatMoney(total),
      openAmount: formatMoney(balance),
      paymentLink: inv.invoiceLink ?? null,
    });
  }

  for (const cm of creditMemos) {
    const balance = parseAmount(cm.balance);
    const desc = cm.description
      ? `Credit Memo #${cm.docNumber ?? `(${cm.qbId})`} — ${cm.description}`
      : `Credit Memo #${cm.docNumber ?? `(${cm.qbId})`}`;
    rows.push({
      kind: "credit_memo",
      sortDate: isoDateString(cm.txnDate),
      invoiceDate: formatDateUs(cm.txnDate),
      description: desc,
      dueDate: "",
      isOverdue: false,
      // Display credit memos as negative amounts in both columns to
      // match the QBO statement convention.
      amount: formatMoney(-balance),
      openAmount: formatMoney(-balance),
      paymentLink: null,
    });
  }

  rows.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  return rows;
}

function StatementDocument({
  customer,
  openInvoices,
  creditMemos,
  settings,
  statementNumber,
  generatedAt,
}: Required<RenderStatementPdfInput>): React.ReactElement {
  const today = new Date(
    Date.UTC(
      generatedAt.getUTCFullYear(),
      generatedAt.getUTCMonth(),
      generatedAt.getUTCDate(),
    ),
  );
  const todayUtcMs = today.getTime();

  // Aggregates.
  const totalOpenBalance = openInvoices.reduce(
    (acc, inv) => acc + parseAmount(inv.balance),
    0,
  );
  const totalOverdueBalance = openInvoices.reduce((acc, inv) => {
    const b = parseAmount(inv.balance);
    return isOverdue(inv.dueDate, b, todayUtcMs) ? acc + b : acc;
  }, 0);
  const totalCreditMemos = creditMemos.reduce(
    (acc, cm) => acc + parseAmount(cm.balance),
    0,
  );
  const netOverdue = Math.max(0, totalOverdueBalance - totalCreditMemos);
  const totalDue = Math.max(0, totalOpenBalance - totalCreditMemos);

  const tableRows = buildTableRows(openInvoices, creditMemos, todayUtcMs);
  const logo = readLogo(settings.company_logo_path);

  const summary: SummaryRow[] = [
    {
      label: "Open balance",
      value: formatMoney(totalOpenBalance),
    },
    {
      label: "Total overdue",
      value: formatMoney(totalOverdueBalance),
      valueColor: totalOverdueBalance > 0 ? COLOR_OVERDUE : undefined,
    },
    {
      label: "Available credits",
      value: formatMoney(-totalCreditMemos),
      valueColor: totalCreditMemos === 0 ? COLOR_LABEL : undefined,
    },
    {
      label: "Net overdue (after credits)",
      value: formatMoney(netOverdue),
      valueColor: netOverdue > 0 ? COLOR_OVERDUE : undefined,
    },
    {
      label: "Payment terms",
      value: customer.paymentTerms ?? "—",
    },
  ];

  return (
    <Document
      title={`Statement #${statementNumber} — ${customer.displayName}`}
      author={settings.company_name || "Finance Hub"}
      subject={`Statement of account for ${customer.displayName}`}
      creator="Finance Hub 2.0"
    >
      <Page size="A4" style={styles.page} wrap>
        {/* Top band — company info + logo. */}
        <View style={styles.headerBand} fixed={false}>
          <CompanyBlock settings={settings} />
          <LogoBlock logo={logo} />
        </View>

        <Text style={styles.statementTitle}>Statement</Text>

        <View style={styles.metaRow}>
          <CustomerMetaBlock customer={customer} />
          <StatementHeaderRight
            statementNumber={statementNumber}
            generatedAt={generatedAt}
            totalDue={totalDue}
          />
        </View>

        <TableHeader />
        <TableBody rows={tableRows} />
        <FooterSummary rows={summary} />
        <PaymentMethodsBlock settings={settings} />

        <Text
          style={styles.pageNumber}
          render={({ pageNumber, totalPages }) =>
            totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : ""
          }
          fixed
        />
      </Page>
    </Document>
  );
}

// Public entry point. Wraps renderToBuffer so callers don't need to pull
// in @react-pdf/renderer themselves. Inputs are all-required at the
// type level except generatedAt — defaulted here so test code stays
// terse and production code can ignore the parameter.
export async function renderStatementPdf(
  input: RenderStatementPdfInput,
): Promise<Buffer> {
  const generatedAt = input.generatedAt ?? new Date();
  const buffer = await renderToBuffer(
    <StatementDocument
      customer={input.customer}
      openInvoices={input.openInvoices}
      creditMemos={input.creditMemos}
      settings={input.settings}
      statementNumber={input.statementNumber}
      generatedAt={generatedAt}
    />,
  );
  return buffer;
}
