// Statement-of-account send orchestrator (Path B from the plan).
//
// Flow:
//   1. Load customer + open invoices from our own DB
//   2. Pull each invoice's QBO InvoiceLink (Pay-now URL, requires
//      `?include=invoiceLink` on the QBO query path) — populated when
//      QBO Payments is enabled for the invoice
//   3. Pull the customer's unapplied credit memos from QBO
//   4. Render the statement HTML table via render.ts
//   5. Resolve the `statement_open_items` template — caller (this
//      module) substitutes {{statement_table}} with the rendering and
//      lets the rest of the template-vars resolver fill in the standard
//      {{customer_name}} / {{open_balance}} / etc. placeholders
//   6. Fetch each invoice's PDF via QboClient.getPdf — bounded
//      concurrency (5 in parallel) so a 30-invoice send doesn't
//      hammer QBO with 30 simultaneous file downloads
//   7. Send via gmail/send.ts with To = customer.primary_email,
//      CC = billing emails minus primary, BCC = accounts@feldart.com
//      so the user gets a record copy, alias = accounts@feldart.com
//   8. Insert statement_sends row, emit qbo_statement_sent activity,
//      audit-log
//
// What this module does NOT do:
//   - Modify the QBO client. The brief locks src/integrations/qb/client.ts.
//     We use existing public methods (`getPdf`) where they exist and
//     drop down to direct HTTP for the two missing pieces (InvoiceLink
//     query, customer-scoped credit memo query). Both calls reuse the
//     QB token loader from integrations/qb/tokens.ts so we never embed
//     OAuth state in the module.
//   - Decode HTML in the template. The template body is HTML we own
//     (seeded by scripts/seed-email-templates.ts). User-derived strings
//     (customer name, doc numbers) go through escapeHtml in render.ts
//     before they hit the rendered table.

import axios, { type AxiosError } from "axios";
import { and, asc, eq, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  emailTemplates,
} from "../../db/schema/email-templates.js";
import {
  statementSends,
} from "../../db/schema/crm.js";
import { users } from "../../db/schema/auth.js";
import { customers } from "../../db/schema/customers.js";
import { invoices, type Invoice } from "../../db/schema/invoices.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { QboClient } from "../../integrations/qb/client.js";
import { loadQbTokens } from "../../integrations/qb/tokens.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { recordActivity } from "../crm/index.js";
import {
  buildTemplateVars,
  formatMoney,
  renderTemplate,
} from "../email-compose/index.js";
import {
  renderStatementTable,
  type StatementCreditMemoRow,
  type StatementInvoiceRow,
} from "./render.js";

const log = createLogger({ module: "statements.send" });

const STATEMENT_TEMPLATE_SLUG = "statement_open_items";
const STATEMENT_ALIAS = "accounts@feldart.com";
const PDF_FETCH_CONCURRENCY = 5;
const QBO_MINOR_VERSION = 65;
const QBO_PROD = "https://quickbooks.api.intuit.com";
// Hard cap on how many invoices a single statement attaches PDFs for.
// Brief calls 50 a "cap; would need rare." Refuse early instead of
// quietly truncating so callers see the error explicitly.
const MAX_INVOICES_PER_SEND = 50;

export type ManagerInput = {
  customerId: string;
  userId: string;
};

export type SendStatementResult = {
  statementSendId: string;
  sent: {
    to: string;
    cc: string | null;
    bcc: string | null;
  };
  openInvoiceCount: number;
  totalOpenBalance: number;
  totalOverdueBalance: number;
  sentAt: string; // ISO
  messageId: string;
};

// Domain error class so the route layer can map specific failure modes
// to status codes without resorting to message-string matching. Code is
// the discriminator; message is for logs/UI display.
export class SendStatementError extends Error {
  readonly code:
    | "customer_not_found"
    | "no_primary_email"
    | "no_open_invoices"
    | "too_many_invoices"
    | "template_not_found"
    | "qbo_failed"
    | "send_failed";
  constructor(code: SendStatementError["code"], message: string) {
    super(message);
    this.name = "SendStatementError";
    this.code = code;
  }
}

type QboInvoiceWithLink = {
  Id: string;
  InvoiceLink?: string;
};

type QboCreditMemoRow = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Balance?: number;
  CustomerRef?: { value: string };
};

// Single QBO query call with the supplied include params. Mirrors the
// shape of QboClient.query<T> but adds `include` support and stays
// inside this module so we don't have to alter the locked client file.
// Token resolution goes through loadQbTokens (the encrypted-at-rest
// store); refresh is delegated to QboClient on the rare 401 path so we
// keep the single-flight refresh contract of tokens.ts intact.
async function qboQuery<T extends object>(opts: {
  query: string;
  include?: string[];
}): Promise<T> {
  const realmId = env.QB_REALM_ID;
  const url = `${QBO_PROD}/v3/company/${realmId}/query`;

  const tokens = await loadQbTokens(realmId);
  if (!tokens) {
    throw new SendStatementError(
      "qbo_failed",
      `No QB tokens for realm ${realmId} — run the OAuth flow first.`,
    );
  }

  const params: Record<string, string | number> = {
    query: opts.query,
    minorversion: QBO_MINOR_VERSION,
  };
  if (opts.include && opts.include.length > 0) {
    params.include = opts.include.join(",");
  }

  const doRequest = async (token: string) => {
    return axios.get<T>(url, {
      params,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      timeout: 30_000,
    });
  };

  try {
    const res = await doRequest(tokens.accessToken);
    return res.data;
  } catch (err) {
    const ax = err as AxiosError;
    if (ax.response?.status === 401) {
      // Token went stale between load + use. The QboClient owns the
      // refresh path (with single-flight + CAS save semantics in
      // tokens.ts); the cheapest way to ride that path is to call any
      // small public method whose 401 retry refreshes the token as a
      // side effect, then re-load the (now-fresh) token from the
      // encrypted store. getTerms is a single small query that exists
      // on every QBO realm. We swallow its result — we only want the
      // refresh side effect.
      const qb = new QboClient();
      try {
        await qb.getTerms();
      } catch {
        // ignore — even if getTerms fails the refresh side effect
        // should already have run inside its 401 retry. Re-load below
        // and let the retry attempt either succeed or surface the
        // real error.
      }
      const fresh = await loadQbTokens(realmId);
      if (!fresh) {
        throw new SendStatementError(
          "qbo_failed",
          "QB tokens disappeared mid-refresh",
        );
      }
      const res = await doRequest(fresh.accessToken);
      return res.data;
    }
    log.error(
      { err: serializeAxiosError(ax), query: opts.query },
      "qbo query failed",
    );
    throw new SendStatementError(
      "qbo_failed",
      `QBO query failed: ${ax.message}`,
    );
  }
}

function serializeAxiosError(err: AxiosError): Record<string, unknown> {
  return {
    status: err.response?.status,
    statusText: err.response?.statusText,
    data: err.response?.data,
    message: err.message,
  };
}

// Bounded-concurrency map. Same shape as the helper in gmail/client.ts
// — replicated here so we don't reach across module boundaries for what
// is ~15 lines of code.
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

// Look up InvoiceLink for a batch of QBO invoice IDs. QBO IQL doesn't
// support `?include=invoiceLink` on individual GETs of /invoice/{id};
// only the /query endpoint surfaces the field, and only when the
// `include=invoiceLink` query param is present. We chunk into groups of
// 200 to stay under the QBO query length cap (same chunk size used by
// getInvoicesByDocNumbers in the QBO client).
async function fetchInvoiceLinks(
  qbInvoiceIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (qbInvoiceIds.length === 0) return map;
  const CHUNK = 200;
  for (let i = 0; i < qbInvoiceIds.length; i += CHUNK) {
    const chunk = qbInvoiceIds.slice(i, i + CHUNK);
    const inClause = chunk
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(",");
    const data = await qboQuery<{
      QueryResponse: { Invoice?: QboInvoiceWithLink[] };
    }>({
      query: `SELECT Id, InvoiceLink FROM Invoice WHERE Id IN (${inClause})`,
      include: ["invoiceLink"],
    });
    for (const inv of data.QueryResponse.Invoice ?? []) {
      if (inv.Id && inv.InvoiceLink) {
        map.set(inv.Id, inv.InvoiceLink);
      }
    }
  }
  return map;
}

// Customer-scoped unapplied-credit-memo query. Pulls everything with a
// non-zero remaining balance for the given QB customer id; QBO filters
// the rest server-side so this is a single round-trip.
async function fetchUnappliedCreditMemos(
  qbCustomerId: string,
): Promise<StatementCreditMemoRow[]> {
  const safeId = qbCustomerId.replace(/'/g, "''");
  const data = await qboQuery<{
    QueryResponse: { CreditMemo?: QboCreditMemoRow[] };
  }>({
    query: `SELECT * FROM CreditMemo WHERE CustomerRef = '${safeId}' AND Balance > '0'`,
  });
  const rows: StatementCreditMemoRow[] = [];
  for (const cm of data.QueryResponse.CreditMemo ?? []) {
    rows.push({
      qbCreditMemoId: cm.Id,
      docNumber: cm.DocNumber ?? null,
      txnDate: cm.TxnDate ?? null,
      balance: cm.Balance ?? 0,
    });
  }
  return rows;
}

// CSV-join helper for To/CC/BCC fields. Filters out null/empty/dupes
// (case-insensitive). Returns null when the result is empty so the
// gmail/send layer can omit the header rather than rendering "Cc: ".
function joinAddresses(addrs: (string | null | undefined)[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    if (!a) continue;
    const trimmed = a.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out.length ? out.join(", ") : null;
}

// Drizzle's MySQL `date` column infers as `Date | null` by default (no
// `mode: 'string'` configured). Our render module wants ISO strings;
// normalize here at the seam where the DB row crosses the boundary so
// downstream code stays uniform. String input is also tolerated for
// flexibility.
function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    // YYYY-MM-DD slice — toISOString uses UTC so this matches the
    // MySQL DATE column's date-only semantics.
    return d.toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : d;
}

function parseAmount(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function calcOverdue(opens: Invoice[], now: Date): number {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  let total = 0;
  for (const inv of opens) {
    if (!inv.dueDate) continue;
    const dueIso = isoDate(inv.dueDate);
    if (!dueIso) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueIso);
    if (!m) continue;
    const due = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
    if (due.getTime() < today.getTime()) {
      total += parseAmount(inv.balance);
    }
  }
  return Math.round(total * 100) / 100;
}

// Public entry point. Loads everything, fires QBO + Gmail, persists the
// statement_sends row + activity + audit log, returns the result. All
// failure modes throw a SendStatementError; the route layer catches
// and maps to HTTP statuses.
export async function sendStatement(
  input: ManagerInput,
): Promise<SendStatementResult> {
  const { customerId, userId } = input;
  const now = new Date();

  const customerRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const customer = customerRows[0];
  if (!customer) {
    throw new SendStatementError(
      "customer_not_found",
      `customer ${customerId} not found`,
    );
  }
  if (!customer.primaryEmail) {
    throw new SendStatementError(
      "no_primary_email",
      `customer ${customerId} has no primary_email; cannot address the statement`,
    );
  }
  if (!customer.qbCustomerId) {
    throw new SendStatementError(
      "qbo_failed",
      `customer ${customerId} is not linked to a QBO customer; sync first`,
    );
  }

  const openInvoices = await db
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.customerId, customerId), gt(invoices.balance, "0")),
    )
    .orderBy(asc(invoices.issueDate));

  if (openInvoices.length === 0) {
    throw new SendStatementError(
      "no_open_invoices",
      "no open invoices to send",
    );
  }
  if (openInvoices.length > MAX_INVOICES_PER_SEND) {
    throw new SendStatementError(
      "too_many_invoices",
      `too many open invoices (${openInvoices.length}); cap is ${MAX_INVOICES_PER_SEND}`,
    );
  }

  // Fail fast before any QBO/Gmail work if the seed slug is missing.
  const templateRows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, STATEMENT_TEMPLATE_SLUG))
    .limit(1);
  const template = templateRows[0];
  if (!template) {
    throw new SendStatementError(
      "template_not_found",
      `email template '${STATEMENT_TEMPLATE_SLUG}' not found — run scripts/seed-email-templates.ts`,
    );
  }

  // InvoiceLinks + credit memos are independent QBO calls; user-name is
  // a local DB read. Run all three in parallel — the slowest path
  // through this section is whichever QBO call takes longest.
  const qbInvoiceIds = openInvoices.map((i) => i.qbInvoiceId);
  const qb = new QboClient();
  let invoiceLinks: Map<string, string>;
  let creditMemos: StatementCreditMemoRow[];
  let userName: string | null;
  try {
    [invoiceLinks, creditMemos, userName] = await Promise.all([
      fetchInvoiceLinks(qbInvoiceIds),
      fetchUnappliedCreditMemos(customer.qbCustomerId),
      loadUserName(userId),
    ]);
  } catch (err) {
    if (err instanceof SendStatementError) throw err;
    throw new SendStatementError(
      "qbo_failed",
      err instanceof Error ? err.message : "QBO lookup failed",
    );
  }

  const statementInvoiceRows: StatementInvoiceRow[] = openInvoices.map(
    (inv) => ({
      qbInvoiceId: inv.qbInvoiceId,
      docNumber: inv.docNumber,
      issueDate: isoDate(inv.issueDate),
      dueDate: isoDate(inv.dueDate),
      total: inv.total,
      balance: inv.balance,
      invoiceLink: invoiceLinks.get(inv.qbInvoiceId) ?? null,
    }),
  );
  const statementTableHtml = renderStatementTable({
    customer: { displayName: customer.displayName },
    openInvoices: statementInvoiceRows,
    creditMemos,
    now,
  });

  const baseVars = buildTemplateVars({
    customer: {
      displayName: customer.displayName,
      primaryEmail: customer.primaryEmail,
      balance: customer.balance,
      overdueBalance: customer.overdueBalance,
    },
    openInvoices,
    user: { name: userName },
    now,
  });
  const renderedSubject = renderTemplate(template.subject, baseVars);
  const renderedBody = renderTemplate(template.body, {
    ...baseVars,
    statement_table: statementTableHtml,
  });

  // 5 in parallel keeps the QBO rate budget healthy alongside the
  // InvoiceLink + credit memo queries already in flight.
  type FetchedPdf = {
    qbInvoiceId: string;
    docNumber: string | null;
    buffer: Buffer;
  };
  let pdfs: FetchedPdf[];
  try {
    pdfs = await mapWithLimit(
      openInvoices,
      PDF_FETCH_CONCURRENCY,
      async (inv) => {
        const buffer = await qb.getPdf("invoice", inv.qbInvoiceId);
        return {
          qbInvoiceId: inv.qbInvoiceId,
          docNumber: inv.docNumber,
          buffer,
        };
      },
    );
  } catch (err) {
    log.error(
      { err, customerId, qbCustomerId: customer.qbCustomerId },
      "qbo pdf fetch failed",
    );
    throw new SendStatementError(
      "qbo_failed",
      `failed to fetch invoice PDFs: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  // CC excludes the primary address (case-insensitive) so the customer
  // never gets two copies. BCC = accounts@ so the user has a record.
  const primaryEmailLower = customer.primaryEmail.toLowerCase();
  const ccList = (customer.billingEmails ?? []).filter(
    (e) => e && e.toLowerCase() !== primaryEmailLower,
  );
  const to = customer.primaryEmail;
  const cc = joinAddresses(ccList);
  const bcc = STATEMENT_ALIAS;

  const attachments = pdfs.map((p) => ({
    filename: pdfFilename(p.docNumber, p.qbInvoiceId),
    mimeType: "application/pdf",
    data: p.buffer,
  }));
  let sendResult: Awaited<ReturnType<typeof sendEmail>>;
  try {
    sendResult = await sendEmail({
      to,
      cc: cc ?? undefined,
      bcc,
      subject: renderedSubject,
      html: renderedBody,
      text: "(plain text fallback — see HTML)",
      alias: STATEMENT_ALIAS,
      attachments,
    });
  } catch (err) {
    log.error(
      {
        err,
        customerId,
        to,
        cc: cc ?? null,
        invoiceCount: openInvoices.length,
      },
      "gmail send failed for statement",
    );
    throw new SendStatementError(
      "send_failed",
      err instanceof Error ? err.message : "send failed",
    );
  }

  const sentAt = new Date();
  const statementSendId = nanoid(24);
  const totalOpenBalance = statementInvoiceRows.reduce(
    (acc, r) => acc + parseAmount(r.balance),
    0,
  );
  const totalOverdueBalance = calcOverdue(openInvoices, now);

  await db.insert(statementSends).values({
    id: statementSendId,
    customerId,
    sentAt,
    sentByUserId: userId,
    sentToEmail: to,
    qboResponse: {
      invoiceLinkCount: invoiceLinks.size,
      creditMemoCount: creditMemos.length,
      pdfCount: pdfs.length,
      messageId: sendResult.messageId,
      threadId: sendResult.threadId,
    },
    statementType: "open_items",
  });

  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "statement.send",
    entityType: "statement_send",
    entityId: statementSendId,
    before: null,
    after: {
      customerId,
      to,
      cc: cc ?? null,
      bcc,
      subject: renderedSubject,
      alias: STATEMENT_ALIAS,
      messageId: sendResult.messageId,
      threadId: sendResult.threadId,
      openInvoiceCount: openInvoices.length,
      totalOpenBalance: formatMoney(totalOpenBalance),
      totalOverdueBalance: formatMoney(totalOverdueBalance),
      creditMemoCount: creditMemos.length,
      attachmentCount: attachments.length,
    },
  });

  await recordActivity({
    customerId,
    kind: "qbo_statement_sent",
    source: "user_action",
    userId,
    occurredAt: sentAt,
    subject: renderedSubject,
    refType: "statement_send",
    refId: statementSendId,
    meta: {
      to,
      cc: cc ?? null,
      bcc,
      alias: STATEMENT_ALIAS,
      messageId: sendResult.messageId,
      threadId: sendResult.threadId,
      openInvoiceCount: openInvoices.length,
      totalOpenBalance,
      totalOverdueBalance,
      creditMemoCount: creditMemos.length,
      attachmentCount: attachments.length,
    },
  });

  log.info(
    {
      statementSendId,
      customerId,
      userId,
      to,
      cc: cc ?? null,
      bcc,
      messageId: sendResult.messageId,
      openInvoiceCount: openInvoices.length,
      totalOpenBalance,
      totalOverdueBalance,
      attachmentCount: attachments.length,
    },
    "statement sent",
  );

  return {
    statementSendId,
    sent: { to, cc, bcc },
    openInvoiceCount: openInvoices.length,
    totalOpenBalance: Math.round(totalOpenBalance * 100) / 100,
    totalOverdueBalance,
    sentAt: sentAt.toISOString(),
    messageId: sendResult.messageId,
  };
}

function pdfFilename(
  docNumber: string | null,
  qbInvoiceId: string,
): string {
  // Sanitize: keep alphanumerics, dashes, underscores. QBO doc numbers
  // are normally well-behaved (digits + optional `-SP` suffix) but we
  // strip aggressively in case anyone ever gets creative with a
  // template suffix that includes spaces / quotes.
  const base = (docNumber ?? `invoice-${qbInvoiceId}`).replace(
    /[^a-zA-Z0-9_-]+/g,
    "_",
  );
  return `${base}.pdf`;
}

// Pull `name` from the auth user so the email signature reflects the
// operator who hit Send. Returns null when missing — buildTemplateVars
// accepts that and renders an empty {{user_name}}.
async function loadUserName(userId: string): Promise<string | null> {
  const rows = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.name ?? null;
}
