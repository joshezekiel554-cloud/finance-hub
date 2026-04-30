// Customers API. List + filter + bulk-tag for the B2B sweep, plus a
// per-customer GET that the detail page (Task #5) extends with related
// data (recent activities, open invoices, tasks).
//
// All routes require auth. Mutations write to audit_log via the existing
// pattern from invoicing routes — we don't have a transaction wrapper
// helper yet so writes are sequential, not atomic. Acceptable for now;
// audit-log atomicity gets a dedicated pass in week 8 alongside
// notifications fan-out.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import axios, { type AxiosError } from "axios";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { activities, emailLog } from "../../db/schema/crm.js";
import { invoices } from "../../db/schema/invoices.js";
import { auditLog } from "../../db/schema/audit.js";
import { nanoid } from "nanoid";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import { env } from "../../lib/env.js";
import { ShopifyClient } from "../../integrations/shopify/client.js";
import { pushCustomerTermsToQbo } from "../../modules/customer-terms/push-to-qbo.js";
import { listCustomersByTag } from "../../integrations/shopify/customers.js";
import { syncEmailsForCustomer } from "../../integrations/gmail/poller.js";
import { loadQbTokens } from "../../integrations/qb/tokens.js";
import { QboClient } from "../../integrations/qb/client.js";

const log = createLogger({ component: "routes.customers" });

const listQuerySchema = z.object({
  q: z.string().max(100).optional(),
  customerType: z.enum(["b2b", "b2c", "uncategorized", "all"]).default("b2b"),
  holdStatus: z.enum(["active", "hold", "all"]).default("all"),
  withBalance: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === true || v === "true"),
  sort: z
    .enum(["displayName", "balance", "overdueBalance", "lastSyncedAt"])
    .default("displayName"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  // 5000 cap covers the full customer table in a single response (we
  // have ~2,400 today). The sweep UI loads all rows so the user can
  // bulk-tag without paging — a 200-row cap would force 12 round trips
  // for a single sweep. Pagination can come back later if the dataset
  // grows past that.
  limit: z.coerce.number().int().min(1).max(5000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const bulkTagBodySchema = z.object({
  ids: z.array(z.string().min(1).max(24)).min(1).max(2500),
  customerType: z.enum(["b2b", "b2c"]).nullable(),
});

const patchBodySchema = z.object({
  customerType: z.enum(["b2b", "b2c"]).nullable().optional(),
  holdStatus: z.enum(["active", "hold"]).optional(),
  // Free-form display string ("Net 30", "Net 60", "Due on Receipt"…).
  // Not constrained to an enum — operators can write whatever the
  // customer agreement actually says, and the chase/statement flows
  // render it verbatim.
  paymentTerms: z.string().max(64).nullable().optional(),
  internalNotes: z.string().max(10_000).optional(),
});

const customersRoute: FastifyPluginAsync = async (app) => {
  // GET /api/customers — paginated list with search + filters. The
  // shape is hand-tuned for the customers table page: includes
  // counts for the filter chips and the uncategorized banner so the
  // page only needs one round trip on initial load.
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { q, customerType, holdStatus, withBalance, sort, dir, limit, offset } =
      parse.data;

    const filters = [];
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      filters.push(
        or(like(customers.displayName, term), like(customers.primaryEmail, term)),
      );
    }
    if (customerType === "b2b") filters.push(eq(customers.customerType, "b2b"));
    else if (customerType === "b2c") filters.push(eq(customers.customerType, "b2c"));
    else if (customerType === "uncategorized") filters.push(isNull(customers.customerType));
    // "all" → no filter

    if (holdStatus !== "all") {
      filters.push(eq(customers.holdStatus, holdStatus));
    }
    if (withBalance) {
      filters.push(gt(customers.balance, "0"));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const sortCol = {
      displayName: customers.displayName,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
      lastSyncedAt: customers.lastSyncedAt,
    }[sort];
    const orderFn = dir === "asc" ? asc : desc;

    const rowsPromise = db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        primaryEmail: customers.primaryEmail,
        balance: customers.balance,
        overdueBalance: customers.overdueBalance,
        holdStatus: customers.holdStatus,
        customerType: customers.customerType,
        paymentTerms: customers.paymentTerms,
        lastSyncedAt: customers.lastSyncedAt,
      })
      .from(customers)
      .where(where)
      .orderBy(orderFn(sortCol), asc(customers.id))
      .limit(limit + 1) // +1 to detect hasMore without a separate count
      .offset(offset);

    // Counts for the filter chips. Done in parallel with the rows query.
    const totalsPromise = db
      .select({
        b2b: sql<number>`SUM(CASE WHEN customer_type = 'b2b' THEN 1 ELSE 0 END)`,
        b2c: sql<number>`SUM(CASE WHEN customer_type = 'b2c' THEN 1 ELSE 0 END)`,
        uncategorized: sql<number>`SUM(CASE WHEN customer_type IS NULL THEN 1 ELSE 0 END)`,
        all: sql<number>`COUNT(*)`,
      })
      .from(customers);

    const [rowsRaw, totalsRaw] = await Promise.all([rowsPromise, totalsPromise]);
    const rows = rowsRaw.slice(0, limit);
    const hasMore = rowsRaw.length > limit;
    const totals = totalsRaw[0] ?? { b2b: 0, b2c: 0, uncategorized: 0, all: 0 };

    return reply.send({
      rows,
      hasMore,
      totals: {
        b2b: Number(totals.b2b ?? 0),
        b2c: Number(totals.b2c ?? 0),
        uncategorized: Number(totals.uncategorized ?? 0),
        all: Number(totals.all ?? 0),
      },
    });
  });

  // POST /api/customers/import-shopify-preview — fetch every Shopify
  // customer whose tags include the given tag (default "b2b"), match
  // them by email against our customers table, and return the matched
  // customer IDs so the UI can confirm + commit via the existing
  // bulk-tag endpoint. This is the "preview" half — no writes.
  app.post("/import-shopify-preview", async (req, reply) => {
    await requireAuth(req);
    const schema = z.object({
      tag: z.string().min(1).max(64).default("b2b"),
    });
    const parse = schema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { tag } = parse.data;

    let shopifyCustomers;
    try {
      const shopify = new ShopifyClient();
      shopifyCustomers = await listCustomersByTag(shopify, tag);
    } catch (err) {
      log.error({ err, tag }, "shopify customer fetch failed");
      return reply.code(502).send({ error: "shopify fetch failed" });
    }

    const shopifyEmails = new Set(
      shopifyCustomers
        .map((c) => c.email?.toLowerCase().trim())
        .filter((e): e is string => Boolean(e)),
    );
    if (shopifyEmails.size === 0) {
      return reply.send({
        tag,
        fetched: shopifyCustomers.length,
        matchedIds: [],
        sampleNames: [],
      });
    }

    // Match by primary_email (case-insensitive). The billingEmails JSON
    // array could also match in theory but in practice QB customers
    // are keyed on a single primary email — covering the 99% case
    // without needing per-row JSON_CONTAINS calls.
    const matches = await db
      .select({ id: customers.id, displayName: customers.displayName, email: customers.primaryEmail })
      .from(customers)
      .where(inArray(customers.primaryEmail, Array.from(shopifyEmails)));

    return reply.send({
      tag,
      fetched: shopifyCustomers.length,
      matchedIds: matches.map((m) => m.id),
      sampleNames: matches.slice(0, 10).map((m) => m.displayName),
    });
  });

  // PATCH /api/customers/bulk-tag — set customer_type for many at once.
  // Used by the sweep UI. Audit-logs each change individually so we can
  // trace who tagged whom.
  app.patch("/bulk-tag", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = bulkTagBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { ids, customerType } = parse.data;

    const before = await db
      .select({ id: customers.id, customerType: customers.customerType })
      .from(customers)
      .where(inArray(customers.id, ids));

    await db
      .update(customers)
      .set({ customerType })
      .where(inArray(customers.id, ids));

    // Bulk audit-log insert. One row per customer changed (skip rows
    // where the value didn't actually change — saves audit noise).
    const auditRows = before
      .filter((r) => r.customerType !== customerType)
      .map((r) => ({
        id: nanoid(24),
        userId: user.id,
        action: "customer.bulk_tag" as const,
        entityType: "customer" as const,
        entityId: r.id,
        before: { customerType: r.customerType },
        after: { customerType },
      }));
    if (auditRows.length > 0) {
      await db.insert(auditLog).values(auditRows);
    }

    log.info(
      { userId: user.id, count: ids.length, changed: auditRows.length, customerType },
      "bulk-tagged customers",
    );

    return reply.send({ updated: auditRows.length, total: ids.length });
  });

  // POST /api/customers/:id/sync-emails — pull this customer's email
  // history from Gmail. Searches for messages to/from any of the
  // customer's known email addresses (primary + billing) up to
  // maxResults (default 1000, cap 5000). Idempotent — duplicates
  // dedupe on email_log.gmailMessageId UNIQUE.
  app.post("/:id/sync-emails", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const bodySchema = z.object({
      maxResults: z.coerce.number().int().min(1).max(5000).default(1000),
    });
    const parse = bodySchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    try {
      const result = await syncEmailsForCustomer(id, {
        maxResults: parse.data.maxResults,
      });
      return reply.send(result);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("customer not found")) {
        return reply.code(404).send({ error: msg });
      }
      log.error({ err, customerId: id }, "per-customer email sync failed");
      return reply.code(502).send({ error: "gmail sync failed" });
    }
  });

  // GET /api/customers/:id/emails — email_log rows for a customer,
  // newest first. Used by the Email tab on customer detail. Filter
  // params: `direction=inbound|outbound|all` (default all),
  // `actioned=open|done|all` (default open — hide actioned items).
  // Limit cap is generous because a single customer's full email
  // history fits in one fetch for any reasonable usage.
  app.get("/:id/emails", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const querySchema = z.object({
      direction: z.enum(["inbound", "outbound", "all"]).default("all"),
      actioned: z.enum(["open", "done", "all"]).default("open"),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    });
    const parse = querySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { direction, actioned, limit } = parse.data;

    const filters = [eq(emailLog.customerId, id)];
    if (direction !== "all") {
      filters.push(eq(emailLog.direction, direction));
    }
    // SQL nullability: actioned="open" → actionedAt IS NULL.
    // actioned="done" → actionedAt IS NOT NULL.
    if (actioned === "open") {
      filters.push(isNull(emailLog.actionedAt));
    } else if (actioned === "done") {
      filters.push(sql`${emailLog.actionedAt} IS NOT NULL`);
    }

    const rows = await db
      .select()
      .from(emailLog)
      .where(and(...filters))
      .orderBy(desc(emailLog.emailDate))
      .limit(limit);

    return reply.send({ rows });
  });

  // GET /api/customers/:id/statement-preview — preview the statement
  // payload before the user confirms a send. Returns the open-invoice
  // list (capped at 50, mirrors statements/send.ts), aggregate balances
  // and the recipients we would address (To = primary, CC = billing
  // emails minus primary, BCC = accounts@feldart.com). The
  // hasInvoiceLink flag is best-effort — we ask QBO if a Pay-now link
  // exists for each invoice so the dialog can surface a presence dot,
  // but the preview tolerates QBO failure (returns null on each row
  // rather than 502'ing) so the user can still confirm a send when QBO
  // is flaky. The actual send still re-fetches links itself.
  //
  // Error codes mirror the send route so the UI can show the same
  // inline messages on either path: customer_not_found,
  // no_primary_email, no_open_invoices, too_many_invoices.
  app.get("/:id/statement-preview", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const customer = customerRows[0];
    if (!customer) {
      return reply
        .code(404)
        .send({ error: "customer not found", code: "customer_not_found" });
    }
    if (!customer.primaryEmail) {
      return reply.code(400).send({
        error: "customer has no primary email",
        code: "no_primary_email",
      });
    }

    const openInvoiceRows = await db
      .select({
        qbInvoiceId: invoices.qbInvoiceId,
        docNumber: invoices.docNumber,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        balance: invoices.balance,
      })
      .from(invoices)
      .where(and(eq(invoices.customerId, id), gt(invoices.balance, "0")))
      .orderBy(asc(invoices.issueDate))
      .limit(STATEMENT_PREVIEW_INVOICE_CAP + 1);

    if (openInvoiceRows.length === 0) {
      return reply.code(400).send({
        error: "no open invoices to send",
        code: "no_open_invoices",
      });
    }
    const tooMany = openInvoiceRows.length > STATEMENT_PREVIEW_INVOICE_CAP;
    const previewInvoices = tooMany
      ? openInvoiceRows.slice(0, STATEMENT_PREVIEW_INVOICE_CAP)
      : openInvoiceRows;

    // Best-effort QBO lookup for InvoiceLink presence. Failure here
    // doesn't block the preview — we just return null on each row and
    // the dialog renders the dot as "unknown". The send path will
    // still try to fetch links itself when the user confirms.
    let invoiceLinks: Map<string, string> | null = null;
    try {
      invoiceLinks = await fetchInvoiceLinkPresence(
        previewInvoices.map((r) => r.qbInvoiceId),
      );
    } catch (err) {
      log.warn(
        { err, customerId: id },
        "statement-preview invoiceLink lookup failed — falling back to unknown",
      );
    }

    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    let totalOpenBalance = 0;
    let totalOverdueBalance = 0;
    const previewRows = previewInvoices.map((inv) => {
      const balanceNum = Number(inv.balance);
      totalOpenBalance += Number.isFinite(balanceNum) ? balanceNum : 0;

      const issueIso = isoDateString(inv.issueDate);
      const dueIso = isoDateString(inv.dueDate);

      // Match send.ts overdue calc: due-date strictly before today (UTC).
      if (dueIso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueIso);
        if (m) {
          const due = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
          if (due.getTime() < today.getTime()) {
            totalOverdueBalance += Number.isFinite(balanceNum) ? balanceNum : 0;
          }
        }
      }

      // hasInvoiceLink: true (QBO returned a link), false (QBO returned
      // no link), or null (lookup failed/skipped — UI shows gray dot).
      const hasInvoiceLink: boolean | null =
        invoiceLinks === null ? null : invoiceLinks.has(inv.qbInvoiceId);

      return {
        qbInvoiceId: inv.qbInvoiceId,
        docNumber: inv.docNumber,
        issueDate: issueIso,
        dueDate: dueIso,
        balance: inv.balance,
        hasInvoiceLink,
      };
    });

    // Recipients mirror the construction in modules/statements/send.ts
    // so the preview shows what the send will actually do.
    const primaryLower = customer.primaryEmail.toLowerCase();
    const cc: string[] = [];
    const seen = new Set<string>();
    for (const e of customer.billingEmails ?? []) {
      if (!e) continue;
      const trimmed = e.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (lower === primaryLower) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      cc.push(trimmed);
    }

    return reply.send({
      openInvoices: previewRows,
      totalOpenBalance: round2(totalOpenBalance),
      totalOverdueBalance: round2(totalOverdueBalance),
      recipients: {
        to: customer.primaryEmail,
        cc,
        bcc: STATEMENT_BCC_ALIAS,
      },
      truncated: tooMany,
      invoiceLinkLookupOk: invoiceLinks !== null,
    });
  });

  // GET /api/customers/:id — full record for the detail page. Returns
  // the customer plus a few related rollups: recent activities, open
  // invoice summary, open task count. Detail page can request more via
  // /api/customers/:id/activities (paginated).
  app.get("/:id", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const rows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const customer = rows[0];
    if (!customer) return reply.code(404).send({ error: "customer not found" });

    // Recent activities — first 50, sorted newest first. The full
    // timeline UI paginates via cursor; this is the seed.
    const recentActivities = await db
      .select()
      .from(activities)
      .where(eq(activities.customerId, id))
      .orderBy(desc(activities.occurredAt))
      .limit(50);

    return reply.send({ customer, recentActivities });
  });

  // PATCH /api/customers/:id — single-customer update. Used from the
  // detail page header (hold toggle, terms edit, customer_type flip)
  // and from the customers list row-level "Mark B2B" actions.
  app.patch("/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const updates = parse.data;
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "no fields to update" });
    }

    const beforeRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "customer not found" });

    await db.update(customers).set(updates).where(eq(customers.id, id));

    const afterRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const after = afterRows[0]!;

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "customer.update",
      entityType: "customer",
      entityId: id,
      before,
      after,
    });

    // If paymentTerms changed and the customer is wired to a QBO row,
    // push the new value to QBO. Fire-and-forget — local write is
    // already committed, and a QBO failure shouldn't block the
    // operator. Logged inside the helper.
    if (
      updates.paymentTerms !== undefined &&
      updates.paymentTerms !== before.paymentTerms &&
      after.qbCustomerId
    ) {
      void pushCustomerTermsToQbo({
        qbCustomerId: after.qbCustomerId,
        paymentTerms: after.paymentTerms,
      }).catch((err) => {
        log.warn(
          { err, customerId: id, qbCustomerId: after.qbCustomerId },
          "qbo terms push failed (local write succeeded)",
        );
      });
    }

    return reply.send({ customer: after });
  });
};

// --- statement-preview helpers ----------------------------------------

// Mirror the cap in modules/statements/send.ts so the preview never
// shows more rows than the send route would actually accept.
const STATEMENT_PREVIEW_INVOICE_CAP = 50;
const STATEMENT_BCC_ALIAS = "accounts@feldart.com";
const QBO_PROD = "https://quickbooks.api.intuit.com";
const QBO_MINOR_VERSION = 65;

// MySQL date columns come back as Date | null. Normalize to YYYY-MM-DD
// strings for the wire so the client doesn't have to deal with the
// DST/timezone quirks of new Date() on a date-only column.
function isoDateString(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : d;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Best-effort batch lookup of QBO Pay-now InvoiceLink for a list of
// QBO invoice IDs. The send module has the same logic — we duplicate
// rather than reach across module boundaries because the brief locks
// modules/statements/*. Returns a Map of qbInvoiceId → link (only for
// invoices that have one populated). Throws on QBO/auth failure; the
// caller catches and falls back to "unknown" UI.
async function fetchInvoiceLinkPresence(
  qbInvoiceIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (qbInvoiceIds.length === 0) return map;

  const realmId = env.QB_REALM_ID;
  const tokens = await loadQbTokens(realmId);
  if (!tokens) {
    throw new Error(`No QB tokens for realm ${realmId}`);
  }

  const CHUNK = 200;
  const url = `${QBO_PROD}/v3/company/${realmId}/query`;

  for (let i = 0; i < qbInvoiceIds.length; i += CHUNK) {
    const chunk = qbInvoiceIds.slice(i, i + CHUNK);
    const inClause = chunk
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(",");

    const params: Record<string, string | number> = {
      query: `SELECT Id, InvoiceLink FROM Invoice WHERE Id IN (${inClause})`,
      minorversion: QBO_MINOR_VERSION,
      include: "invoiceLink",
    };

    const doRequest = async (token: string) =>
      axios.get<{
        QueryResponse: { Invoice?: { Id: string; InvoiceLink?: string }[] };
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
      // 401 → token went stale. Bounce off QboClient.getTerms() to
      // trigger the single-flight refresh path in tokens.ts (same
      // pattern as send.ts), then retry once with the fresh token.
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
      if (inv.Id && inv.InvoiceLink) {
        map.set(inv.Id, inv.InvoiceLink);
      }
    }
  }
  return map;
}

export default customersRoute;
