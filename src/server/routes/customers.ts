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
import {
  activities,
  emailLog,
  statementSends,
} from "../../db/schema/crm.js";
import { invoices, invoiceChases } from "../../db/schema/invoices.js";
import { rmas } from "../../db/schema/returns.js";
import { tasks } from "../../db/schema/crm.js";
import { auditLog } from "../../db/schema/audit.js";
import { nanoid } from "nanoid";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import { env } from "../../lib/env.js";
import { ShopifyClient } from "../../integrations/shopify/client.js";
import { pushCustomerTermsToQbo } from "../../modules/customer-terms/push-to-qbo.js";
import { pushCustomerInvoiceEmailsToQbo } from "../../modules/customer-emails/push-to-qbo.js";
import { pushCustomerPhoneToQbo } from "../../modules/customer-phone/push-to-qbo.js";
import { sendInvoiceViaQbo } from "../../modules/invoice-send/send-via-qbo.js";
import { resolveRecipients } from "../../modules/customer-emails/recipients.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import {
  buildTemplateVars,
  renderTemplate,
} from "../../modules/email-compose/index.js";
import { loadAppSettings } from "../../modules/statements/settings.js";
import { listCustomersByTag } from "../../integrations/shopify/customers.js";
import { syncEmailsForCustomer } from "../../integrations/gmail/poller.js";
import { recordActivity } from "../../modules/crm/activity-ingester.js";
import { loadQbTokens } from "../../integrations/qb/tokens.js";
import { QboClient } from "../../integrations/qb/client.js";

const log = createLogger({ component: "routes.customers" });

// Boolean-ish coerce — accepts true/false (boolean) or "true"/"false"
// (query string). Returns false for everything else, so missing/blank
// chips are no-ops rather than 400-erroring the request.
const boolish = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .optional()
  .transform((v) => v === true || v === "true");

const listQuerySchema = z.object({
  q: z.string().max(100).optional(),
  customerType: z.enum(["b2b", "b2c", "uncategorized", "all"]).default("b2b"),
  // "active" filter widens to include payment_upfront — operationally
  // those customers are still B2B, just on prepay terms; only the
  // explicit "hold" filter narrows to the hold-only set.
  holdStatus: z
    .enum(["active", "hold", "payment_upfront", "all"])
    .default("all"),
  withBalance: boolish,
  // New filter chips (all default false → no filtering applied):
  hideZeroBalance: boolish,
  hasOverdue: boolish,
  hasUnactionedEmail: boolish,
  missingTerms: boolish,
  // Tag filter — narrows to customers whose tags JSON array contains
  // the given tag (case-insensitive substring match against the
  // serialised JSON; cheap because the tags array is small per row).
  // Multiple tags AND together (all must be present).
  tag: z.union([z.string().max(64), z.array(z.string().max(64))]).optional(),
  sort: z
    .enum([
      "displayName",
      "balance",
      "overdueBalance",
      "lastSyncedAt",
      "lastPaymentAt",
      "lastStatementSentAt",
      "lastContactedAt",
    ])
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

// Email address validator — bare RFC-flavoured shape, not exhaustive.
// Accepts foo@bar.com, foo+plus@sub.bar.uk; rejects anything without
// an @ or with whitespace.
const emailString = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be a valid email");

const patchBodySchema = z.object({
  customerType: z.enum(["b2b", "b2c"]).nullable().optional(),
  holdStatus: z.enum(["active", "hold", "payment_upfront"]).optional(),
  primaryEmail: emailString.nullable().optional(),
  billingEmails: z.array(emailString).max(20).nullable().optional(),
  invoiceToEmails: z.array(emailString).max(20).nullable().optional(),
  invoiceCcEmails: z.array(emailString).max(20).nullable().optional(),
  invoiceBccEmails: z.array(emailString).max(20).nullable().optional(),
  statementToEmails: z.array(emailString).max(20).nullable().optional(),
  statementCcEmails: z.array(emailString).max(20).nullable().optional(),
  statementBccEmails: z.array(emailString).max(20).nullable().optional(),
  // Tags drive email_routing_rules. Lower-cased + trimmed before
  // persisting so matching against rules.tag is case-insensitive.
  tags: z
    .array(z.string().min(1).max(64))
    .max(20)
    .nullable()
    .optional(),
  // Main phone — pushed back to QBO PrimaryPhone on change.
  phone: z.string().max(64).nullable().optional(),
  // Labelled extras alongside the main line. Local-only — not pushed
  // to QBO since QBO's customer schema doesn't have a free-form list.
  additionalPhones: z
    .array(
      z.object({
        label: z.string().min(1).max(64),
        number: z.string().min(3).max(64),
      }),
    )
    .max(10)
    .nullable()
    .optional(),
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
    const {
      q,
      customerType,
      holdStatus,
      withBalance,
      hideZeroBalance,
      hasOverdue,
      hasUnactionedEmail,
      missingTerms,
      tag,
      sort,
      dir,
      limit,
      offset,
    } = parse.data;
    const tagFilters = Array.isArray(tag) ? tag : tag ? [tag] : [];

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

    if (holdStatus === "active") {
      // "Active" view = anyone the operator can transact with normally
      // (active OR payment_upfront). Excludes only true holds.
      filters.push(inArray(customers.holdStatus, ["active", "payment_upfront"]));
    } else if (holdStatus !== "all") {
      filters.push(eq(customers.holdStatus, holdStatus));
    }
    if (withBalance || hideZeroBalance) {
      // hideZeroBalance is the new chip; withBalance is the legacy param
      // kept for backward-compat. Either trips the same WHERE.
      filters.push(gt(customers.balance, "0"));
    }
    if (hasOverdue) {
      filters.push(gt(customers.overdueBalance, "0"));
    }
    if (missingTerms) {
      filters.push(isNull(customers.paymentTerms));
    }
    // Tag filter: customers.tags is a JSON array. JSON_CONTAINS gives us
    // exact matching; JSON_SEARCH would let us do partial. We go with
    // exact since the tag picker UI lists known tags verbatim.
    for (const t of tagFilters) {
      filters.push(
        sql`JSON_CONTAINS(${customers.tags}, JSON_QUOTE(${t}))`,
      );
    }
    if (hasUnactionedEmail) {
      // EXISTS subquery — Drizzle renders this as `> 0` against the
      // count expression below, but for filtering we want a cheaper
      // EXISTS (stops scanning email_log as soon as one row matches).
      // Hand-qualify customers.id because the sql template drops the
      // table prefix otherwise (same gotcha as elsewhere).
      filters.push(
        sql`EXISTS (
          SELECT 1 FROM ${emailLog}
          WHERE ${emailLog.customerId} = \`customers\`.\`id\`
            AND ${emailLog.actionedAt} IS NULL
            AND ${emailLog.direction} = 'inbound'
        )`,
      );
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    // Subqueries used both in SELECT (for row data) and ORDER BY (for the
    // new sort options). Defined here so we can reference them in either
    // context without re-stating the SQL.
    const lastContactedAtExpr = sql<Date | string | null>`(
      SELECT MAX(${emailLog.emailDate})
      FROM ${emailLog}
      WHERE ${emailLog.customerId} = \`customers\`.\`id\`
    )`;
    const lastPaymentExprForSort = sql<Date | string | null>`(
      SELECT MAX(${activities.occurredAt})
      FROM ${activities}
      WHERE ${activities.customerId} = \`customers\`.\`id\`
        AND ${activities.kind} = 'qbo_payment'
    )`;
    const lastStatementExprForSort = sql<Date | string | null>`(
      SELECT MAX(${statementSends.sentAt})
      FROM ${statementSends}
      WHERE ${statementSends.customerId} = \`customers\`.\`id\`
    )`;

    const sortCol = {
      displayName: customers.displayName,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
      lastSyncedAt: customers.lastSyncedAt,
      lastPaymentAt: lastPaymentExprForSort,
      lastStatementSentAt: lastStatementExprForSort,
      lastContactedAt: lastContactedAtExpr,
    }[sort];
    const orderFn = dir === "asc" ? asc : desc;

    // Correlated subqueries — same shape as the chase route.
    // customers.id is hand-qualified inside the sql template because
    // Drizzle's column serializer drops the table prefix in this
    // context, which silently makes the WHERE always-false.
    const daysOverdueExpr = sql<number | null>`(
      SELECT DATEDIFF(CURRENT_DATE, MIN(${invoices.dueDate}))
      FROM ${invoices}
      WHERE ${invoices.customerId} = \`customers\`.\`id\`
        AND ${invoices.balance} > 0
        AND ${invoices.dueDate} IS NOT NULL
    )`;
    const lastPaymentExpr = sql<Date | string | null>`(
      SELECT MAX(${activities.occurredAt})
      FROM ${activities}
      WHERE ${activities.customerId} = \`customers\`.\`id\`
        AND ${activities.kind} = 'qbo_payment'
    )`;
    const lastStatementSentExpr = sql<Date | string | null>`(
      SELECT MAX(${statementSends.sentAt})
      FROM ${statementSends}
      WHERE ${statementSends.customerId} = \`customers\`.\`id\`
    )`;
    // Inbound emails the operator hasn't ticked off yet. Drives the
    // small red badge on the customers list and the "Has unactioned
    // email" filter chip. Outbound is excluded — operators only act
    // on inbound (replies, escalations, etc.); outbound being in the
    // log isn't actionable.
    const unactionedEmailCountExpr = sql<number>`(
      SELECT COUNT(*) FROM ${emailLog}
      WHERE ${emailLog.customerId} = \`customers\`.\`id\`
        AND ${emailLog.actionedAt} IS NULL
        AND ${emailLog.direction} = 'inbound'
    )`;
    // RMA in flight = any RMA in an active workflow status (i.e. not
    // completed, denied, or cancelled). EXISTS short-circuits as soon
    // as it finds one, so this is cheap even for customers with many
    // historical RMAs.
    const hasPendingRmaExpr = sql<boolean>`(
      EXISTS (
        SELECT 1 FROM ${rmas}
        WHERE ${rmas.customerId} = \`customers\`.\`id\`
          AND ${rmas.status} IN (
            'draft','approved','awaiting_warehouse_number',
            'sent_to_warehouse','received'
          )
      )
    )`;

    const rowsPromise = db
      .select({
        id: customers.id,
        qbCustomerId: customers.qbCustomerId,
        displayName: customers.displayName,
        primaryEmail: customers.primaryEmail,
        phone: customers.phone,
        balance: customers.balance,
        overdueBalance: customers.overdueBalance,
        holdStatus: customers.holdStatus,
        customerType: customers.customerType,
        paymentTerms: customers.paymentTerms,
        tags: customers.tags,
        lastSyncedAt: customers.lastSyncedAt,
        daysOverdue: daysOverdueExpr,
        lastPaymentAt: lastPaymentExpr,
        lastStatementSentAt: lastStatementSentExpr,
        lastContactedAt: lastContactedAtExpr,
        unactionedEmailCount: unactionedEmailCountExpr,
        hasPendingRma: hasPendingRmaExpr,
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
    const rows = rowsRaw.slice(0, limit).map((r) => ({
      ...r,
      // mysql2 returns TIMESTAMP from a correlated subquery as a
      // "YYYY-MM-DD HH:MM:SS" string rather than a Date. Normalise to
      // ISO so the frontend reads them like every other timestamp.
      // DATEDIFF comes back as a string|number depending on driver
      // mode — coerce to number|null.
      daysOverdue:
        r.daysOverdue === null || r.daysOverdue === undefined
          ? null
          : Number(r.daysOverdue),
      lastPaymentAt: normalizeDateValue(r.lastPaymentAt),
      lastStatementSentAt: normalizeDateValue(r.lastStatementSentAt),
      // COUNT(*) comes back as a string in some mysql2 modes — coerce.
      unactionedEmailCount: Number(r.unactionedEmailCount ?? 0),
    }));
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
  // POST /api/customers/:id/sync-qb — per-customer QBO refresh.
  // Pulls just this customer + their invoices + their payments,
  // bypassing the global 30-min cron when an operator needs fresh
  // data fast (e.g. before sending a statement). ~3 QBO calls vs
  // hundreds for the full sync. Per-customer scope means cross-
  // customer state (e.g. a payment applied across multiple invoices)
  // isn't reconciled here — the global sync remains the safety net.
  app.post("/:id/sync-qb", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const customerRows = await db
      .select({ qbCustomerId: customers.qbCustomerId })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    const customer = customerRows[0];
    if (!customer) {
      return reply.code(404).send({ error: "customer not found" });
    }
    if (!customer.qbCustomerId) {
      return reply
        .code(400)
        .send({ error: "customer has no QBO id — cannot sync" });
    }
    try {
      const { syncOneCustomer } = await import(
        "../../integrations/qb/sync.js"
      );
      const result = await syncOneCustomer(customer.qbCustomerId);
      return reply.send({
        ...result,
        syncedAt: new Date().toISOString(),
      });
    } catch (err) {
      log.error(
        { err, customerId: id, qbCustomerId: customer.qbCustomerId },
        "per-customer QB sync failed",
      );
      return reply.code(502).send({
        error: err instanceof Error ? err.message : "QB sync failed",
      });
    }
  });

  // POST /api/customers/:id/notes — create a manual_note activity for
  // this customer. Used by the Notes tab on the customer-detail page.
  // Body: { body: string, subject?: string }. The activity-ingester
  // handles the audit-log row + SSE event so subscribers (the
  // activity timeline + this customer's note list) refresh
  // automatically.
  //
  // Notes are first-class activities with kind="manual_note" — no
  // separate notes table. That mirrors how the Notes tab reads them
  // (filtered from recentActivities) and keeps the timeline view
  // consistent.
  app.post("/:id/notes", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const bodySchema = z.object({
      body: z.string().min(1).max(10_000),
      subject: z.string().max(255).optional(),
    });
    const parse = bodySchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    // Verify the customer exists before recording — recordActivity
    // accepts any customerId but we want a clean 404 on bad ids
    // rather than orphaned activity rows.
    const customerRows = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    if (customerRows.length === 0) {
      return reply.code(404).send({ error: "customer not found" });
    }
    const activityId = await recordActivity({
      customerId: id,
      kind: "manual_note",
      source: "user_action",
      userId: user.id,
      subject: parse.data.subject ?? null,
      body: parse.data.body,
    });
    return reply.send({ activityId });
  });

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

    // BCC sourced from app_settings — empty string disables the
    // header on the actual send, so the preview reflects that too.
    const settings = await loadAppSettings();
    const configuredBcc = settings.statement_bcc_email?.trim() ?? "";

    // Render the statement template so the dialog can pre-fill its
    // subject + body editors. The send route accepts overrides; if
    // the operator edits the strings, those win. Mirrors the
    // {{statement_table}} → "" substitution that the live send uses
    // (the table is in the attached PDF, not the email body).
    const tplRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, "statement_open_items"))
      .limit(1);
    const tpl = tplRows[0] ?? null;
    let renderedSubject: string | null = null;
    let renderedBody: string | null = null;
    if (tpl) {
      // Need an Invoice[] for buildTemplateVars; reload them as
      // full rows. The previewRows above are the trimmed UI shape.
      const fullInvoices = await db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.customerId, id),
            gt(invoices.balance, "0"),
          ),
        )
        .limit(STATEMENT_PREVIEW_INVOICE_CAP);
      const baseVars = buildTemplateVars({
        customer: {
          displayName: customer.displayName,
          primaryEmail: customer.primaryEmail,
          balance: customer.balance,
          overdueBalance: customer.overdueBalance,
        },
        openInvoices: fullInvoices,
        user: { name: null },
      });
      renderedSubject = renderTemplate(tpl.subject, baseVars);
      renderedBody = renderTemplate(tpl.body, {
        ...baseVars,
        statement_table: "",
      });
    }

    return reply.send({
      openInvoices: previewRows,
      totalOpenBalance: round2(totalOpenBalance),
      totalOverdueBalance: round2(totalOverdueBalance),
      recipients: {
        to: customer.primaryEmail,
        cc,
        bcc: configuredBcc.length > 0 ? configuredBcc : null,
      },
      template: {
        subject: renderedSubject,
        body: renderedBody,
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

    // KPI rollups for the customer detail header strip. Computed in one
    // round-trip alongside recentActivities so the page paints fast.
    const [recentActivities, kpiRows] = await Promise.all([
      db
        .select()
        .from(activities)
        .where(eq(activities.customerId, id))
        .orderBy(desc(activities.occurredAt))
        .limit(50),
      db
        .select({
          openInvoiceCount: sql<number>`(
            SELECT COUNT(*) FROM ${invoices}
            WHERE ${invoices.customerId} = ${id}
              AND ${invoices.balance} > 0
          )`,
          oldestUnpaidInvoiceDueDate: sql<Date | string | null>`(
            SELECT MIN(${invoices.dueDate}) FROM ${invoices}
            WHERE ${invoices.customerId} = ${id}
              AND ${invoices.balance} > 0
              AND ${invoices.dueDate} IS NOT NULL
          )`,
          openTaskCount: sql<number>`(
            SELECT COUNT(*) FROM ${tasks}
            WHERE ${tasks.customerId} = ${id}
              AND ${tasks.status} IN ('open','in_progress','blocked')
          )`,
          hasPendingRma: sql<boolean>`(
            EXISTS (
              SELECT 1 FROM ${rmas}
              WHERE ${rmas.customerId} = ${id}
                AND ${rmas.status} IN (
                  'draft','approved','awaiting_warehouse_number',
                  'sent_to_warehouse','received'
                )
            )
          )`,
          lastContactedAt: sql<Date | string | null>`(
            SELECT MAX(${emailLog.emailDate})
            FROM ${emailLog}
            WHERE ${emailLog.customerId} = ${id}
          )`,
          lastPaymentAt: sql<Date | string | null>`(
            SELECT MAX(${activities.occurredAt})
            FROM ${activities}
            WHERE ${activities.customerId} = ${id}
              AND ${activities.kind} = 'qbo_payment'
          )`,
          lastStatementSentAt: sql<Date | string | null>`(
            SELECT MAX(${statementSends.sentAt})
            FROM ${statementSends}
            WHERE ${statementSends.customerId} = ${id}
          )`,
        })
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1),
    ]);
    const kpi = kpiRows[0] ?? null;

    // Normalise the KPI row before sending. mysql2 hands back correlated-
    // subquery TIMESTAMPs as `"YYYY-MM-DD HH:MM:SS"` strings (UTC values
    // styled as a local-looking string); piping through normalizeDateValue
    // converts them to ISO so the frontend's `new Date(...)` parses them as
    // UTC rather than local time (otherwise "5h ago" for a 4h-old contact on
    // BST). DATE columns (oldestUnpaidInvoiceDueDate) stay as `YYYY-MM-DD`.
    // EXISTS returns 0|1 and COUNT returns string in some mysql2 modes —
    // coerce both. Mirrors the shape produced by the list route.
    const normalizedKpi = kpi
      ? {
          ...kpi,
          lastContactedAt: normalizeDateValue(kpi.lastContactedAt),
          lastPaymentAt: normalizeDateValue(kpi.lastPaymentAt),
          lastStatementSentAt: normalizeDateValue(kpi.lastStatementSentAt),
          oldestUnpaidInvoiceDueDate: kpi.oldestUnpaidInvoiceDueDate
            ? typeof kpi.oldestUnpaidInvoiceDueDate === "string"
              ? kpi.oldestUnpaidInvoiceDueDate.slice(0, 10)
              : kpi.oldestUnpaidInvoiceDueDate.toISOString().slice(0, 10)
            : null,
          hasPendingRma: Boolean(kpi.hasPendingRma),
          openInvoiceCount: Number(kpi.openInvoiceCount ?? 0),
          openTaskCount: Number(kpi.openTaskCount ?? 0),
        }
      : null;

    return reply.send({ customer, recentActivities, kpi: normalizedKpi });
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

    // Tags are lower-cased + trimmed + de-duped before persist so the
    // email_routing_rules match (also lower-case) is reliable. Done
    // here rather than in the schema's preprocess because Zod runs
    // before the body is fed to drizzle.
    const tagsNormalized =
      updates.tags === undefined
        ? undefined
        : updates.tags === null
          ? null
          : Array.from(
              new Set(
                updates.tags
                  .map((t) => t.trim().toLowerCase())
                  .filter(Boolean),
              ),
            );
    const writeSet =
      tagsNormalized === undefined
        ? updates
        : { ...updates, tags: tagsNormalized };
    await db.update(customers).set(writeSet).where(eq(customers.id, id));

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

    // Main phone changed → push to QBO's PrimaryPhone. Same fire-and-
    // forget pattern as the other push helpers; additional_phones is
    // local-only and never round-trips.
    if (
      updates.phone !== undefined &&
      updates.phone !== before.phone &&
      after.qbCustomerId
    ) {
      void pushCustomerPhoneToQbo({
        qbCustomerId: after.qbCustomerId,
        phone: after.phone,
      }).catch((err) => {
        log.warn(
          { err, customerId: id, qbCustomerId: after.qbCustomerId },
          "qbo phone push failed (local write succeeded)",
        );
      });
    }

    // If the invoice TO array changed, push the resolved TO to QBO
    // as PrimaryEmailAddr so QBO-auto-sent invoices (Shopify
    // pipeline) reach the right address. CC/BCC can't propagate —
    // QBO's Customer entity has no field for them — so changes to
    // invoiceCcEmails/BccEmails/tags don't trigger a push (they
    // only matter for finance-hub-sent invoices, which resolve
    // recipients at send time).
    const invoiceToChanged = updates.invoiceToEmails !== undefined;
    if (invoiceToChanged && after.qbCustomerId) {
      void pushCustomerInvoiceEmailsToQbo({
        qbCustomerId: after.qbCustomerId,
        customer: {
          primaryEmail: after.primaryEmail,
          billingEmails: after.billingEmails,
          invoiceToEmails: after.invoiceToEmails,
          invoiceCcEmails: after.invoiceCcEmails,
          invoiceBccEmails: after.invoiceBccEmails,
          statementToEmails: after.statementToEmails,
          statementCcEmails: after.statementCcEmails,
          statementBccEmails: after.statementBccEmails,
          tags: after.tags,
        },
      }).catch((err) => {
        log.warn(
          { err, customerId: id, qbCustomerId: after.qbCustomerId },
          "qbo email push failed (local write succeeded)",
        );
      });
    }

    return reply.send({ customer: after });
  });

  // GET /api/customers/:id/invoices — unified document list for the
  // detail-page Invoices tab. Returns invoices (from the local mirror,
  // synced every 30 min) AND credit memos (live from QBO — no local
  // table for those) in one array, each row tagged with a docType
  // discriminator. The two sources are merged and sorted newest-first
  // by issue date. Dates are normalised to YYYY-MM-DD on the wire so
  // the UI doesn't have to chop ISO timestamps.
  app.get("/:id/invoices", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;

    const cust = await db
      .select({
        id: customers.id,
        qbCustomerId: customers.qbCustomerId,
      })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    if (cust.length === 0) {
      return reply.code(404).send({ error: "customer not found" });
    }
    const qbCustomerId = cust[0]!.qbCustomerId;

    // Last-chased rollup: most recent (sent_at, level) for each
    // invoice. Drives the "Last chased" column on the customer
    // detail Invoices tab so the operator can target the next
    // chase at invoices that haven't been chased recently.
    //
    // The composite index idx_invoice_chases_invoice_sent_at backs
    // both subqueries.
    //
    // Hand-qualified `invoices`.`id` is REQUIRED inside the sql tag
    // — Drizzle's column serializer drops the table prefix on
    // ${invoices.id} in this context, which makes MySQL resolve `id`
    // against the inner table (invoice_chases.id, the chase row's
    // PK) instead of invoices.id. Result: subquery always returns
    // empty/NULL. Same gotcha applied to lastContactedAt / lastPayment
    // / etc. in the customers list route.
    const lastChasedAtExpr = sql<Date | string | null>`(
      SELECT MAX(${invoiceChases.sentAt})
      FROM ${invoiceChases}
      WHERE ${invoiceChases.invoiceId} = \`invoices\`.\`id\`
    )`;
    const lastChasedLevelExpr = sql<number | null>`(
      SELECT ${invoiceChases.level}
      FROM ${invoiceChases}
      WHERE ${invoiceChases.invoiceId} = \`invoices\`.\`id\`
      ORDER BY ${invoiceChases.sentAt} DESC
      LIMIT 1
    )`;

    // Local invoices read.
    const invoiceRowsP = db
      .select({
        id: invoices.id,
        qbInvoiceId: invoices.qbInvoiceId,
        docNumber: invoices.docNumber,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        total: invoices.total,
        balance: invoices.balance,
        status: invoices.status,
        customerMemo: invoices.customerMemo,
        sentAt: invoices.sentAt,
        sentVia: invoices.sentVia,
        lastChasedAt: lastChasedAtExpr,
        lastChasedLevel: lastChasedLevelExpr,
      })
      .from(invoices)
      .where(eq(invoices.customerId, id))
      .orderBy(desc(invoices.issueDate))
      .limit(100);

    // Credit memos live from QBO — only if the customer is linked.
    // Best-effort: if QBO's down or token's stale we still render
    // invoices (creditMemoError surfaces in the response).
    let creditMemoRowsP: Promise<
      Array<{
        qbId: string;
        docNumber: string | null;
        txnDate: string | null;
        total: number;
        balance: number;
        emailStatus: string | null;
        customerMemo: string | null;
      }>
    > = Promise.resolve([]);
    let creditMemoError: string | null = null;
    if (qbCustomerId) {
      creditMemoRowsP = (async () => {
        try {
          const qb = new QboClient();
          const memos = await qb.getCreditMemosForCustomer(qbCustomerId);
          return memos.map((cm) => ({
            qbId: cm.Id,
            docNumber: cm.DocNumber ?? null,
            txnDate: cm.TxnDate ?? null,
            total: cm.TotalAmt ?? 0,
            balance: cm.Balance ?? 0,
            emailStatus: cm.EmailStatus ?? null,
            customerMemo: cm.CustomerMemo?.value ?? null,
          }));
        } catch (err) {
          creditMemoError = (err as Error).message;
          return [];
        }
      })();
    }

    const [invoiceRows, creditMemoRows] = await Promise.all([
      invoiceRowsP,
      creditMemoRowsP,
    ]);

    type DocRow = {
      docType: "invoice" | "credit_memo";
      // Local DB id for invoices; null for credit memos (no local row).
      id: string | null;
      qbId: string;
      docNumber: string | null;
      // ISO YYYY-MM-DD — pre-formatted so the UI doesn't need to
      // care about Date/string round-tripping.
      issueDate: string | null;
      // null on credit memos (they don't have due dates).
      dueDate: string | null;
      total: string;
      balance: string;
      status: string | null;
      // QBO Invoice/CreditMemo CustomerMemo.value — the customer-
      // facing memo printed on the doc + statement.
      customerMemo: string | null;
      sentAt: string | null;
      sentVia: string | null;
      // Last chase email that touched this invoice — null when never
      // chased. Always null on credit memos (chase is invoice-only).
      lastChasedAt: string | null;
      lastChasedLevel: number | null;
    };

    const out: DocRow[] = [];
    for (const inv of invoiceRows) {
      out.push({
        docType: "invoice",
        id: inv.id,
        qbId: inv.qbInvoiceId,
        docNumber: inv.docNumber,
        issueDate: toDateOnly(inv.issueDate),
        dueDate: toDateOnly(inv.dueDate),
        total: inv.total,
        balance: inv.balance,
        status: inv.status,
        customerMemo: inv.customerMemo,
        sentAt: inv.sentAt ? inv.sentAt.toISOString() : null,
        sentVia: inv.sentVia,
        // mysql2 returns the subquery TIMESTAMP as a string; normalise
        // to ISO so the frontend's relativeTime() doesn't have to
        // guess. Same pattern used by normalizeDateValue elsewhere.
        lastChasedAt: normalizeDateValue(inv.lastChasedAt),
        lastChasedLevel:
          inv.lastChasedLevel === null || inv.lastChasedLevel === undefined
            ? null
            : Number(inv.lastChasedLevel),
      });
    }
    for (const cm of creditMemoRows) {
      out.push({
        docType: "credit_memo",
        id: null,
        qbId: cm.qbId,
        docNumber: cm.docNumber,
        issueDate: cm.txnDate, // already YYYY-MM-DD from QBO
        dueDate: null,
        total: cm.total.toFixed(2),
        balance: cm.balance.toFixed(2),
        // No native "status" on credit memos in QBO. Derive from
        // balance: 0 = fully applied, > 0 = open / unapplied.
        status: cm.balance > 0 ? "open" : "applied",
        customerMemo: cm.customerMemo,
        sentAt: cm.emailStatus === "EmailSent" ? "(sent)" : null,
        sentVia: cm.emailStatus === "EmailSent" ? "qbo" : null,
        // Chase tracking is invoice-only — credit memos can't be
        // chased.
        lastChasedAt: null,
        lastChasedLevel: null,
      });
    }

    out.sort((a, b) => (b.issueDate ?? "").localeCompare(a.issueDate ?? ""));

    return reply.send({
      invoices: out,
      creditMemoError,
    });
  });

  // GET /api/customers/:id/invoices/:qbInvoiceId/recipients — preview
  // the resolved recipients for an invoice send. The dialog calls
  // this when it opens so it can pre-fill the chip-list editors with
  // what would be sent if the operator hits Send straight away.
  app.get(
    "/:id/invoices/:qbInvoiceId/recipients",
    async (req, reply) => {
      await requireAuth(req);
      const { id } = req.params as { id: string };
      const customerRows = await db
        .select()
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1);
      const customer = customerRows[0];
      if (!customer) {
        return reply.code(404).send({ error: "customer not found" });
      }

      const resolved = await resolveRecipients("invoice", {
        primaryEmail: customer.primaryEmail,
        billingEmails: customer.billingEmails,
        invoiceToEmails: customer.invoiceToEmails,
        invoiceCcEmails: customer.invoiceCcEmails,
        invoiceBccEmails: customer.invoiceBccEmails,
        statementToEmails: customer.statementToEmails,
        statementCcEmails: customer.statementCcEmails,
        statementBccEmails: customer.statementBccEmails,
        tags: customer.tags,
      });

      return reply.send({
        to: resolved.to,
        cc: resolved.cc,
        bcc: resolved.bcc,
        bccReasons: resolved.bccReasons,
      });
    },
  );

  // POST /api/customers/:id/invoices/:qbInvoiceId/send — send the
  // invoice via QBO using the resolved (or operator-overridden)
  // recipients. Pattern: PATCH BillEmail/Cc/Bcc on the QBO Invoice,
  // POST /send, write activity row, update local mirror.
  const sendInvoiceBodySchema = z.object({
    // "invoice" (default) or "credit_memo" — the latter routes to the
    // /creditmemo/{id}/send branch with a header-only sparse PATCH for
    // BillEmail/Cc/Bcc (no Line mutation; CMs are settled docs).
    docType: z.enum(["invoice", "credit_memo"]).default("invoice"),
    to: z.array(z.string().email()).max(20).optional(),
    cc: z.array(z.string().email()).max(20).optional(),
    bcc: z.array(z.string().email()).max(20).optional(),
  });

  app.post(
    "/:id/invoices/:qbInvoiceId/send",
    async (req, reply) => {
      const user = await requireAuth(req);
      const { id, qbInvoiceId } = req.params as {
        id: string;
        qbInvoiceId: string;
      };
      const parsed = sendInvoiceBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid body",
          issues: parsed.error.issues,
        });
      }

      const customerRows = await db
        .select()
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1);
      const customer = customerRows[0];
      if (!customer) {
        return reply.code(404).send({ error: "customer not found" });
      }

      // Credit memo branch — no local row to update (no credit_memos
      // table). Resolve recipients via the same channel resolver
      // (CMs reuse the invoice channel since they're billing docs),
      // PATCH BillEmail/Cc/Bcc onto the QBO record, POST /send, write
      // an activity for the timeline.
      if (parsed.data.docType === "credit_memo") {
        try {
          const qb = new QboClient();
          const cm = await qb.getCreditMemoById(qbInvoiceId);
          if (!cm) {
            return reply
              .code(404)
              .send({ error: "credit memo not found in QBO" });
          }
          const resolved = await resolveRecipients("invoice", {
            primaryEmail: customer.primaryEmail,
            billingEmails: customer.billingEmails,
            invoiceToEmails: customer.invoiceToEmails,
            invoiceCcEmails: customer.invoiceCcEmails,
            invoiceBccEmails: customer.invoiceBccEmails,
            statementToEmails: customer.statementToEmails,
            statementCcEmails: customer.statementCcEmails,
            statementBccEmails: customer.statementBccEmails,
            tags: customer.tags,
          });
          const to = parsed.data.to ?? resolved.to;
          const cc = parsed.data.cc ?? resolved.cc;
          const bcc = parsed.data.bcc ?? resolved.bcc;
          if (to.length === 0) {
            return reply.code(400).send({
              error:
                "no TO address — add an invoice TO email on the customer profile",
            });
          }
          const patchPayload: Record<string, unknown> = {
            Id: cm.Id,
            SyncToken: cm.SyncToken,
            sparse: true,
            BillEmail: { Address: to.join(", ") },
            BillEmailCc:
              cc.length > 0 ? { Address: cc.join(", ") } : null,
            BillEmailBcc:
              bcc.length > 0 ? { Address: bcc.join(", ") } : null,
          };
          await qb.updateCreditMemo(patchPayload);
          await qb.sendCreditMemoEmail(cm.Id);
          await db.insert(activities).values({
            id: nanoid(),
            customerId: customer.id,
            userId: user.id,
            kind: "qbo_credit_memo",
            source: "user_action",
            occurredAt: new Date(),
            subject: cm.DocNumber
              ? `Credit memo ${cm.DocNumber} sent`
              : "Credit memo sent",
            body: [
              `TO: ${to.join(", ")}`,
              cc.length > 0 ? `CC: ${cc.join(", ")}` : null,
              bcc.length > 0 ? `BCC: ${bcc.join(", ")}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            refType: "credit_memo",
            refId: cm.Id,
            meta: {
              qbCreditMemoId: cm.Id,
              docNumber: cm.DocNumber ?? null,
              to,
              cc,
              bcc,
              total: cm.TotalAmt ?? 0,
              balance: cm.Balance ?? 0,
            },
          });
          return reply.send({
            status: "ok",
            qbInvoiceId: cm.Id,
            docNumber: cm.DocNumber ?? null,
            to,
            cc,
            bcc,
            sentAt: new Date(),
          });
        } catch (err) {
          log.warn(
            { err, customerId: id, qbCreditMemoId: qbInvoiceId },
            "credit memo send via QBO failed",
          );
          const message =
            err instanceof Error ? err.message : "send failed";
          return reply.code(502).send({ error: message });
        }
      }

      const invoiceRows = await db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.customerId, id),
            eq(invoices.qbInvoiceId, qbInvoiceId),
          ),
        )
        .limit(1);
      const invoice = invoiceRows[0];
      if (!invoice) {
        return reply.code(404).send({ error: "invoice not found" });
      }

      try {
        const result = await sendInvoiceViaQbo({
          customer,
          invoice,
          userId: user.id,
          recipientOverrides: {
            to: parsed.data.to,
            cc: parsed.data.cc,
            bcc: parsed.data.bcc,
          },
        });
        return reply.send({ status: "ok", ...result });
      } catch (err) {
        log.warn(
          { err, customerId: id, qbInvoiceId },
          "invoice send via QBO failed",
        );
        const message =
          err instanceof Error ? err.message : "send failed";
        return reply.code(502).send({ error: message });
      }
    },
  );

  // POST /api/customers/:id/invoices/bulk-pdf — fetch a set of QBO
  // invoice + credit-memo PDFs in parallel, zip them up, and stream
  // the archive back as application/zip. Used by the "Download N
  // PDFs" affordance on the customer-profile Invoices tab.
  //
  // Body: { docs: [{ docType: "invoice"|"credit_memo", qbId: string }, ...] }
  //
  // The QBO PDF endpoint is rate-limited (~10 rps per realm), so we
  // cap parallelism to 5 — comfortably under the limit and fast
  // enough that 50-row downloads finish in a few seconds. Failures
  // on individual docs surface in the ZIP as a `_failed.txt` entry
  // rather than 500-ing the whole request, so a flaky doc doesn't
  // ruin a 30-doc download.
  const bulkPdfBodySchema = z.object({
    docs: z
      .array(
        z.object({
          docType: z.enum(["invoice", "credit_memo"]),
          qbId: z.string().min(1).max(64),
        }),
      )
      .min(1)
      .max(100),
  });

  app.post("/:id/invoices/bulk-pdf", async (req, reply) => {
    await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parsed = bulkPdfBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid body",
        issues: parsed.error.issues,
      });
    }

    const cust = await db
      .select({
        displayName: customers.displayName,
      })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    if (cust.length === 0) {
      return reply.code(404).send({ error: "customer not found" });
    }
    const customerName = cust[0]!.displayName;

    // Look up doc-numbers locally so the ZIP entries get
    // human-readable names. Best-effort — falls back to the qbId if
    // the doc isn't in our local mirror (rare; credit memos
    // aren't mirrored at all, so they always hit the qbId fallback).
    const requestedInvoiceIds = parsed.data.docs
      .filter((d) => d.docType === "invoice")
      .map((d) => d.qbId);
    const invoiceDocNumbers = new Map<string, string>();
    if (requestedInvoiceIds.length > 0) {
      const localInvs = await db
        .select({
          qbInvoiceId: invoices.qbInvoiceId,
          docNumber: invoices.docNumber,
        })
        .from(invoices)
        .where(inArray(invoices.qbInvoiceId, requestedInvoiceIds));
      for (const inv of localInvs) {
        if (inv.docNumber)
          invoiceDocNumbers.set(inv.qbInvoiceId, inv.docNumber);
      }
    }

    const qb = new QboClient();
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const failures: Array<{ doc: { docType: string; qbId: string }; error: string }> = [];

    // Bounded parallelism — QBO's PDF endpoint shares a leaky-bucket
    // limit with the rest of the API. 5 in flight at once is well
    // under their ~10 rps cap.
    const CONCURRENCY = 5;
    const queue = [...parsed.data.docs];
    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const doc = queue.shift();
        if (!doc) return;
        try {
          const buf = await qb.getPdf(
            doc.docType === "credit_memo" ? "creditmemo" : "invoice",
            doc.qbId,
          );
          const baseName =
            doc.docType === "credit_memo"
              ? `CreditMemo-${doc.qbId}`
              : `Invoice-${invoiceDocNumbers.get(doc.qbId) ?? doc.qbId}`;
          zip.file(`${baseName}.pdf`, buf);
        } catch (err) {
          failures.push({
            doc,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, parsed.data.docs.length) }, () => worker()),
    );

    if (failures.length > 0) {
      // Note inside the ZIP so the operator sees what didn't make it
      // without the whole thing failing.
      zip.file(
        "_failed.txt",
        failures
          .map(
            (f) =>
              `${f.doc.docType} ${f.doc.qbId} — ${f.error}`,
          )
          .join("\n"),
      );
      log.warn(
        { customerId: id, failureCount: failures.length },
        "bulk-pdf had per-doc failures",
      );
    }

    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const filename = `${sanitizeFilenameSegment(customerName)}-${todayDateStamp()}.zip`;
    reply
      .header("Content-Type", "application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      )
      .send(zipBuffer);
  });
};

// Filesystem-safe slug for ZIP filenames — strips characters that
// upset Windows downloads + collapses whitespace. Same shape as the
// statement-send helper but kept local since this file already has
// its own helper section and the cross-module dep is otherwise zero.
function sanitizeFilenameSegment(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "customer";
}

// "2026-05-01" — used in the ZIP filename so consecutive bulk
// downloads for the same customer don't collide.
function todayDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// Normalise a MySQL DATE column (mysql2 sometimes hands back a Date,
// sometimes a "YYYY-MM-DD" string depending on driver config) to a
// stable "YYYY-MM-DD" wire format so the UI doesn't have to chop ISO
// timestamps. Returns null for null input.
function toDateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  // Date — use UTC slice so a server in a non-UTC timezone doesn't
  // shift the calendar day for invoices stamped at 00:00.
  return value.toISOString().slice(0, 10);
}

// --- statement-preview helpers ----------------------------------------

// Mirror the cap in modules/statements/send.ts so the preview never
// shows more rows than the send route would actually accept.
const STATEMENT_PREVIEW_INVOICE_CAP = 50;
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

// Subquery TIMESTAMPs come back as strings from mysql2; column-typed
// TIMESTAMPs come back as Date. Normalise both to ISO so the wire
// format is consistent.
function normalizeDateValue(
  v: Date | string | null | undefined,
): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  }
  // "YYYY-MM-DD HH:MM:SS" → ISO. Treated as UTC to match how mysql2
  // hydrates Date columns elsewhere.
  const d = new Date(v.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
