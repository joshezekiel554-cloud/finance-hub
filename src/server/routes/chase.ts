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
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { activities } from "../../db/schema/crm.js";
import { invoices } from "../../db/schema/invoices.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import {
  sendStatement,
  SendStatementError,
} from "../../modules/statements/index.js";

const log = createLogger({ component: "routes.chase" });

const BATCH_CONCURRENCY = 5;
const BATCH_MAX_CUSTOMERS = 100;

const listQuerySchema = z.object({
  customerType: z.enum(["b2b", "b2c", "all"]).default("b2b"),
  holdStatus: z.enum(["active", "hold", "all"]).default("all"),
  sort: z
    .enum(["overdueBalance", "daysOverdue", "displayName", "lastActivityAt"])
    .default("overdueBalance"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const batchBodySchema = z.object({
  customerIds: z
    .array(z.string().min(1).max(24))
    .min(1)
    .max(BATCH_MAX_CUSTOMERS),
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
    const { customerType, holdStatus, sort, dir } = parse.data;

    const filters = [gt(customers.overdueBalance, "0")];
    if (customerType === "b2b") {
      filters.push(eq(customers.customerType, "b2b"));
    } else if (customerType === "b2c") {
      filters.push(eq(customers.customerType, "b2c"));
    }
    // "all" → no customer_type filter; uncategorized (NULL) rows pass
    // through too. The UI default is b2b so this is mostly a power-user
    // escape hatch.

    if (holdStatus !== "all") {
      filters.push(eq(customers.holdStatus, holdStatus));
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
    const daysOverdueExpr = sql<number | null>`(
      SELECT DATEDIFF(CURRENT_DATE, MIN(${invoices.dueDate}))
      FROM ${invoices}
      WHERE ${invoices.customerId} = \`customers\`.\`id\`
        AND ${invoices.balance} > 0
        AND ${invoices.dueDate} IS NOT NULL
    )`;

    const lastActivityExpr = sql<Date | null>`(
      SELECT MAX(${activities.occurredAt})
      FROM ${activities}
      WHERE ${activities.customerId} = \`customers\`.\`id\`
    )`;

    // Sort column resolution.
    const orderFn = dir === "asc" ? asc : desc;
    const where = and(...filters);

    let orderByClauses;
    if (sort === "displayName") {
      orderByClauses = [orderFn(customers.displayName), asc(customers.id)];
    } else if (sort === "overdueBalance") {
      orderByClauses = [orderFn(customers.overdueBalance), asc(customers.id)];
    } else if (sort === "lastActivityAt") {
      // MySQL default: NULLs first when ASC, last when DESC. The
      // intuitive "show me unattended customers" lands at the top of
      // either direction (oldest first or unknown first), so we keep
      // the default.
      orderByClauses = [orderFn(lastActivityExpr), asc(customers.id)];
    } else {
      // daysOverdue: positive = past due. Sort the daysOverdue
      // expression directly — desc → most overdue first.
      orderByClauses = [orderFn(daysOverdueExpr), asc(customers.id)];
    }

    const rows = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        primaryEmail: customers.primaryEmail,
        balance: customers.balance,
        overdueBalance: customers.overdueBalance,
        holdStatus: customers.holdStatus,
        customerType: customers.customerType,
        paymentTerms: customers.paymentTerms,
        daysSinceOldestUnpaid: daysOverdueExpr,
        lastActivityAt: lastActivityExpr,
      })
      .from(customers)
      .where(where)
      .orderBy(...orderByClauses);

    // Coerce nullable numerics. mysql2 returns DATEDIFF as `string | null`
    // depending on driver mode — normalize to `number | null` for the
    // client. lastActivityAt comes back as a Date (mysql2 hydrates
    // TIMESTAMP); JSON stringification handles the ISO conversion.
    const out = rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      primaryEmail: r.primaryEmail,
      balance: r.balance,
      overdueBalance: r.overdueBalance,
      holdStatus: r.holdStatus,
      customerType: r.customerType,
      paymentTerms: r.paymentTerms,
      daysSinceOldestUnpaid:
        r.daysSinceOldestUnpaid === null || r.daysSinceOldestUnpaid === undefined
          ? null
          : Number(r.daysSinceOldestUnpaid),
      lastActivityAt: (() => {
        // mysql2 returns a TIMESTAMP correlated-subquery as a "YYYY-MM-DD
        // HH:MM:SS" string rather than a Date (the typed column path
        // does hydrate to Date, but raw sql<Date> in a subquery
        // doesn't). Normalize both shapes to ISO so the frontend's
        // relativeTime() doesn't have to guess. Cast through unknown
        // because the sql<Date | null> generic narrows the runtime to
        // Date only — but in practice it's `Date | string | null`.
        const v = r.lastActivityAt as Date | string | null;
        if (!v) return null;
        if (v instanceof Date) return v.toISOString();
        const d = new Date(v.replace(" ", "T") + "Z");
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      })(),
    }));

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
    const { customerIds } = parse.data;

    // Dedupe defensively. The UI already prevents this but a stray
    // duplicate id would otherwise double-send to that customer.
    const uniqueIds = Array.from(new Set(customerIds));

    log.info(
      { userId: user.id, count: uniqueIds.length },
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
};

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

export default chaseRoute;
