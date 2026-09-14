// GET /api/ext/hub-summary — finance's Home tile for hub.feldart.com
// (hub phase-1 spec §6). Read-only.
//
// Auth: `Authorization: Bearer <hub token>` with scope "service" and
// aud "finance", minted by the hub for the signed-in user. We verify the
// signature + apply ALLOWED_EMAILS so the hub can only read what that user
// could read. Not gated by the inbox_integration flag — different consumer.
// Like the rest of /api/ext this is loopback-only behind nginx.
//
// Wire contract: camelCase, money as decimal strings, times as ISO strings.

import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, sql, sum } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { invoiceEmailDismissals } from "../../db/schema/invoice-email-dismissals.js";
import { rmas } from "../../db/schema/returns.js";
import { env } from "../../lib/env.js";
import { verifyHubToken } from "../../lib/hub-token.js";
import { createLogger } from "../../lib/logger.js";
import {
  emailReviewWindowStart,
  NOT_EMAILED_STATUSES,
} from "../../modules/invoice-email-review/index.js";
import { listHoldableHoldOrders } from "../../modules/orders/hold-alerts.js";
import { isEmailAllowed } from "../lib/hub-handoff.js";

const log = createLogger({ component: "routes.ext-hub" });

// ---------------------------------------------------------------------------
// Pure: the cross-app "Needs you" contribution
// ---------------------------------------------------------------------------

export type NeedsYouSeverity = "todo" | "in-progress" | "waiting";

export type NeedsYouItem = {
  kind: "hold" | "chase" | "invoice-email" | "rma";
  title: string;
  subtitle: string | null;
  /** Finance-relative path the hub deep-links with `?p=`. */
  path: string;
  severity: NeedsYouSeverity;
  /** ISO time the item became actionable — older sorts first within a severity. */
  since: string;
};

const SEVERITY_RANK: Record<NeedsYouSeverity, number> = {
  todo: 0,
  "in-progress": 1,
  waiting: 2,
};

export const NEEDS_YOU_LIMIT = 5;

export function buildNeedsYou(items: readonly NeedsYouItem[]): NeedsYouItem[] {
  return [...items]
    .sort((a, b) => {
      const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (s !== 0) return s;
      return a.since.localeCompare(b.since);
    })
    .slice(0, NEEDS_YOU_LIMIT);
}

// ---------------------------------------------------------------------------
// Summary shape
// ---------------------------------------------------------------------------

export type HubSummary = {
  generatedAt: string;
  chase: {
    accounts: number;
    totalOverdue: string;
    top: Array<{ customerId: string; name: string; overdue: string; path: string }>;
  };
  holds: {
    customersOnHold: number;
    ordersOnHold: number;
    top: Array<{
      orderId: string;
      orderNumber: string | null;
      customerName: string | null;
      reason: string | null;
      heldDays: number;
      path: string;
    }>;
  };
  invoicing: {
    neverEmailed: number;
    deliveryFailed: number;
    path: string;
  };
  returns: {
    open: number;
    awaitingCreditMemo: number;
    top: Array<{ rmaId: string; rmaNumber: string | null; customerName: string; status: string; path: string }>;
  };
  needsYou: NeedsYouItem[];
};

const OPEN_RMA_STATUSES = [
  "draft",
  "approved",
  "awaiting_warehouse_number",
  "sent_to_warehouse",
  "received",
] as const;

async function buildSummary(now: Date): Promise<HubSummary> {
  const [chaseAgg, chaseTop, holdCustomers, holdOrders, emailCounts, rmaAgg, rmaTop] =
    await Promise.all([
      db
        .select({ n: count(), total: sum(customers.overdueBalance) })
        .from(customers)
        .where(gt(customers.overdueBalance, "0")),
      db
        .select({ id: customers.id, name: customers.displayName, overdue: customers.overdueBalance })
        .from(customers)
        .where(gt(customers.overdueBalance, "0"))
        .orderBy(desc(customers.overdueBalance))
        .limit(5),
      db
        .select({ n: count() })
        .from(customers)
        .where(inArray(customers.holdStatus, ["hold", "payment_upfront"])),
      listHoldableHoldOrders(50),
      // Same window + status rules as the Email review section; dismissals
      // simply excluded (the section's time-scoped dismissal rule is finer,
      // but a tile count needn't split that hair).
      db
        .select({
          neverEmailed: sql<number>`SUM(CASE WHEN ${invoices.emailStatus} IN (${sql.join(
            [...NOT_EMAILED_STATUSES].map((s) => sql`${s}`),
            sql`, `,
          )}) THEN 1 ELSE 0 END)`,
          deliveryFailed: sql<number>`SUM(CASE WHEN ${invoices.deliveryError} IS NOT NULL THEN 1 ELSE 0 END)`,
        })
        .from(invoices)
        .leftJoin(invoiceEmailDismissals, eq(invoiceEmailDismissals.invoiceId, invoices.id))
        .where(
          and(
            sql`${invoices.issueDate} >= ${emailReviewWindowStart(now)}`,
            isNull(invoiceEmailDismissals.invoiceId),
            sql`(${invoices.emailStatus} IN (${sql.join(
              [...NOT_EMAILED_STATUSES].map((s) => sql`${s}`),
              sql`, `,
            )}) OR ${invoices.deliveryError} IS NOT NULL)`,
          ),
        ),
      db
        .select({
          open: count(),
          awaiting: sql<number>`SUM(CASE WHEN ${rmas.status} = 'received' THEN 1 ELSE 0 END)`,
        })
        .from(rmas)
        .where(inArray(rmas.status, [...OPEN_RMA_STATUSES])),
      db
        .select({
          id: rmas.id,
          rmaNumber: rmas.rmaNumber,
          status: rmas.status,
          updatedAt: rmas.updatedAt,
          customerName: customers.displayName,
        })
        .from(rmas)
        .innerJoin(customers, eq(customers.id, rmas.customerId))
        .where(inArray(rmas.status, [...OPEN_RMA_STATUSES]))
        .orderBy(desc(rmas.updatedAt))
        .limit(5),
    ]);

  const neverEmailed = Number(emailCounts[0]?.neverEmailed ?? 0);
  const deliveryFailed = Number(emailCounts[0]?.deliveryFailed ?? 0);
  const invoicingPath = "/invoicing?section=email-review";

  const needs: NeedsYouItem[] = [];
  for (const o of holdOrders.slice(0, 5)) {
    needs.push({
      kind: "hold",
      title: `Order ${o.orderNumber ?? o.orderId} on hold — ${o.customerName ?? "customer"}`,
      subtitle: o.reason,
      path: `/customers/${o.customerId}`,
      severity: o.heldDays >= 3 ? "todo" : "in-progress",
      since: new Date(now.getTime() - o.heldDays * 86_400_000).toISOString(),
    });
  }
  if (deliveryFailed > 0) {
    needs.push({
      kind: "invoice-email",
      title: `${deliveryFailed} invoice email${deliveryFailed === 1 ? "" : "s"} bounced`,
      subtitle: "Fix the address, then resend from Today",
      path: invoicingPath,
      severity: "in-progress",
      since: now.toISOString(),
    });
  }
  for (const r of rmaTop.filter((x) => x.status === "received")) {
    needs.push({
      kind: "rma",
      title: `RMA ${r.rmaNumber ?? r.id} — ${r.customerName} awaiting credit memo`,
      subtitle: "Received at warehouse",
      path: `/returns/${r.id}`,
      severity: "waiting",
      since: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
    });
  }

  return {
    generatedAt: now.toISOString(),
    chase: {
      accounts: Number(chaseAgg[0]?.n ?? 0),
      totalOverdue: String(chaseAgg[0]?.total ?? "0"),
      top: chaseTop.map((c) => ({
        customerId: c.id,
        name: c.name,
        overdue: String(c.overdue ?? "0"),
        path: `/customers/${c.id}`,
      })),
    },
    holds: {
      customersOnHold: Number(holdCustomers[0]?.n ?? 0),
      ordersOnHold: holdOrders.length,
      top: holdOrders.slice(0, 5).map((o) => ({
        orderId: o.orderId,
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        reason: o.reason,
        heldDays: o.heldDays,
        path: `/customers/${o.customerId}`,
      })),
    },
    invoicing: { neverEmailed, deliveryFailed, path: invoicingPath },
    returns: {
      open: Number(rmaAgg[0]?.open ?? 0),
      awaitingCreditMemo: Number(rmaAgg[0]?.awaiting ?? 0),
      top: rmaTop.map((r) => ({
        rmaId: r.id,
        rmaNumber: r.rmaNumber,
        customerName: r.customerName,
        status: r.status,
        path: `/returns/${r.id}`,
      })),
    },
    needsYou: buildNeedsYou(needs),
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const extHubRoute: FastifyPluginAsync = async (app) => {
  app.get("/hub-summary", async (req, reply) => {
    const secret = env.HUB_SSO_SECRET;
    if (!secret) return reply.code(503).send({ error: "hub not configured" });

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const claims = verifyHubToken(token, {
      secret,
      aud: "finance",
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!claims || claims.scope !== "service") {
      return reply.code(401).send({ error: "invalid hub service token" });
    }
    if (!isEmailAllowed(claims.email, env.ALLOWED_EMAILS)) {
      return reply.code(403).send({ error: "not allowed" });
    }

    try {
      const summary = await buildSummary(new Date());
      reply.header("cache-control", "private, max-age=30");
      return reply.send(summary);
    } catch (err) {
      log.error({ err, email: claims.email }, "hub summary failed");
      return reply.code(500).send({ error: "summary failed" });
    }
  });
};

export default extHubRoute;
