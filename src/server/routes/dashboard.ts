// Dashboard widget endpoints.
//
// Five GET endpoints, one per dashboard widget, each cached/polled
// independently by its widget on the frontend (30s + on-focus refetch).
// Plus dismiss / undismiss for the chase queue (permanent dismissal
// stored in chase_dismissals; undismissed only via the customer detail
// page).
//
// Replaces the prior single GET /stats aggregate endpoint — that was a
// stat-tile rollup we don't need anymore now that every widget owns
// its own data fetch.

import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog, tasks } from "../../db/schema/crm.js";
import { rmas } from "../../db/schema/returns.js";
import { invoices } from "../../db/schema/invoices.js";
import { auditLog } from "../../db/schema/audit.js";
import { chaseDismissals } from "../../db/schema/chase-dismissals.js";
import { computeSeverity } from "../../modules/chase/scoring.js";
import { requireAuth } from "../lib/auth.js";

const dashboardRoute: FastifyPluginAsync = async (app) => {
  // ── My Tasks ───────────────────────────────────────────────────────────
  app.get("/tasks", async (req, reply) => {
    const user = await requireAuth(req);
    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueAt: tasks.dueAt,
        status: tasks.status,
        priority: tasks.priority,
        customerId: tasks.customerId,
        customerName: sql<string | null>`(
          SELECT ${customers.displayName} FROM ${customers}
          WHERE ${customers.id} = ${tasks.customerId}
        )`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.assigneeUserId, user.id),
          inArray(tasks.status, ["open", "in_progress", "blocked"]),
        ),
      )
      .orderBy(sql`${tasks.dueAt} IS NULL`, asc(tasks.dueAt))
      .limit(10);
    return reply.send({ rows });
  });

  // ── Unactioned B2B Emails Today ────────────────────────────────────────
  app.get("/emails", async (req, reply) => {
    await requireAuth(req);

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const rows = await db
      .select({
        id: emailLog.id,
        threadId: emailLog.threadId,
        subject: emailLog.subject,
        snippet: emailLog.snippet,
        emailDate: emailLog.emailDate,
        customerId: emailLog.customerId,
        customerName: customers.displayName,
      })
      .from(emailLog)
      .innerJoin(customers, eq(customers.id, emailLog.customerId))
      .where(
        and(
          eq(emailLog.direction, "inbound"),
          gte(emailLog.emailDate, todayStart),
          // Include B2B AND not-yet-classified customers; only exclude
          // explicit B2C. customer_type lands NULL on QB sync until
          // manually tagged — those customers should still show up
          // here, not vanish into the gap.
          sql`(${customers.customerType} = 'b2b' OR ${customers.customerType} IS NULL)`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${emailLog} AS reply
            WHERE reply.thread_id = ${emailLog.threadId}
              AND reply.direction = 'outbound'
              AND reply.email_date > ${emailLog.emailDate}
          )`,
        ),
      )
      .orderBy(desc(emailLog.emailDate))
      .limit(10);
    return reply.send({ rows });
  });

  // ── Emails debug — counts at each filter stage (admin diagnostic) ──────
  app.get("/emails-debug", async (req, reply) => {
    await requireAuth(req);

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [
      totalInboundToday,
      withLinkedCustomer,
      withCustomerTypeB2bOrNull,
      withoutLaterReply,
      sampleRows,
    ] = await Promise.all([
      db
        .select({ n: sql<number>`COUNT(*)` })
        .from(emailLog)
        .where(
          and(
            eq(emailLog.direction, "inbound"),
            gte(emailLog.emailDate, todayStart),
          ),
        ),
      db
        .select({ n: sql<number>`COUNT(*)` })
        .from(emailLog)
        .innerJoin(customers, eq(customers.id, emailLog.customerId))
        .where(
          and(
            eq(emailLog.direction, "inbound"),
            gte(emailLog.emailDate, todayStart),
          ),
        ),
      db
        .select({ n: sql<number>`COUNT(*)` })
        .from(emailLog)
        .innerJoin(customers, eq(customers.id, emailLog.customerId))
        .where(
          and(
            eq(emailLog.direction, "inbound"),
            gte(emailLog.emailDate, todayStart),
            sql`(${customers.customerType} = 'b2b' OR ${customers.customerType} IS NULL)`,
          ),
        ),
      db
        .select({ n: sql<number>`COUNT(*)` })
        .from(emailLog)
        .innerJoin(customers, eq(customers.id, emailLog.customerId))
        .where(
          and(
            eq(emailLog.direction, "inbound"),
            gte(emailLog.emailDate, todayStart),
            sql`(${customers.customerType} = 'b2b' OR ${customers.customerType} IS NULL)`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${emailLog} AS reply
              WHERE reply.thread_id = ${emailLog.threadId}
                AND reply.direction = 'outbound'
                AND reply.email_date > ${emailLog.emailDate}
            )`,
          ),
        ),
      db
        .select({
          id: emailLog.id,
          emailDate: emailLog.emailDate,
          customerId: emailLog.customerId,
          threadId: emailLog.threadId,
          subject: emailLog.subject,
          customerType: customers.customerType,
          customerName: customers.displayName,
        })
        .from(emailLog)
        .leftJoin(customers, eq(customers.id, emailLog.customerId))
        .where(
          and(
            eq(emailLog.direction, "inbound"),
            gte(emailLog.emailDate, todayStart),
          ),
        )
        .orderBy(desc(emailLog.emailDate))
        .limit(20),
    ]);

    return reply.send({
      todayStartUtc: todayStart.toISOString(),
      stage1_totalInboundToday: Number(totalInboundToday[0]?.n ?? 0),
      stage2_withLinkedCustomer: Number(withLinkedCustomer[0]?.n ?? 0),
      stage3_withCustomerTypeB2bOrNull: Number(withCustomerTypeB2bOrNull[0]?.n ?? 0),
      stage4_withoutLaterReply: Number(withoutLaterReply[0]?.n ?? 0),
      sampleRows: sampleRows.map((r) => ({
        ...r,
        emailDate: r.emailDate instanceof Date ? r.emailDate.toISOString() : r.emailDate,
      })),
    });
  });

  // ── RMAs in Flight ─────────────────────────────────────────────────────
  app.get("/rmas", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select({
        id: rmas.id,
        rmaNumber: rmas.rmaNumber,
        status: rmas.status,
        totalValue: rmas.totalValue,
        updatedAt: rmas.updatedAt,
        customerId: rmas.customerId,
        customerName: customers.displayName,
      })
      .from(rmas)
      .innerJoin(customers, eq(customers.id, rmas.customerId))
      .where(
        inArray(rmas.status, [
          "draft",
          "approved",
          "awaiting_warehouse_number",
          "sent_to_warehouse",
          "received",
        ]),
      )
      .orderBy(desc(rmas.updatedAt))
      .limit(50);
    return reply.send({ rows });
  });

  // ── Customers on Hold ──────────────────────────────────────────────────
  app.get("/holds", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        holdStatus: customers.holdStatus,
        overdueBalance: customers.overdueBalance,
        // Derive "held since" from the most recent audit_log row that
        // flipped to the current hold status. NULL for legacy holds with
        // no audit trail.
        heldSinceAt: sql<string | null>`(
          SELECT MAX(${auditLog.occurredAt}) FROM ${auditLog}
          WHERE ${auditLog.action} = 'customer.hold_toggle'
            AND ${auditLog.entityType} = 'customer'
            AND ${auditLog.entityId} = ${customers.id}
            AND JSON_UNQUOTE(JSON_EXTRACT(${auditLog.after}, '$.holdStatus')) = ${customers.holdStatus}
        )`,
      })
      .from(customers)
      .where(inArray(customers.holdStatus, ["hold", "payment_upfront"]))
      .orderBy(desc(customers.overdueBalance))
      .limit(50);
    return reply.send({ rows });
  });

  // ── Chase Queue ────────────────────────────────────────────────────────
  app.get("/chase", async (req, reply) => {
    await requireAuth(req);

    // 1. Pull every non-dismissed customer with overdueBalance > 0.
    //    Uses NOT IN subquery — cheaper than leftJoin + isNull at scale,
    //    and the chase_dismissals row count stays small.
    const overdueRows = await db
      .select()
      .from(customers)
      .where(
        and(
          gt(customers.overdueBalance, "0"),
          sql`${customers.id} NOT IN (SELECT ${chaseDismissals.customerId} FROM ${chaseDismissals})`,
        ),
      );

    if (overdueRows.length === 0) {
      return reply.send({ rows: [] });
    }

    // 2. Fetch all open invoices for these customers in ONE query
    //    (batched, not N+1). Group by customerId in memory.
    const customerIds = overdueRows.map((c) => c.id);
    const allInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(inArray(invoices.customerId, customerIds), gt(invoices.balance, "0")),
      );
    const invoicesByCustomer = new Map<string, typeof allInvoices>();
    for (const inv of allInvoices) {
      if (!inv.customerId) continue;
      const list = invoicesByCustomer.get(inv.customerId) ?? [];
      list.push(inv);
      invoicesByCustomer.set(inv.customerId, list);
    }

    // 3. Score + shape rows.
    const enriched = overdueRows.map((c) => {
      const sev = computeSeverity(c, invoicesByCustomer.get(c.id) ?? []);
      return {
        customerId: c.id,
        customerName: c.displayName,
        tier: sev.tier,
        score: sev.score,
        daysOverdue: sev.daysOverdue,
        totalOverdue: sev.totalOverdue,
        oldestUnpaidDate: sev.oldestUnpaidDate,
        primaryEmail: c.primaryEmail,
      };
    });

    // 4. Sort by tier rank then daysOverdue desc, take top 10.
    const tierRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
    enriched.sort((a, b) => {
      const t = tierRank[a.tier] - tierRank[b.tier];
      return t !== 0 ? t : b.daysOverdue - a.daysOverdue;
    });

    return reply.send({ rows: enriched.slice(0, 10) });
  });

  // ── Dismiss chase row (permanent until undismissed) ────────────────────
  app.post<{ Params: { customerId: string } }>(
    "/chase/:customerId/dismiss",
    async (req, reply) => {
      const user = await requireAuth(req);
      const { customerId } = req.params;

      const existing = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);
      if (!existing[0]) {
        return reply.code(404).send({ error: "customer not found" });
      }

      await db.transaction(async (tx) => {
        await tx
          .insert(chaseDismissals)
          .values({
            customerId,
            dismissedByUserId: user.id,
          })
          .onDuplicateKeyUpdate({
            set: {
              dismissedAt: sql`CURRENT_TIMESTAMP`,
              dismissedByUserId: user.id,
            },
          });
        await tx.insert(auditLog).values({
          id: nanoid(24),
          userId: user.id,
          action: "chase_dismissal.create",
          entityType: "customer",
          entityId: customerId,
          before: null,
          after: { dismissed: true },
        });
      });
      return reply.send({ ok: true });
    },
  );

  // ── Undismiss (only surface: customer detail page badge) ───────────────
  app.delete<{ Params: { customerId: string } }>(
    "/chase/:customerId/dismiss",
    async (req, reply) => {
      const user = await requireAuth(req);
      const { customerId } = req.params;

      await db.transaction(async (tx) => {
        await tx
          .delete(chaseDismissals)
          .where(eq(chaseDismissals.customerId, customerId));
        await tx.insert(auditLog).values({
          id: nanoid(24),
          userId: user.id,
          action: "chase_dismissal.delete",
          entityType: "customer",
          entityId: customerId,
          before: { dismissed: true },
          after: null,
        });
      });
      return reply.send({ ok: true });
    },
  );
};

export default dashboardRoute;
