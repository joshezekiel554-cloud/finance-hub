// Statement-of-account HTML rendering.
//
// Pure function: takes the customer + open invoices + (optional) credit
// memo data and returns a self-contained HTML block suitable for
// substitution into the {{statement_table}} placeholder of the
// statement_open_items email template.
//
// Why inline-styled instead of CSS classes: Gmail (web + mobile),
// Outlook web, Apple Mail, et al. strip <style> blocks from rendered
// HTML, and only some honor a `class=` attribute. Inline `style="..."`
// attributes survive every major mail client. We intentionally restrict
// to the property subset that Outlook 2016 desktop accepts since it's
// the strictest still-in-use renderer.
//
// All text drawn from caller-supplied data goes through escapeHtml first
// so a customer name like `Foo & Sons <Acme>` renders literally instead
// of disappearing into an HTML tag soup. The structure (TABLE > THEAD/
// TBODY) and money/date formatting are owned by this module — callers
// pass raw values (Date, decimals as strings/numbers) and we shape them
// for display.

import { formatMoney } from "../email-compose/index.js";

// Minimal HTML escape — same pattern as routes/email-send.ts. Sufficient
// because we wrap each piece in a structural tag we generate ourselves;
// the input is metadata strings (names, doc numbers), not freeform HTML.
function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Format an ISO-ish date string ('YYYY-MM-DD' or full ISO) as DD/MM/YYYY.
// We pin to en-GB so the rendering is deterministic regardless of the
// server's locale. Returns "—" for null/empty so the rendered table
// doesn't show a bare empty cell.
function formatDate(input: string | null | undefined): string {
  if (!input) return "—";
  // Drizzle stores `date` columns as 'YYYY-MM-DD'; pin to UTC midnight
  // so the displayed day doesn't shift backward in eastern timezones.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  const d = m
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`)
    : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

// Days between dueDate and "now" (UTC midnight on each side). Negative
// or null due dates return 0 — only positive overdue counts surface in
// the rendered "Days overdue" column.
function daysOverdue(dueDate: string | null | undefined, now: Date): number {
  if (!dueDate) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate);
  const due = m
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`)
    : new Date(dueDate);
  if (Number.isNaN(due.getTime())) return 0;
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const diff = today.getTime() - due.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

function parseAmount(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Per-invoice row passed to renderStatementTable. Caller does the join
// of our DB row + the QBO InvoiceLink lookup; rendering doesn't reach
// out for either. Dates are passed as ISO strings (YYYY-MM-DD) so the
// caller doesn't have to worry about Date instantiation gotchas.
export type StatementInvoiceRow = {
  qbInvoiceId: string;
  docNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  total: string | number;
  balance: string | number;
  // QBO-issued sharable Pay-now URL. Null when QBO Payments isn't
  // enabled for the invoice or when the customer email is missing
  // QBO-side. Rendered as the Invoice # link target when present, or
  // as plain text when not.
  invoiceLink: string | null;
};

export type StatementCreditMemoRow = {
  qbCreditMemoId: string;
  docNumber: string | null;
  txnDate: string | null;
  balance: string | number;
};

export type RenderStatementTableInput = {
  customer: {
    displayName: string;
  };
  openInvoices: StatementInvoiceRow[];
  creditMemos: StatementCreditMemoRow[];
  // Defaults to new Date() — exposed as an injection point so tests can
  // produce stable "Days overdue" output.
  now?: Date;
};

// Style fragments — extracted so the markup below stays scannable. Each
// is a complete style="..." attribute value (no leading "style=", just
// the declarations) so the consumer can `style="${STYLES.cellRight}"`.
const STYLES = {
  table:
    "border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1f2937;margin:16px 0;",
  th:
    "text-align:left;padding:8px 10px;border-bottom:2px solid #d1d5db;background-color:#f3f4f6;font-weight:600;",
  thRight:
    "text-align:right;padding:8px 10px;border-bottom:2px solid #d1d5db;background-color:#f3f4f6;font-weight:600;",
  td: "padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;",
  tdRight:
    "padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;vertical-align:top;",
  totalsLabel:
    "padding:8px 10px;font-weight:600;border-top:2px solid #d1d5db;",
  totalsValue:
    "padding:8px 10px;text-align:right;font-weight:600;border-top:2px solid #d1d5db;",
  netLabel:
    "padding:8px 10px;font-weight:700;border-top:1px solid #e5e7eb;background-color:#f9fafb;",
  netValue:
    "padding:8px 10px;text-align:right;font-weight:700;border-top:1px solid #e5e7eb;background-color:#f9fafb;",
  link: "color:#1d4ed8;text-decoration:underline;",
  overdue: "color:#b91c1c;font-weight:600;",
  sectionHeading:
    "font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#1f2937;margin:16px 0 4px 0;",
  caption:
    "font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280;margin:0 0 8px 0;",
} as const;

// Build the per-invoice table rows. Returns the inner <tr>...</tr> string;
// the heading + totals are appended by the caller. Columns:
//   Invoice # · Issue date · Due date · Total · Balance · Days overdue
// Invoice # links to InvoiceLink when present (Pay-now URL); otherwise
// renders as plain text so the column is never blank.
function buildInvoiceRows(
  rows: StatementInvoiceRow[],
  now: Date,
): { html: string; totalOpen: number; totalOverdue: number } {
  let totalOpen = 0;
  let totalOverdue = 0;
  const trs: string[] = [];
  for (const r of rows) {
    const balance = parseAmount(r.balance);
    const days = daysOverdue(r.dueDate, now);
    totalOpen += balance;
    if (days > 0) totalOverdue += balance;
    const docLabel = escapeHtml(r.docNumber ?? "(no #)");
    const docCell = r.invoiceLink
      ? `<a href="${escapeHtml(r.invoiceLink)}" style="${STYLES.link}" target="_blank" rel="noopener">${docLabel}</a>`
      : docLabel;
    const daysCell =
      days > 0
        ? `<span style="${STYLES.overdue}">${days}</span>`
        : "0";
    trs.push(
      `<tr>` +
        `<td style="${STYLES.td}">${docCell}</td>` +
        `<td style="${STYLES.td}">${escapeHtml(formatDate(r.issueDate))}</td>` +
        `<td style="${STYLES.td}">${escapeHtml(formatDate(r.dueDate))}</td>` +
        `<td style="${STYLES.tdRight}">${escapeHtml(formatMoney(r.total))}</td>` +
        `<td style="${STYLES.tdRight}">${escapeHtml(formatMoney(balance))}</td>` +
        `<td style="${STYLES.tdRight}">${daysCell}</td>` +
        `</tr>`,
    );
  }
  return {
    html: trs.join(""),
    totalOpen: Math.round(totalOpen * 100) / 100,
    totalOverdue: Math.round(totalOverdue * 100) / 100,
  };
}

function buildCreditMemoRows(rows: StatementCreditMemoRow[]): {
  html: string;
  totalCredits: number;
} {
  let totalCredits = 0;
  const trs: string[] = [];
  for (const r of rows) {
    const balance = parseAmount(r.balance);
    totalCredits += balance;
    trs.push(
      `<tr>` +
        `<td style="${STYLES.td}">${escapeHtml(r.docNumber ?? "(no #)")}</td>` +
        `<td style="${STYLES.td}">${escapeHtml(formatDate(r.txnDate))}</td>` +
        `<td style="${STYLES.tdRight}">${escapeHtml(formatMoney(balance))}</td>` +
        `</tr>`,
    );
  }
  return {
    html: trs.join(""),
    totalCredits: Math.round(totalCredits * 100) / 100,
  };
}

// Top-level entry point. The output is meant to be embedded inside the
// statement_open_items template (it has no <html>/<body> shell of its
// own — the surrounding template provides that).
export function renderStatementTable(
  input: RenderStatementTableInput,
): string {
  const now = input.now ?? new Date();
  const customerName = escapeHtml(input.customer.displayName ?? "");

  const invoices = buildInvoiceRows(input.openInvoices, now);
  const creditMemos = buildCreditMemoRows(input.creditMemos);
  const net = Math.round((invoices.totalOpen - creditMemos.totalCredits) * 100) / 100;

  // Open invoices section.
  const invoicesTable = `
<p style="${STYLES.sectionHeading}">Open invoices for ${customerName}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${STYLES.table}">
  <thead>
    <tr>
      <th style="${STYLES.th}">Invoice #</th>
      <th style="${STYLES.th}">Issue date</th>
      <th style="${STYLES.th}">Due date</th>
      <th style="${STYLES.thRight}">Total</th>
      <th style="${STYLES.thRight}">Balance</th>
      <th style="${STYLES.thRight}">Days overdue</th>
    </tr>
  </thead>
  <tbody>
    ${invoices.html}
  </tbody>
</table>`;

  // Credit memos section — only when any are present. Rendering an empty
  // "Available credits" block looks like missing data; suppress.
  const creditMemosTable = input.creditMemos.length
    ? `
<p style="${STYLES.sectionHeading}">Available credits</p>
<p style="${STYLES.caption}">Credits below are unapplied — they reduce the net amount due.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${STYLES.table}">
  <thead>
    <tr>
      <th style="${STYLES.th}">Memo #</th>
      <th style="${STYLES.th}">Date</th>
      <th style="${STYLES.thRight}">Balance to apply</th>
    </tr>
  </thead>
  <tbody>
    ${creditMemos.html}
  </tbody>
</table>`
    : "";

  // Totals table — always rendered. Net = open - credits, even when one
  // or both terms are zero, so the recipient sees the bottom line.
  const totalsTable = `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${STYLES.table}">
  <tbody>
    <tr>
      <td style="${STYLES.totalsLabel}">Total open</td>
      <td style="${STYLES.totalsValue}">${escapeHtml(formatMoney(invoices.totalOpen))}</td>
    </tr>
    <tr>
      <td style="${STYLES.totalsLabel}">Total overdue</td>
      <td style="${STYLES.totalsValue}"><span style="${STYLES.overdue}">${escapeHtml(formatMoney(invoices.totalOverdue))}</span></td>
    </tr>
    <tr>
      <td style="${STYLES.totalsLabel}">Total credits available</td>
      <td style="${STYLES.totalsValue}">${escapeHtml(formatMoney(creditMemos.totalCredits))}</td>
    </tr>
    <tr>
      <td style="${STYLES.netLabel}">Net amount due</td>
      <td style="${STYLES.netValue}">${escapeHtml(formatMoney(net))}</td>
    </tr>
  </tbody>
</table>`;

  return `${invoicesTable}${creditMemosTable}${totalsTable}`;
}
