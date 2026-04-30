// Statement-of-account send orchestrator.
//
// Flow:
//   1. Load customer + open invoices from our own DB
//   2. Pull each invoice's QBO InvoiceLink (Pay-now URL, requires
//      `?include=invoiceLink` on the QBO query path) — populated when
//      QBO Payments is enabled for the invoice
//   3. Pull the customer's unapplied credit memos from QBO
//   4. Atomically allocate the next statement number from app_settings
//      (`statement_number_next`) inside a transaction
//   5. Resolve the `statement_open_items` email template (subject + body)
//      and load the AppSettingsMap for the PDF renderer
//   6. Render a single Statement.pdf via @react-pdf/renderer (replaces
//      the old per-invoice PDF attachments — pay-now links live inside
//      the PDF now)
//   7. Send via gmail/send.ts with To = customer.primary_email,
//      CC = billing emails minus primary, BCC = accounts@feldart.com
//      so the user gets a record copy, alias = accounts@feldart.com
//   8. Insert statement_sends row (with statementNumber), emit
//      qbo_statement_sent activity, audit-log
//
// What this module does NOT do:
//   - Modify the QBO client. The brief locks src/integrations/qb/client.ts.
//     Direct HTTP for the InvoiceLink + credit-memo queries reuses the
//     encrypted token store from integrations/qb/tokens.ts so OAuth
//     state never leaks into this module.
//   - Render HTML email tables. The Statement PDF is the deliverable;
//     the email body is short prose from the template and the
//     {{statement_table}} placeholder is intentionally rendered as
//     empty so legacy templates don't blow up.

import axios, { type AxiosError } from "axios";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { appSettings } from "../../db/schema/app-settings.js";
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
  renderStatementPdf,
  type StatementCreditMemoInput,
  type StatementInvoiceInput,
} from "./pdf.js";
import { loadAppSettings, type AppSettingsMap } from "./settings.js";

const log = createLogger({ module: "statements.send" });

const STATEMENT_TEMPLATE_SLUG = "statement_open_items";
const STATEMENT_ALIAS = "accounts@feldart.com";
const QBO_MINOR_VERSION = 65;
const QBO_PROD = "https://quickbooks.api.intuit.com";
// Hard cap on how many invoices a single statement renders. Above this
// the PDF would paginate uncomfortably and the send would balloon. Same
// cap as the legacy per-invoice attach flow.
const MAX_INVOICES_PER_SEND = 50;

export type ManagerInput = {
  customerId: string;
  userId: string;
};

export type SendStatementResult = {
  statementSendId: string;
  statementNumber: number;
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
    | "send_failed"
    | "render_failed";
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
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
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
// the rest server-side so this is a single round-trip. Returns the
// shape consumed by the PDF renderer.
async function fetchUnappliedCreditMemos(
  qbCustomerId: string,
): Promise<StatementCreditMemoInput[]> {
  const safeId = qbCustomerId.replace(/'/g, "''");
  const data = await qboQuery<{
    QueryResponse: { CreditMemo?: QboCreditMemoRow[] };
  }>({
    query: `SELECT * FROM CreditMemo WHERE CustomerRef = '${safeId}' AND Balance > '0'`,
  });
  const rows: StatementCreditMemoInput[] = [];
  for (const cm of data.QueryResponse.CreditMemo ?? []) {
    rows.push({
      qbId: cm.Id,
      docNumber: cm.DocNumber ?? null,
      txnDate: cm.TxnDate ?? null,
      balance: cm.Balance ?? 0,
      description: cm.CustomerMemo?.value ?? cm.PrivateNote ?? null,
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
    // Drizzle returns `date` columns as Date | null. Normalize to a
    // YYYY-MM-DD string locally rather than reaching for a shared
    // helper; the calc is small enough.
    let dueIso: string | null = null;
    if (inv.dueDate instanceof Date) {
      if (!Number.isNaN(inv.dueDate.getTime())) {
        dueIso = inv.dueDate.toISOString().slice(0, 10);
      }
    } else {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(inv.dueDate);
      dueIso = m ? `${m[1]}-${m[2]}-${m[3]}` : inv.dueDate;
    }
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

  // InvoiceLinks + credit memos are independent QBO calls; user-name +
  // app-settings are local DB reads. Run them all in parallel — the
  // slowest path is whichever QBO call takes longest.
  const qbInvoiceIds = openInvoices.map((i) => i.qbInvoiceId);
  let invoiceLinks: Map<string, string>;
  let creditMemos: StatementCreditMemoInput[];
  let userName: string | null;
  let settings: AppSettingsMap;
  try {
    [invoiceLinks, creditMemos, userName, settings] = await Promise.all([
      fetchInvoiceLinks(qbInvoiceIds),
      fetchUnappliedCreditMemos(customer.qbCustomerId),
      loadUserName(userId),
      loadAppSettings(),
    ]);
  } catch (err) {
    if (err instanceof SendStatementError) throw err;
    throw new SendStatementError(
      "qbo_failed",
      err instanceof Error ? err.message : "QBO lookup failed",
    );
  }

  // Atomically allocate the next statement number. MySQL has no
  // RETURNING; we wrap a SELECT...FOR UPDATE + UPDATE in a transaction
  // so concurrent sends never collide on the same number. If the row
  // doesn't exist yet (fresh install) we seed it at 1 and use that.
  let statementNumber: number;
  try {
    statementNumber = await allocateNextStatementNumber();
  } catch (err) {
    log.error({ err, customerId }, "statement number allocation failed");
    throw new SendStatementError(
      "send_failed",
      err instanceof Error
        ? `statement number allocation failed: ${err.message}`
        : "statement number allocation failed",
    );
  }

  // Hydrate the open invoices with their QBO Pay-now URLs (where
  // available) for the PDF renderer.
  const statementInvoices: StatementInvoiceInput[] = openInvoices.map(
    (inv) => ({
      ...inv,
      invoiceLink: invoiceLinks.get(inv.qbInvoiceId) ?? null,
    }),
  );

  // Build the email subject + body. The template's {{statement_table}}
  // placeholder is now resolved to an empty string — the table lives
  // inside the attached PDF, the email body is short prose only.
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
    statement_table: "",
  });

  // Render the single Statement.pdf — replaces the per-invoice PDF
  // attach loop in the previous flow. The renderer reads the logo from
  // disk; if it's missing we silently skip rather than crashing the
  // send.
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderStatementPdf({
      customer,
      openInvoices: statementInvoices,
      creditMemos,
      settings,
      statementNumber,
      generatedAt: now,
    });
  } catch (err) {
    log.error(
      { err, customerId, statementNumber },
      "statement PDF render failed",
    );
    throw new SendStatementError(
      "render_failed",
      err instanceof Error
        ? `statement PDF render failed: ${err.message}`
        : "statement PDF render failed",
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

  const filename = `Statement_${sanitizeFilenameSegment(customer.displayName)}_${statementNumber}.pdf`;
  const attachments = [
    {
      filename,
      mimeType: "application/pdf",
      data: pdfBuffer,
    },
  ];

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
        statementNumber,
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
  const totalOpenBalance = openInvoices.reduce(
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
    statementNumber,
    qboResponse: {
      invoiceLinkCount: invoiceLinks.size,
      creditMemoCount: creditMemos.length,
      pdfBytes: pdfBuffer.byteLength,
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
      statementNumber,
      openInvoiceCount: openInvoices.length,
      totalOpenBalance: formatMoney(totalOpenBalance),
      totalOverdueBalance: formatMoney(totalOverdueBalance),
      creditMemoCount: creditMemos.length,
      attachmentName: filename,
      attachmentBytes: pdfBuffer.byteLength,
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
      statementNumber,
      openInvoiceCount: openInvoices.length,
      totalOpenBalance,
      totalOverdueBalance,
      creditMemoCount: creditMemos.length,
      attachmentName: filename,
    },
  });

  log.info(
    {
      statementSendId,
      statementNumber,
      customerId,
      userId,
      to,
      cc: cc ?? null,
      bcc,
      messageId: sendResult.messageId,
      openInvoiceCount: openInvoices.length,
      totalOpenBalance,
      totalOverdueBalance,
      attachmentBytes: pdfBuffer.byteLength,
    },
    "statement sent",
  );

  return {
    statementSendId,
    statementNumber,
    sent: { to, cc, bcc },
    openInvoiceCount: openInvoices.length,
    totalOpenBalance: Math.round(totalOpenBalance * 100) / 100,
    totalOverdueBalance,
    sentAt: sentAt.toISOString(),
    messageId: sendResult.messageId,
  };
}

// Sanitize a string for use inside a filename. Keeps alphanumerics,
// underscores, dashes; collapses everything else to "_". Trims leading/
// trailing underscores and clips to 80 chars so the resulting filename
// stays under most email-client display widths.
function sanitizeFilenameSegment(s: string): string {
  const cleaned = s
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 80) || "customer";
}

// Allocate the next statement number atomically. MySQL doesn't have
// RETURNING for UPDATE; we use a transaction with SELECT...FOR UPDATE
// to lock the row, then UPDATE to bump the counter, then return the
// pre-bump value. Auto-seeds the row at 1 if not present.
async function allocateNextStatementNumber(): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock the row.
    const rows = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, "statement_number_next"))
      .for("update");
    let current: number;
    if (rows.length === 0) {
      // Seed if missing — first statement on this install. Insert with
      // value=2 so the next allocator returns 2 (we use 1 for this send).
      await tx.insert(appSettings).values({
        key: "statement_number_next",
        value: "2",
      });
      return 1;
    }
    const raw = rows[0]!.value;
    const parsed = parseInt(raw ?? "", 10);
    current = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    const next = current + 1;
    await tx
      .update(appSettings)
      .set({
        value: String(next),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(appSettings.key, "statement_number_next"));
    return current;
  });
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
