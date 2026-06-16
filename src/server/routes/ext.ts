// /api/ext — the service-to-service READ API consumed by the sibling Inbox app
// (spec docs/superpowers/specs/2026-06-16-inbox-integration-design.md §3.1 / §5a).
//
// READ-ONLY. No writes. Every route is gated by guardServiceRequest (bearer
// token + the inbox_integration_enabled flag). Inbox calls these server-side
// over loopback (http://127.0.0.1:3001/api/ext); the public nginx vhost denies
// /api/ext so it is not internet-reachable.
//
// Wire contract (frozen): camelCase keys, money as decimal STRINGS, dates as
// YYYY-MM-DD strings, bare arrays (unenveloped). See spec §5a.
//
// NOTE on the two QBO helpers at the bottom: they intentionally mirror the
// copies in statements/send.ts and statement-pdf-preview.ts. The repo's
// established convention is thin per-route QBO wrappers over reach-across
// imports of module internals; this keeps /api/ext fully isolated and
// reversible (delete this file = feature gone). A future dedup into a shared
// statements/qbo-statement-data module is noted in the spec's open items.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import axios, { type AxiosError } from "axios";
import { db } from "../../db/index.js";
import { customers, type Customer } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { QboClient } from "../../integrations/qb/client.js";
import { loadQbTokens } from "../../integrations/qb/tokens.js";
import { guardServiceRequest } from "../lib/service-auth.js";
import {
  buildOpenInvoiceConditions,
  loadAppSettings,
  renderStatementPdf,
  type StatementCreditMemoInput,
  type StatementInvoiceInput,
} from "../../modules/statements/index.js";

const log = createLogger({ component: "routes.ext" });

const QBO_PROD = "https://quickbooks.api.intuit.com";
const QBO_MINOR_VERSION = 65;
const STATEMENT_INVOICE_CAP = 50; // mirrors the send/preview cap

// Per-route rate-limit: interactive use is light; this caps a misbehaving
// caller without throttling normal traffic. (@fastify/rate-limit reads this
// from route config.)
const extRateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

// ── small formatters ───────────────────────────────────────────────────────

// Normalize any decimal/number to a 2dp string ("1234.56"). DB decimal columns
// already arrive as strings; this guards computed sums + keeps the wire shape
// uniform.
function money(v: string | number | null | undefined): string {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return (Math.round((safe + Number.EPSILON) * 100) / 100).toFixed(2);
}

// Date column → "YYYY-MM-DD" | null (drizzle may hand back Date or string).
function isoDate(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// The set of addresses that IDENTIFY a customer (primary + billing + the "to"
// lists). CC/BCC are routing extras, not identity, so they're excluded.
// Deduped + lowercased.
function customerEmails(c: Customer): string[] {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => {
    if (e && e.trim()) out.add(e.trim().toLowerCase());
  };
  add(c.primaryEmail);
  for (const arr of [c.billingEmails, c.invoiceToEmails, c.statementToEmails]) {
    if (Array.isArray(arr)) for (const e of arr) add(e);
  }
  return [...out];
}

type Origin = "feldart" | "tj";

// Which books a customer has an OPEN balance in (invoices.balance > 0).
async function openOriginsForCustomer(customerId: string): Promise<Origin[]> {
  const rows = await db
    .select({ origin: invoices.origin })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), gt(invoices.balance, "0")))
    .groupBy(invoices.origin);
  return rows.map((r) => r.origin as Origin);
}

// ── routes ───────────────────────────────────────────────────────────────

const extRoute: FastifyPluginAsync = async (app) => {
  // 1. Identity-sync feed: every customer with id + name + email-set + which
  //    books have an open balance.
  app.get("/customers", { config: extRateLimit }, async (req, reply) => {
    if (!(await guardServiceRequest(req, reply, env.FINANCE_SERVICE_TOKEN)))
      return;

    const [rows, openRows] = await Promise.all([
      db.select().from(customers),
      db
        .select({ customerId: invoices.customerId, origin: invoices.origin })
        .from(invoices)
        .where(gt(invoices.balance, "0"))
        .groupBy(invoices.customerId, invoices.origin),
    ]);

    const openByCustomer = new Map<string, Set<Origin>>();
    for (const r of openRows) {
      const set = openByCustomer.get(r.customerId) ?? new Set<Origin>();
      set.add(r.origin as Origin);
      openByCustomer.set(r.customerId, set);
    }

    return rows.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      emails: customerEmails(c),
      openOrigins: [...(openByCustomer.get(c.id) ?? [])],
    }));
  });

  // 2. Customer detail: balances + terms + per-book breakdown.
  app.get("/customers/:id", { config: extRateLimit }, async (req, reply) => {
    if (!(await guardServiceRequest(req, reply, env.FINANCE_SERVICE_TOKEN)))
      return;
    const parse = z
      .object({ id: z.string().min(1).max(64) })
      .safeParse(req.params);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid params" });
    }
    const { id } = parse.data;

    const rows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const c = rows[0];
    if (!c) return reply.code(404).send({ error: "customer not found" });

    // Per-book open balance + overdue, mirroring the customer-detail KPI math:
    // GREATEST(0, open invoices − unapplied credit memos), per origin.
    const [invSums, cmSums] = await Promise.all([
      db
        .select({
          origin: invoices.origin,
          bal: sql<string>`COALESCE(SUM(${invoices.balance}),0)`,
          overdue: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.dueDate} IS NOT NULL AND ${invoices.dueDate} < CURRENT_DATE THEN ${invoices.balance} ELSE 0 END),0)`,
        })
        .from(invoices)
        .where(and(eq(invoices.customerId, id), gt(invoices.balance, "0")))
        .groupBy(invoices.origin),
      db
        .select({
          origin: creditMemos.origin,
          bal: sql<string>`COALESCE(SUM(${creditMemos.balance}),0)`,
        })
        .from(creditMemos)
        .where(and(eq(creditMemos.customerId, id), gt(creditMemos.balance, "0")))
        .groupBy(creditMemos.origin),
    ]);

    const invByOrigin = new Map(invSums.map((r) => [r.origin as Origin, r]));
    const cmByOrigin = new Map(cmSums.map((r) => [r.origin as Origin, r]));
    const perBookFor = (o: Origin) => {
      const inv = invByOrigin.get(o);
      const cmBal = Number(cmByOrigin.get(o)?.bal ?? 0);
      const bal = Math.max(0, Number(inv?.bal ?? 0) - cmBal);
      const overdue = Math.max(0, Number(inv?.overdue ?? 0) - cmBal);
      return { balance: money(bal), overdueBalance: money(overdue) };
    };
    const openOrigins = (["feldart", "tj"] as Origin[]).filter(
      (o) => Number(invByOrigin.get(o)?.bal ?? 0) > 0,
    );

    return {
      id: c.id,
      displayName: c.displayName,
      emails: customerEmails(c),
      balance: money(c.balance),
      overdueBalance: money(c.overdueBalance),
      unappliedCredit: money(c.unappliedCreditBalance),
      paymentTerms: c.paymentTerms ?? null,
      openOrigins,
      perBook: { feldart: perBookFor("feldart"), tj: perBookFor("tj") },
    };
  });

  // 3. Invoices for a customer (optionally only those with an open balance).
  app.get(
    "/customers/:id/invoices",
    { config: extRateLimit },
    async (req, reply) => {
      if (!(await guardServiceRequest(req, reply, env.FINANCE_SERVICE_TOKEN)))
        return;
      const parse = z
        .object({ id: z.string().min(1).max(64) })
        .safeParse(req.params);
      if (!parse.success)
        return reply.code(400).send({ error: "invalid params" });
      const { id } = parse.data;
      const openOnly =
        z
          .object({ openOnly: z.string().optional() })
          .safeParse(req.query ?? {})
          .data?.openOnly === "1";

      const cond = openOnly
        ? and(eq(invoices.customerId, id), gt(invoices.balance, "0"))
        : eq(invoices.customerId, id);
      const rows = await db
        .select({
          id: invoices.id,
          qbInvoiceId: invoices.qbInvoiceId,
          docNumber: invoices.docNumber,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          total: invoices.total,
          balance: invoices.balance,
          status: invoices.status,
          origin: invoices.origin,
          disputeState: invoices.disputeState,
        })
        .from(invoices)
        .where(cond)
        .orderBy(asc(invoices.issueDate))
        .limit(200);

      return rows.map((r) => ({
        id: r.id,
        qbInvoiceId: r.qbInvoiceId,
        docNumber: r.docNumber ?? null,
        issueDate: isoDate(r.issueDate),
        dueDate: isoDate(r.dueDate),
        total: money(r.total),
        balance: money(r.balance),
        status: r.status ?? null,
        origin: r.origin,
        disputeState: r.disputeState ?? null,
      }));
    },
  );

  // 4. Invoice PDF — proxied live from QBO (mirrors /api/qb-pdf).
  app.get(
    "/invoices/:qbInvoiceId/pdf",
    { config: extRateLimit },
    async (req, reply) => {
      if (!(await guardServiceRequest(req, reply, env.FINANCE_SERVICE_TOKEN)))
        return;
      const parse = z
        .object({ qbInvoiceId: z.string().regex(/^\d+$/).max(32) })
        .safeParse(req.params);
      if (!parse.success)
        return reply.code(400).send({ error: "invalid params" });
      const { qbInvoiceId } = parse.data;
      try {
        const qb = new QboClient();
        const buffer = await qb.getPdf("invoice", qbInvoiceId);
        return reply
          .code(200)
          .header("Content-Type", "application/pdf")
          .header("Content-Length", buffer.byteLength.toString())
          .header(
            "Content-Disposition",
            `inline; filename="invoice-${qbInvoiceId}.pdf"`,
          )
          .send(buffer);
      } catch (err) {
        log.error({ err, qbInvoiceId }, "ext invoice pdf proxy failed");
        return reply.code(502).send({ error: "qb pdf fetch failed" });
      }
    },
  );

  // 5. Statement PDF — rendered on demand from Finance's own data. Keyed by the
  //    Finance customer id. origin optional: resolved to the single open book
  //    when omitted; 400 if ambiguous (both open) or invalid.
  app.get(
    "/customers/:id/statement.pdf",
    { config: extRateLimit },
    async (req, reply) => {
      if (!(await guardServiceRequest(req, reply, env.FINANCE_SERVICE_TOKEN)))
        return;
      const parse = z
        .object({ id: z.string().min(1).max(64) })
        .safeParse(req.params);
      if (!parse.success)
        return reply.code(400).send({ error: "invalid params" });
      const { id } = parse.data;
      const originParse = z
        .object({ origin: z.enum(["feldart", "tj"]).optional() })
        .safeParse(req.query ?? {});
      if (!originParse.success)
        return reply.code(400).send({ error: "origin required" });

      const custRows = await db
        .select()
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1);
      const customer = custRows[0];
      if (!customer)
        return reply.code(404).send({ error: "customer not found" });

      // Resolve origin: explicit wins; else the single open book; else 400.
      let origin: Origin | undefined = originParse.data.origin;
      if (!origin) {
        const open = await openOriginsForCustomer(id);
        const sole = open.length === 1 ? open[0] : undefined;
        if (!sole) return reply.code(400).send({ error: "origin required" });
        origin = sole;
      }

      const openInvoiceRows = await db
        .select()
        .from(invoices)
        .where(buildOpenInvoiceConditions(id, origin))
        .orderBy(asc(invoices.issueDate))
        .limit(STATEMENT_INVOICE_CAP);

      const settings = await loadAppSettings();
      // Preview semantics: read the next statement number WITHOUT incrementing
      // (this is an attach copy, not an official "send" — logging/cadence is
      // Phase 2). Falls back to 0 on a non-numeric setting.
      const parsedNum = parseInt(settings.statement_number_next, 10);
      const statementNumber = Number.isFinite(parsedNum) ? parsedNum : 0;

      // Best-effort QBO enrichment (pay links + credit memos); never 502 the
      // statement over these — render plain on failure.
      let invoiceLinks = new Map<string, string>();
      let memos: StatementCreditMemoInput[] = [];
      if (customer.qbCustomerId && openInvoiceRows.length > 0) {
        try {
          invoiceLinks = await fetchInvoiceLinks(
            openInvoiceRows.map((r) => r.qbInvoiceId),
          );
        } catch (err) {
          log.warn({ err, id }, "ext statement: invoice-link lookup failed");
        }
      }
      if (customer.qbCustomerId) {
        try {
          memos = await fetchUnappliedCreditMemos(customer.qbCustomerId);
        } catch (err) {
          log.warn({ err, id }, "ext statement: credit-memo lookup failed");
        }
      }

      const statementInvoices: StatementInvoiceInput[] = openInvoiceRows.map(
        (inv) => ({ ...inv, invoiceLink: invoiceLinks.get(inv.qbInvoiceId) ?? null }),
      );

      try {
        const pdf = await renderStatementPdf({
          customer,
          openInvoices: statementInvoices,
          creditMemos: memos,
          settings,
          statementNumber,
        });
        return reply
          .code(200)
          .header("Content-Type", "application/pdf")
          .header("Content-Length", pdf.byteLength.toString())
          .header(
            "Content-Disposition",
            `inline; filename="Statement_${origin}.pdf"`,
          )
          .send(pdf);
      } catch (err) {
        log.error({ err, id, origin }, "ext statement render failed");
        return reply.code(500).send({ error: "render failed" });
      }
    },
  );
};

// ── QBO helpers (see file header note on intentional duplication) ───────────

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
    const inClause = chunk.map((x) => `'${x.replace(/'/g, "''")}'`).join(",");
    const params: Record<string, string | number> = {
      query: `SELECT * FROM Invoice WHERE Id IN (${inClause})`,
      minorversion: QBO_MINOR_VERSION,
      include: "invoiceLink",
    };
    const doRequest = async (token: string) =>
      axios.get<{ QueryResponse: { Invoice?: QboInvoiceWithLink[] } }>(url, {
        params,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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
          // ignore — only want the refresh side effect
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
    axios.get<{ QueryResponse: { CreditMemo?: QboCreditMemoRow[] } }>(url, {
      params,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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
        // ignore — only want the refresh side effect
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

export default extRoute;
