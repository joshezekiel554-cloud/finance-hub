// GET /api/customers/:id/statement-pdf-preview — stream the rendered
// Statement PDF for a customer.
//
// "Preview" means we don't increment the statement_number_next counter
// and we don't insert a statement_sends row. The user can preview as
// many times as they want before the actual send (which DOES increment
// + persist). The current value of statement_number_next is shown in
// the preview so the operator sees what number the eventual send will
// allocate.
//
// Auth-gated. The same data load + cap as the actual send route, just
// without the QBO+Gmail side effects. QBO InvoiceLink lookup is best-
// effort: a failure renders a PDF without payment hyperlinks rather
// than 502'ing the preview, so the user can still inspect the layout
// when QBO is flaky.
//
// Mounting: team-lead registers under `/api/customers` (mirrors the
// statement-send + holds + statement-preview routes). The :id segment
// matches a customers.id.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import axios, { type AxiosError } from "axios";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { QboClient } from "../../integrations/qb/client.js";
import { loadQbTokens } from "../../integrations/qb/tokens.js";
import { requireAuth } from "../lib/auth.js";
import {
  booksForOrigin,
  buildBookSections,
  loadAppSettings,
  loadOpenInvoicesByBook,
  renderStatementPdf,
  scopeCreditMemosByBook,
  type StatementCreditMemoInput,
  type StatementInvoiceInput,
} from "../../modules/statements/index.js";

const log = createLogger({ component: "routes.statement-pdf-preview" });

const paramsSchema = z.object({
  id: z.string().min(1).max(64),
});

// Mirrors the cap on actual sends so the preview never previews a
// payload the send would refuse. Keeping these in sync via a literal
// number copy rather than re-importing from send.ts because the brief
// keeps inter-module coupling thin.
const PREVIEW_INVOICE_CAP = 50;
const QBO_PROD = "https://quickbooks.api.intuit.com";
const QBO_MINOR_VERSION = 65;

const statementPdfPreviewRoute: FastifyPluginAsync = async (app) => {
  app.get("/:id/statement-pdf-preview", async (req, reply) => {
    await requireAuth(req);
    const parse = paramsSchema.safeParse(req.params);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid params", details: parse.error.flatten() });
    }
    const { id: customerId } = parse.data;
    // Book scope — required, same contract as the send + preview routes.
    // "both" renders the combined two-box statement.
    const queryParse = z
      .object({
        origin: z.enum(["feldart", "tj", "both"], {
          errorMap: () => ({
            message:
              "origin is required and must be 'feldart', 'tj' or 'both'",
          }),
        }),
      })
      .safeParse(req.query ?? {});
    if (!queryParse.success) {
      return reply.code(400).send({
        error: "invalid query",
        details: queryParse.error.flatten(),
      });
    }
    const { origin } = queryParse.data;

    // Load customer.
    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const customer = customerRows[0];
    if (!customer) {
      return reply.code(404).send({ error: "customer not found" });
    }

    // Load open invoices per book (shared loader with the send path so
    // the previewed PDF can never disagree with the sent one), then cap
    // the combined list. The per-book map is re-filtered to the capped
    // set so a truncated "both" preview stays internally consistent.
    const invoicesByBook = await loadOpenInvoicesByBook(customerId, origin);
    const combined = booksForOrigin(origin).flatMap(
      (b) => invoicesByBook.get(b) ?? [],
    );
    const previewInvoices = combined.slice(0, PREVIEW_INVOICE_CAP);
    const includedIds = new Set(previewInvoices.map((r) => r.id));
    for (const [book, rows] of invoicesByBook) {
      invoicesByBook.set(
        book,
        rows.filter((r) => includedIds.has(r.id)),
      );
    }

    // Load app settings.
    const settings = await loadAppSettings();

    // Statement number: use the configured next-value WITHOUT
    // incrementing. Falls back to "0" if the value is non-numeric or
    // missing — the preview still renders, just with a placeholder
    // number, and the user can fix the setting.
    const previewNumber = parseInt(settings.statement_number_next, 10);
    const statementNumber = Number.isFinite(previewNumber) ? previewNumber : 0;

    // Best-effort InvoiceLink lookup. If QBO is reachable we get the
    // pay-now URL per invoice; if not, render plain text.
    let invoiceLinks: Map<string, string> = new Map();
    if (customer.qbCustomerId && previewInvoices.length > 0) {
      try {
        invoiceLinks = await fetchInvoiceLinks(
          previewInvoices.map((r) => r.qbInvoiceId),
        );
      } catch (err) {
        log.warn(
          { err, customerId },
          "preview InvoiceLink lookup failed; rendering without pay links",
        );
      }
    }

    // Best-effort credit-memo lookup. Same fallback policy.
    let creditMemos: StatementCreditMemoInput[] = [];
    if (customer.qbCustomerId) {
      try {
        creditMemos = await fetchUnappliedCreditMemos(customer.qbCustomerId);
      } catch (err) {
        log.warn(
          { err, customerId, qbCustomerId: customer.qbCustomerId },
          "preview credit-memo lookup failed; rendering without credits",
        );
      }
    }

    // Scope credits to the requested book(s) — same classification the
    // send path applies, so the preview matches what would go out.
    const creditsByBook = await scopeCreditMemosByBook(creditMemos);
    const scopedCreditMemos = booksForOrigin(origin).flatMap(
      (b) => creditsByBook.get(b) ?? [],
    );

    const hydrate = (inv: (typeof previewInvoices)[number]) => ({
      ...inv,
      invoiceLink: invoiceLinks.get(inv.qbInvoiceId) ?? null,
    });
    const statementInvoices: StatementInvoiceInput[] =
      previewInvoices.map(hydrate);
    const books = buildBookSections(
      origin,
      invoicesByBook,
      creditsByBook,
      hydrate,
    );

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await renderStatementPdf({
        customer,
        openInvoices: statementInvoices,
        creditMemos: scopedCreditMemos,
        settings,
        statementNumber,
        books,
      });
    } catch (err) {
      log.error({ err, customerId }, "statement PDF render failed");
      return reply.code(500).send({ error: "render failed" });
    }

    return reply
      .code(200)
      .header("Content-Type", "application/pdf")
      .header("Content-Length", pdfBuffer.byteLength.toString())
      .header(
        "Content-Disposition",
        `inline; filename="Statement_preview.pdf"`,
      )
      .send(pdfBuffer);
  });
};

// QBO query helper — same shape as the one in modules/statements/send.ts.
// Duplicated because the brief locks the statements module's send route
// to the team-lead and prefers thin per-route HTTP wrappers over reach-
// across imports for module-internal helpers. 401 → bounce off
// QboClient.getTerms() to trigger the single-flight refresh.
type QboInvoiceWithLink = { Id: string; InvoiceLink?: string };

async function fetchInvoiceLinks(
  qbInvoiceIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (qbInvoiceIds.length === 0) return map;

  const realmId = env.QB_REALM_ID;
  const tokens = await loadQbTokens(realmId);
  if (!tokens) throw new Error(`No QB tokens for realm ${realmId}`);

  const url = `${QBO_PROD}/v3/company/${realmId}/query`;
  const CHUNK = 200;

  for (let i = 0; i < qbInvoiceIds.length; i += CHUNK) {
    const chunk = qbInvoiceIds.slice(i, i + CHUNK);
    const inClause = chunk
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(",");
    // QBO QL rejects `SELECT Id, InvoiceLink` with
    // "QueryValidationError: Property InvoiceLink not found for Entity
    // Invoice" — InvoiceLink is a system-generated field exposed only via
    // ?include=invoiceLink and only on full-row selects. SELECT * returns
    // every invoice column plus the link. Verified empirically; the
    // overhead vs. SELECT Id is negligible for our row counts.
    const params: Record<string, string | number> = {
      query: `SELECT * FROM Invoice WHERE Id IN (${inClause})`,
      minorversion: QBO_MINOR_VERSION,
      include: "invoiceLink",
    };

    const doRequest = async (token: string) =>
      axios.get<{
        QueryResponse: { Invoice?: QboInvoiceWithLink[] };
      }>(url, {
        params,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        timeout: 30_000,
      });

    let res;
    try {
      res = await doRequest(tokens.accessToken);
    } catch (err) {
      const ax = err as AxiosError;
      if (ax.response?.status === 401) {
        const qb = new QboClient();
        try {
          await qb.getTerms();
        } catch {
          // ignore — we just want the refresh side effect
        }
        const fresh = await loadQbTokens(realmId);
        if (!fresh) throw new Error("QB tokens disappeared mid-refresh");
        res = await doRequest(fresh.accessToken);
      } else {
        throw err;
      }
    }
    for (const inv of res.data.QueryResponse.Invoice ?? []) {
      if (inv.Id && inv.InvoiceLink) map.set(inv.Id, inv.InvoiceLink);
    }
  }
  return map;
}

type QboCreditMemoRow = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Balance?: number;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
};

async function fetchUnappliedCreditMemos(
  qbCustomerId: string,
): Promise<StatementCreditMemoInput[]> {
  const realmId = env.QB_REALM_ID;
  const tokens = await loadQbTokens(realmId);
  if (!tokens) throw new Error(`No QB tokens for realm ${realmId}`);

  const url = `${QBO_PROD}/v3/company/${realmId}/query`;
  const safeId = qbCustomerId.replace(/'/g, "''");
  const params: Record<string, string | number> = {
    query: `SELECT * FROM CreditMemo WHERE CustomerRef = '${safeId}' AND Balance > '0'`,
    minorversion: QBO_MINOR_VERSION,
  };

  const doRequest = async (token: string) =>
    axios.get<{
      QueryResponse: { CreditMemo?: QboCreditMemoRow[] };
    }>(url, {
      params,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      timeout: 30_000,
    });

  let res;
  try {
    res = await doRequest(tokens.accessToken);
  } catch (err) {
    const ax = err as AxiosError;
    if (ax.response?.status === 401) {
      const qb = new QboClient();
      try {
        await qb.getTerms();
      } catch {
        // ignore — we just want the refresh side effect
      }
      const fresh = await loadQbTokens(realmId);
      if (!fresh) throw new Error("QB tokens disappeared mid-refresh");
      res = await doRequest(fresh.accessToken);
    } else {
      throw err;
    }
  }

  const rows: StatementCreditMemoInput[] = [];
  for (const cm of res.data.QueryResponse.CreditMemo ?? []) {
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

export default statementPdfPreviewRoute;
