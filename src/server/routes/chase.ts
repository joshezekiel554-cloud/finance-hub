// Chase list API. Backs the /chase page (week 7 task #24): a list of
// B2B customers with overdue balances plus a fan-out endpoint that
// kicks off a batch statement send.
//
// Two routes:
//   GET  /api/chase/customers — overdue list with last-activity rollup
//                               + days-since-oldest-unpaid
//   POST /api/chase/batch-statement — fan out sendStatement() with a
//                                     concurrency cap of 5
//
// Both auth-gated. The list query computes:
//   - daysSinceOldestUnpaid via a correlated subquery against invoices
//     (MIN(due_date) where balance > 0). Picked over a LEFT JOIN + MAX
//     because the customer result set is small (≤200), the
//     idx_invoices_due_date + idx_invoices_customer_id covers the inner
//     scan, and a correlated subquery keeps the outer SQL row-shape
//     identical to customers.* — no GROUP BY, no risk of duplicating
//     rows if a future join is added.
//   - lastActivityAt via the same pattern against activities (MAX
//     occurred_at per customer). Customers with no activities get NULL.
//
// Batch send fans out at concurrency=5 to match the per-call PDF fetch
// concurrency inside sendStatement — the QBO rate budget is the binding
// constraint, and 5 customers × 5 parallel PDF fetches each = 25 in
// flight, which has worked fine for single-customer sends. We don't
// pile up further. Each customer's outcome is independent — one
// failure doesn't fail the whole batch. The route returns a per-row
// status array so the UI can render a result table.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { activities, statementSends } from "../../db/schema/crm.js";
import { invoices, invoiceChases } from "../../db/schema/invoices.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { rmas } from "../../db/schema/returns.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import {
  sendStatement,
  SendStatementError,
} from "../../modules/statements/index.js";
import { emailTemplates } from "../../db/schema/email-templates.js";
import {
  buildTemplateVars,
  renderTemplate,
} from "../../modules/email-compose/template-vars.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { appendSignatures } from "../../modules/email-compose/signatures.js";
import { recordActivity } from "../../modules/crm/index.js";
import { loadAppSettings } from "../../modules/statements/settings.js";
import { resolveRecipients } from "../../modules/customer-emails/recipients.js";
import { getTjWinddown } from "../../modules/chase/winddown.js";
import { users } from "../../db/schema/auth.js";

const log = createLogger({ component: "routes.chase" });

const BATCH_CONCURRENCY = 5;
const BATCH_MAX_CUSTOMERS = 100;

// Boolean-ish coerce — accepts true/false (boolean) or "true"/"false"
// (query string). Returns false for everything else, so missing/blank
// chips are no-ops rather than 400-erroring the request. Mirrors the
// shape used in src/server/routes/customers.ts.
const boolish = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .optional()
  .transform((v) => v === true || v === "true");

// No `origin` param: this list is Feldart-only (origin-split-2). The Torah
// Judaica wind-down has its own endpoint, GET /api/chase/tj-winddown.
const listQuerySchema = z.object({
  customerType: z.enum(["b2b", "b2c", "all"]).default("b2b"),
  // "Active" widens to include payment_upfront — those customers can
  // still be chased; only true hold customers are excluded by it.
  holdStatus: z
    .enum(["active", "hold", "payment_upfront", "all"])
    .default("all"),
  sort: z
    .enum([
      "overdueBalance",
      "daysOverdue",
      "displayName",
      "lastActivityAt",
      "balance",
      "lastPaymentAt",
      "lastStatementSentAt",
    ])
    .default("overdueBalance"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  // Filter chips — same shape as the customers list. `missingTerms`
  // narrows to customers without paymentTerms; `hasPendingRma` narrows
  // to customers with an active RMA. Both default false → no filtering.
  missingTerms: boolish,
  hasPendingRma: boolish,
});

// Exported for schema-level route tests (no Fastify harness in repo).
export const batchBodySchema = z.object({
  customerIds: z
    .array(z.string().min(1).max(24))
    .min(1)
    .max(BATCH_MAX_CUSTOMERS),
  // Which book to send statements for. Required — each statement covers
  // exactly one book; 'both' (the old blended default) is rejected
  // (origin-split-2 Wave 1).
  origin: z.enum(["feldart", "tj"], {
    errorMap: () => ({
      message:
        "origin is required and must be 'feldart' or 'tj' — blended statements are no longer supported",
    }),
  }),
});

type BatchResult = {
  customerId: string;
  status: "sent" | "skipped" | "failed";
  error?: string;
  statementSendId?: string;
};

// Codes that mean "we won't retry this — there's nothing to send" rather
// than a real failure. Mapped to status="skipped" so the UI can
// distinguish from genuine errors. SendStatementError also raises these
// when, e.g., a customer has no open invoices at the moment of the send.
const SKIP_CODES = new Set([
  "no_open_invoices",
  "no_primary_email",
  "too_many_invoices",
]);

const chaseRoute: FastifyPluginAsync = async (app) => {
  // GET /api/chase/customers — list B2B (default) customers with
  // overdue_balance > 0, sorted server-side. Returns days-since-oldest-
  // unpaid + last-activity-at as derived columns. Tab/hold filters are
  // optional. The result is `{ rows, total }` — total is the row count
  // post-filter (not capped by limit; we don't paginate here because
  // the worst case is ~150 rows for Feldart).
  app.get("/customers", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const {
      customerType,
      holdStatus,
      sort,
      dir,
      missingTerms,
      hasPendingRma: hasPendingRmaFilter,
    } = parse.data;

    // Coarse pre-filter on the blended denormalized overdue. A customer with
    // overdue in *this* origin necessarily has blended overdue > 0, so this is
    // a safe superset; we compute the precise per-origin (netted) figures
    // below and drop rows whose origin overdue nets to 0.
    const filters = [gt(customers.overdueBalance, "0")];
    if (customerType === "b2b") {
      filters.push(eq(customers.customerType, "b2b"));
    } else if (customerType === "b2c") {
      filters.push(eq(customers.customerType, "b2c"));
    }
    // "all" → no customer_type filter; uncategorized (NULL) rows pass
    // through too. The UI default is b2b so this is mostly a power-user
    // escape hatch.

    if (holdStatus === "active") {
      filters.push(inArray(customers.holdStatus, ["active", "payment_upfront"]));
    } else if (holdStatus !== "all") {
      filters.push(eq(customers.holdStatus, holdStatus));
    }

    if (missingTerms) {
      filters.push(sql`${customers.paymentTerms} IS NULL`);
    }
    // Hand-qualified customers.id pattern (matches the other correlated
    // subqueries here) — Drizzle's serializer drops the table prefix
    // inside an sql template, which would silently make this WHERE
    // always-false against the inner table.
    if (hasPendingRmaFilter) {
      filters.push(
        sql`EXISTS (
          SELECT 1 FROM ${rmas}
          WHERE ${rmas.customerId} = \`customers\`.\`id\`
            AND ${rmas.status} IN (
              'draft','approved','awaiting_warehouse_number',
              'sent_to_warehouse','received'
            )
        )`,
      );
    }

    // Correlated subqueries. Picked over a LEFT JOIN + GROUP BY because
    // the customer result set is small (≤200 rows in the worst case),
    // the inner scans hit composite indexes (idx_invoices_customer_id,
    // idx_activities_customer_occurred), and the outer SELECT stays
    // 1:1 with customers — no risk of duplicating rows or accidental
    // SUM behaviour if a future join lands on this query.
    //
    // The customers.id reference is hand-qualified rather than using
    // ${customers.id}: Drizzle's column serializer drops the table
    // prefix inside an sql template, which makes MySQL resolve `id`
    // against the inner table (invoices/activities) and the WHERE
    // clause silently always-false. Spelled out, it works.
    //
    // DATEDIFF returns a signed integer (positive = past due, negative
    // = future due). We render past-due only on the UI but surface the
    // raw integer so the client can decide. NULL when there's no
    // unpaid invoice with a due_date.
    // Feldart-only: the per-origin netting SQL is hard-coded to the living
    // book. TJ figures come from the wind-down endpoint instead.
    const invOriginCond = sql` AND ${invoices.origin} = ${"feldart"}`;
    const cmOriginCond = sql` AND ${creditMemos.origin} = ${"feldart"}`;
    // TJ invoices parked for bookkeeper verification drop out of the active
    // chase list (feldart invoices never carry a dispute_state, so harmless).
    const notVerifying = sql` AND (${invoices.disputeState} IS NULL OR ${invoices.disputeState} <> 'verifying')`;

    const daysOverdueExpr = sql<number | null>`(
      SELECT DATEDIFF(CURRENT_DATE, MIN(${invoices.dueDate}))
      FROM ${invoices}
      WHERE ${invoices.customerId} = \`customers\`.\`id\`
        AND ${invoices.balance} > 0${notVerifying}${invOriginCond}
        AND ${invoices.dueDate} IS NOT NULL
    )`;

    // Per-origin money (gross). Netted by the matching unapplied credit in JS
    // below. Same hand-qualified `customers`.`id` as the other subqueries.
    const grossOverdueExpr = sql<string>`(
      SELECT COALESCE(SUM(${invoices.balance}), 0)
      FROM ${invoices}
      WHERE ${invoices.customerId} = \`customers\`.\`id\`
        AND ${invoices.balance} > 0${notVerifying}${invOriginCond}
        AND ${invoices.dueDate} IS NOT NULL
        AND ${invoices.dueDate} < CURRENT_DATE
    )`;
    const grossBalanceExpr = sql<string>`(
      SELECT COALESCE(SUM(${invoices.balance}), 0)
      FROM ${invoices}
      WHERE ${invoices.customerId} = \`customers\`.\`id\`
        AND ${invoices.balance} > 0${notVerifying}${invOriginCond}
    )`;
    const originCreditExpr = sql<string>`(
      SELECT COALESCE(SUM(${creditMemos.balance}), 0)
      FROM ${creditMemos}
      WHERE ${creditMemos.customerId} = \`customers\`.\`id\`
        AND ${creditMemos.balance} > 0${cmOriginCond}
    )`;

    const lastActivityExpr = sql<Date | null>`(
      SELECT MAX(${activities.occurredAt})
      FROM ${activities}
      WHERE ${activities.customerId} = \`customers\`.\`id\`
    )`;
    // Last QBO payment occurredAt — drawn from the activities ingester
    // which writes one qbo_payment row per Payment received. Same hand-
    // qualified customers.id as above to side-step Drizzle's serialiser
    // dropping the table prefix.
    const lastPaymentExpr = sql<Date | null>`(
      SELECT MAX(${activities.occurredAt})
      FROM ${activities}
      WHERE ${activities.customerId} = \`customers\`.\`id\`
        AND ${activities.kind} = 'qbo_payment'
    )`;
    // Last statement send (any operator, any kind). statement_sends is
    // populated by the actual send route — preview/PDF-only opens
    // don't touch it, so this value reflects what the customer
    // actually received.
    const lastStatementSentExpr = sql<Date | null>`(
      SELECT MAX(${statementSends.sentAt})
      FROM ${statementSends}
      WHERE ${statementSends.customerId} = \`customers\`.\`id\`
    )`;
    // RMA in flight = any RMA in an active workflow status (not
    // completed, denied, or cancelled). EXISTS short-circuits on
    // first match so this is cheap regardless of historical RMA count.
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

    const where = and(...filters);

    const rows = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        primaryEmail: customers.primaryEmail,
        grossBalance: grossBalanceExpr,
        grossOverdue: grossOverdueExpr,
        originCredit: originCreditExpr,
        holdStatus: customers.holdStatus,
        customerType: customers.customerType,
        paymentTerms: customers.paymentTerms,
        daysSinceOldestUnpaid: daysOverdueExpr,
        lastActivityAt: lastActivityExpr,
        lastPaymentAt: lastPaymentExpr,
        lastStatementSentAt: lastStatementSentExpr,
        hasPendingRma: hasPendingRmaExpr,
      })
      .from(customers)
      .where(where);

    // Net this origin's unapplied credit against its overdue + open balance
    // (floored at 0). mysql2 returns DATEDIFF/SUM as `string | null` depending
    // on driver mode; normalize. Then drop customers with no overdue left in
    // this book, and sort in JS (uniform across all keys now money is local).
    const num = (v: string | number | null | undefined): number =>
      v === null || v === undefined ? 0 : Number(v) || 0;
    const round2 = (n: number): number => Math.round(n * 100) / 100;

    const mapped = rows.map((r) => {
      const credit = num(r.originCredit);
      const overdueNum = round2(Math.max(0, num(r.grossOverdue) - credit));
      const balanceNum = round2(Math.max(0, num(r.grossBalance) - credit));
      return {
        id: r.id,
        displayName: r.displayName,
        primaryEmail: r.primaryEmail,
        balance: balanceNum.toFixed(2),
        overdueBalance: overdueNum.toFixed(2),
        unappliedCreditBalance: round2(credit).toFixed(2),
        holdStatus: r.holdStatus,
        customerType: r.customerType,
        paymentTerms: r.paymentTerms,
        daysSinceOldestUnpaid:
          r.daysSinceOldestUnpaid === null ||
          r.daysSinceOldestUnpaid === undefined
            ? null
            : Number(r.daysSinceOldestUnpaid),
        lastActivityAt: normalizeSubqueryDate(r.lastActivityAt),
        lastPaymentAt: normalizeSubqueryDate(r.lastPaymentAt),
        lastStatementSentAt: normalizeSubqueryDate(r.lastStatementSentAt),
        hasPendingRma: Boolean(r.hasPendingRma),
      };
    });

    // Only customers with overdue remaining in this book.
    const out = mapped.filter((r) => Number(r.overdueBalance) > 0);

    const sortKey = (r: (typeof out)[number]): number | string => {
      switch (sort) {
        case "displayName":
          return r.displayName ?? "";
        case "balance":
          return Number(r.balance);
        case "lastActivityAt":
          return r.lastActivityAt ? Date.parse(r.lastActivityAt) : -Infinity;
        case "lastPaymentAt":
          return r.lastPaymentAt ? Date.parse(r.lastPaymentAt) : -Infinity;
        case "lastStatementSentAt":
          return r.lastStatementSentAt
            ? Date.parse(r.lastStatementSentAt)
            : -Infinity;
        case "daysOverdue":
          return r.daysSinceOldestUnpaid ?? -Infinity;
        default:
          return Number(r.overdueBalance);
      }
    };
    out.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      let c: number;
      if (typeof ka === "string" && typeof kb === "string") {
        c = ka.localeCompare(kb);
      } else {
        c = ka < kb ? -1 : ka > kb ? 1 : 0;
      }
      if (c !== 0) return dir === "asc" ? c : -c;
      // Stable tie-break: id asc, regardless of direction.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return reply.send({ rows: out, total: out.length });
  });

  // POST /api/chase/batch-statement — fan out sendStatement for each
  // requested customer. Concurrency-bounded so we don't overwhelm QBO
  // or Gmail. Per-customer outcomes are independent: one failure does
  // not fail the batch. We audit-log the batch as a whole so we can
  // trace "who hit Send for these N customers"; per-customer audits
  // already get written by sendStatement itself.
  app.post("/batch-statement", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = batchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { customerIds, origin } = parse.data;

    // Dedupe defensively. The UI already prevents this but a stray
    // duplicate id would otherwise double-send to that customer.
    const uniqueIds = Array.from(new Set(customerIds));

    log.info(
      { userId: user.id, count: uniqueIds.length, origin },
      "batch statement send starting",
    );

    const batchId = nanoid(24);
    const startedAt = new Date();

    const results: BatchResult[] = await mapWithLimit(
      uniqueIds,
      BATCH_CONCURRENCY,
      async (customerId): Promise<BatchResult> => {
        try {
          const result = await sendStatement({
            customerId,
            userId: user.id,
            origin,
          });
          return {
            customerId,
            status: "sent",
            statementSendId: result.statementSendId,
          };
        } catch (err) {
          if (err instanceof SendStatementError) {
            const status = SKIP_CODES.has(err.code) ? "skipped" : "failed";
            log.warn(
              {
                customerId,
                userId: user.id,
                code: err.code,
                batchId,
              },
              "batch send: per-customer rejected",
            );
            return {
              customerId,
              status,
              error: `${err.code}: ${err.message}`,
            };
          }
          log.error(
            { err, customerId, userId: user.id, batchId },
            "batch send: per-customer failed unexpectedly",
          );
          return {
            customerId,
            status: "failed",
            error: err instanceof Error ? err.message : "send failed",
          };
        }
      },
    );

    const summary = {
      sent: results.filter((r) => r.status === "sent").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
    };

    // Batch-level audit log so we can answer "who fired the chase batch
    // on day X". Per-customer statement_sends + statement.send audit
    // rows are already written by sendStatement.
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "chase.batch_statement_send",
      entityType: "chase_batch",
      entityId: batchId,
      before: null,
      after: {
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        requestedCount: uniqueIds.length,
        origin,
        summary,
        results: results.map((r) => ({
          customerId: r.customerId,
          status: r.status,
          statementSendId: r.statementSendId ?? null,
          // Truncate per-customer errors so audit_log rows stay
          // bounded even if a hundred customers all 500 with long
          // QBO error messages.
          error: r.error ? r.error.slice(0, 500) : null,
        })),
      },
    });

    log.info(
      {
        userId: user.id,
        batchId,
        requestedCount: uniqueIds.length,
        ...summary,
      },
      "batch statement send done",
    );

    return reply.send({ results });
  });

  // GET /api/chase/tj-winddown — the whole Torah Judaica wind-down picture
  // in one read: net exposure, delta vs ~1 month ago (from the self-populating
  // tj_exposure_snapshots table — this call upserts today's row), aging
  // buckets, verifying count, and per-customer rows with embedded per-invoice
  // dispute data so the /chase TJ panel expands without a second fetch.
  app.get("/tj-winddown", async (req, reply) => {
    await requireAuth(req);
    const result = await getTjWinddown();
    return reply.send(result);
  });

  // GET /api/chase/preview-chase-email?customerId=...&level=...&invoiceIds=...
  // Returns the rendered subject + body + resolved recipients for
  // the chase L1/L2/L3 send dialog, so the operator can review +
  // edit before firing the send.
  //
  // invoiceIds: optional CSV of invoice ids. When provided, the
  // template's {{open_invoices_table}} renders ONLY those invoices.
  // When absent, falls back to "all open invoices for the customer".
  // Each id is verified to belong to the customer; mismatches are
  // dropped silently (operator could only have selected from this
  // customer's UI, but defence-in-depth).
  app.get("/preview-chase-email", async (req, reply) => {
    await requireAuth(req);
    const previewSchema = z.object({
      customerId: z.string().min(1).max(64),
      level: z.coerce.number().int().min(1).max(3),
      // Which book is being chased — picks the template (tj_l* vs chase_l*)
      // and scopes the invoices in the email to that origin. 'both' (the
      // old blended option) was removed in origin-split-2 W2: a chase
      // email always covers exactly one book.
      origin: z.enum(["feldart", "tj"]).default("feldart"),
      // CSV of invoice ids — TanStack Query serialises arrays as
      // repeated `?invoiceIds=a&invoiceIds=b`, but for a GET we accept
      // either shape and split on comma if a string slipped through.
      invoiceIds: z
        .union([z.string().max(2000), z.array(z.string().max(64))])
        .optional(),
    });
    const parse = previewSchema.safeParse(req.query);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parse.error.flatten() });
    }
    const { customerId, level, origin } = parse.data;
    const invoiceIds = normaliseInvoiceIds(parse.data.invoiceIds);
    const slug = origin === "tj" ? `tj_l${level}` : `chase_l${level}`;

    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
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
    const templateRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, slug))
      .limit(1);
    const template = templateRows[0];
    if (!template) {
      return reply
        .code(404)
        .send({ error: `template '${slug}' not found`, code: "no_template" });
    }
    // Subset filter: when invoiceIds is provided, narrow the query to
    // those rows AND keep the customer-id constraint (defence-in-depth
    // against id-guess from a stale UI). The customer-id WHERE means
    // a wrong id from another customer just falls out of the result
    // set rather than 403'ing.
    const openInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.customerId, customerId),
          gt(invoices.balance, "0"),
          eq(invoices.origin, origin),
          // Never chase a TJ invoice parked for bookkeeper verification.
          sql`(${invoices.disputeState} IS NULL OR ${invoices.disputeState} <> 'verifying')`,
          ...(invoiceIds.length > 0
            ? [inArray(invoices.id, invoiceIds)]
            : []),
        ),
      )
      .orderBy(asc(invoices.dueDate));
    const vars = buildTemplateVars({
      customer,
      openInvoices,
      user: { name: null },
    });
    const renderedSubject = renderTemplate(template.subject, vars);
    const renderedBody = renderTemplate(template.body, vars);

    const resolved = await resolveRecipients("statement", {
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
    const settings = await loadAppSettings();
    const bccConfigured = settings.statement_bcc_email?.trim() ?? "";
    const allBccs = [
      ...(bccConfigured ? [bccConfigured] : []),
      ...resolved.bcc,
    ];
    return reply.send({
      subject: renderedSubject,
      body: renderedBody,
      recipients: {
        to:
          resolved.to.length > 0
            ? resolved.to.join(", ")
            : customer.primaryEmail,
        cc: resolved.cc.length > 0 ? resolved.cc.join(", ") : "",
        bcc: allBccs.length > 0 ? allBccs.join(", ") : "",
      },
      bccReasons: resolved.bccReasons,
    });
  });

  // POST /api/chase/send-chase-email
  // Body: { customerId, level: 1|2|3 }
  // Picks the chase_l<level> email template, renders it with the
  // customer's open-invoice context, sends via Gmail (CC = billing
  // emails minus primary, BCC from app_settings.statement_bcc_email),
  // and records an email_out activity. Per-row use case from the
  // chase page; mirrors the shape of the existing batch-statement
  // route (single customer, no fan-out).
  app.post("/send-chase-email", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = sendChaseEmailBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const {
      customerId,
      level,
      origin,
      invoiceIds: invoiceIdsRaw,
      subject: subjectOverride,
      body: bodyOverride,
      to: toOverride,
      cc: ccOverride,
      bcc: bccOverride,
    } = parse.data;
    const invoiceIds = invoiceIdsRaw ?? [];
    const slug = origin === "tj" ? `tj_l${level}` : `chase_l${level}`;

    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const customer = customerRows[0];
    if (!customer) {
      return reply
        .code(404)
        .send({ error: "customer not found", code: "customer_not_found" });
    }
    if (!customer.primaryEmail) {
      return reply
        .code(400)
        .send({
          error: "customer has no primary email",
          code: "no_primary_email",
        });
    }

    const templateRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, slug))
      .limit(1);
    const template = templateRows[0];
    if (!template) {
      return reply
        .code(404)
        .send({ error: `template '${slug}' not found`, code: "no_template" });
    }

    // Subset filter: when invoiceIds set, narrow to those rows
    // (still gated to this customer to keep the post-send
    // invoice_chases insert from leaking across customers).
    const openInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.customerId, customerId),
          gt(invoices.balance, "0"),
          eq(invoices.origin, origin),
          // Never chase a TJ invoice parked for bookkeeper verification.
          sql`(${invoices.disputeState} IS NULL OR ${invoices.disputeState} <> 'verifying')`,
          ...(invoiceIds.length > 0
            ? [inArray(invoices.id, invoiceIds)]
            : []),
        ),
      )
      .orderBy(asc(invoices.dueDate));

    // Operator's display name for the {{user_name}} merge variable.
    const userRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const userName = userRows[0]?.name ?? user.email ?? "";

    const vars = buildTemplateVars({
      customer,
      openInvoices,
      user: { name: userName },
    });
    const renderedSubject =
      subjectOverride ?? renderTemplate(template.subject, vars);
    const renderedBody =
      bodyOverride ?? renderTemplate(template.body, vars);

    // Recipients via the per-channel resolver — chase emails reuse
    // the statement TO/CC overrides (per the customer-profile design,
    // chase + statement go to the same audience). BCC = global
    // statement_bcc_email setting + any tag-driven bcc_statement
    // rules. Tag-driven bcc_invoice rules don't apply to this channel.
    const resolved = await resolveRecipients("statement", {
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
    const toAddress =
      toOverride ??
      (resolved.to.length > 0
        ? resolved.to.join(", ")
        : customer.primaryEmail);
    const cc =
      ccOverride !== undefined
        ? ccOverride.length > 0
          ? ccOverride
          : undefined
        : resolved.cc.length > 0
          ? resolved.cc.join(", ")
          : undefined;
    let bcc: string | undefined;
    if (bccOverride !== undefined) {
      bcc = bccOverride.length > 0 ? bccOverride : undefined;
    } else {
      const settings = await loadAppSettings();
      const bccConfigured = settings.statement_bcc_email?.trim() ?? "";
      const allBccs = [
        ...(bccConfigured ? [bccConfigured] : []),
        ...resolved.bcc,
      ];
      bcc = allBccs.length > 0 ? allBccs.join(", ") : undefined;
    }

    // Chase templates are plain text. Convert to lightweight HTML
    // (paragraph-per-blank-line) so the email renders with sensible
    // spacing in clients that prefer the text/html part.
    const renderedBodyHtml = renderedBody
      .split(/\n{2,}/)
      .map(
        (p) =>
          `<p>${p
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br/>")}</p>`,
      )
      .join("\n");

    // Append user + alias signatures on the HTML branch only — the
    // text/plain part stays as-is so clients preferring text don't
    // see raw signature tags. Chase sends don't currently set an
    // alias (sendEmail falls back to the Gmail profile), so we pass
    // "" as aliasEmail; resolveAliasSignature returns null for
    // unknown aliases, which is the no-op result we want here.
    const finalHtml = await appendSignatures(db, {
      bodyHtml: renderedBodyHtml,
      userId: user.id,
      aliasEmail: "",
      userSignatureId: parse.data.userSignatureId ?? undefined,
      skipUserSignature: parse.data.userSignatureId === null,
    });

    let result;
    try {
      result = await sendEmail({
        to: toAddress,
        cc,
        bcc,
        subject: renderedSubject,
        html: finalHtml,
        text: renderedBody,
        financeSendType: "chase",
      });
    } catch (err) {
      log.error(
        {
          err,
          customerId,
          slug,
          to: toAddress,
        },
        "chase email send failed",
      );
      return reply.code(502).send({
        error: err instanceof Error ? err.message : "send failed",
        code: "send_failed",
      });
    }

    // Per-invoice chase log — one row per invoice covered by this
    // chase. Drives the "Last chased" column on the customer detail
    // Invoices tab. Best-effort: a DB failure here is logged but
    // doesn't fail the whole request because the email already went
    // out — the operator already knows the customer received it.
    const chasedInvoiceIds = openInvoices.map((inv) => inv.id);
    if (chasedInvoiceIds.length > 0) {
      try {
        await db.insert(invoiceChases).values(
          chasedInvoiceIds.map((invoiceId) => ({
            id: nanoid(24),
            invoiceId,
            level,
            sentByUserId: user.id,
            emailMessageId: result.messageId,
          })),
        );
      } catch (err) {
        log.error(
          { err, customerId, chasedInvoiceIds, messageId: result.messageId },
          "invoice_chases insert failed (email already sent)",
        );
      }
    }

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "chase.email_send",
      entityType: "customer",
      entityId: customerId,
      before: null,
      after: {
        slug,
        level,
        to: toAddress,
        cc: cc ?? null,
        bcc: bcc ?? null,
        subject: renderedSubject,
        messageId: result.messageId,
        threadId: result.threadId,
        invoiceIds: chasedInvoiceIds,
      },
    });
    await recordActivity({
      customerId,
      kind: "email_out",
      source: "user_action",
      userId: user.id,
      subject: renderedSubject,
      body: renderedBody,
      refType: "chase_email",
      refId: result.messageId,
      meta: {
        slug,
        level,
        to: toAddress,
        cc: cc ?? null,
        bcc: bcc ?? null,
        messageId: result.messageId,
        threadId: result.threadId,
        // Future timeline UI can show "chased these N invoices"
        // when expanding a chase activity row.
        invoiceIds: chasedInvoiceIds,
      },
    });

    log.info(
      {
        customerId,
        userId: user.id,
        slug,
        level,
        messageId: result.messageId,
      },
      "chase email sent",
    );

    return reply.send({
      messageId: result.messageId,
      threadId: result.threadId,
      slug,
      level,
    });
  });
};

const sendChaseEmailBodySchema = z.object({
  customerId: z.string().min(1).max(64),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  // Which book is being chased — picks the template (tj_l* vs chase_l*) and
  // scopes which invoices the email + invoice_chases rows cover. 'both' (the
  // old blended option) was removed in origin-split-2 W2: a chase email
  // always covers exactly one book.
  origin: z.enum(["feldart", "tj"]).default("feldart"),
  // Optional subset filter — when set, the rendered template covers
  // only these invoices AND only these get an invoice_chases row
  // written after send. When absent, the chase covers all the
  // customer's open invoices (legacy behaviour from chase.tsx).
  // Capped at 100 to bound the post-send INSERT.
  invoiceIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  // Optional operator overrides from the send dialog. When set,
  // these replace the template-rendered defaults verbatim. Mirrors
  // the statement-send overrides shape.
  subject: z.string().min(1).max(998).optional(),
  body: z.string().min(1).max(200_000).optional(),
  to: z.string().max(2000).optional(),
  cc: z.string().max(2000).optional(),
  bcc: z.string().max(2000).optional(),
  // User signature selection. `string` → use that specific user signature.
  // `null` → user explicitly picked "None" (skip user signature entirely).
  // `undefined`/absent → fall back to the user's default signature (if any).
  userSignatureId: z.string().nullable().optional(),
});

// Normalise the invoiceIds query param shape: it can arrive as a
// single CSV string (`?invoiceIds=a,b,c`), as repeated params
// (`?invoiceIds=a&invoiceIds=b`), or undefined. Returns a deduped
// array of trimmed non-empty strings.
function normaliseInvoiceIds(
  raw: string | string[] | undefined,
): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw)
    ? raw
    : raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  return Array.from(new Set(arr)).slice(0, 100);
}

// Bounded-concurrency map. Same shape as the helper inside
// modules/statements/send.ts — replicated here rather than imported
// because that helper isn't exported and the brief locks that file.
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

// mysql2 returns TIMESTAMP from a correlated subquery as a
// "YYYY-MM-DD HH:MM:SS" string rather than a Date (the typed column
// path does hydrate to Date, but raw sql<Date> in a subquery doesn't).
// Normalize both shapes to ISO so the frontend's relativeTime() doesn't
// have to guess. Cast through unknown because the sql<Date | null>
// generic narrows the runtime to Date only — but in practice it's
// `Date | string | null`.
function normalizeSubqueryDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v.replace(" ", "T") + "Z");
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export default chaseRoute;
