// GET /api/ext/hub-summary — finance's Home tile for hub.feldart.com
// (hub phase-1 spec §6). Read-only.
//
// Auth: `Authorization: Bearer <hub token>` with scope "service" and
// aud "finance", minted by the hub for the signed-in user. We verify the
// signature + apply ALLOWED_EMAILS so the hub can only read what that user
// could read. Not gated by the inbox_integration flag — different consumer.
// Like the rest of /api/ext this is loopback-only behind nginx.
//
// Wire contract (inbox agent, 2026-09-14 15:36 — frozen for phase 1):
//   { chase: [{customer, days, level, amount, url}] ≤5, chaseTotal, chaseAccounts,
//     holds: {count, items: [{order, customer, reason, age, url}]},
//     invoicing: {toInvoice, needingReview, bounced},
//     returns: [{rma, customer, status, url}],
//     needsYou: [{id, kind, title, detail, age, urgency, url}] ≤5,
//     syncedAt }
// camelCase, money as decimal strings, `url` = FULL finance URL (the hub
// turns it into a deep link), `age` = compact human label ("14m", "3h", "6d").

import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, gt, inArray, isNull, sql, sum } from "drizzle-orm";
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
import type { MoneySummary } from "../../modules/dashboard/money.js";
import { getMoneySummaryCached } from "./dashboard-money.js";
import { isEmailAllowed } from "../lib/hub-handoff.js";

const log = createLogger({ component: "routes.ext-hub" });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type NeedsYouKind = "decision" | "bounce" | "return" | "hold";
export type NeedsYouUrgency = "now" | "today";

/** Internal candidate: like the wire item but with a real timestamp for sorting. */
export type NeedsYouCandidate = {
  id: string;
  kind: NeedsYouKind;
  title: string;
  detail: string | null;
  url: string;
  urgency: NeedsYouUrgency;
  since: Date;
};

export type NeedsYouItem = {
  id: string;
  kind: NeedsYouKind;
  title: string;
  detail: string | null;
  /** Compact human label ("14m", "3h", "6d") — displayed as-is by the hub. */
  age: string;
  /** ISO twin of `age` — the hub sorts its merged inbox+finance list on it. */
  at: string;
  urgency: NeedsYouUrgency;
  url: string;
};

export const NEEDS_YOU_LIMIT = 5;

export function ageLabel(since: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - since.getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function buildNeedsYou(items: readonly NeedsYouCandidate[], now: Date): NeedsYouItem[] {
  const rank: Record<NeedsYouUrgency, number> = { now: 0, today: 1 };
  return [...items]
    .sort((a, b) => {
      const r = rank[a.urgency] - rank[b.urgency];
      if (r !== 0) return r;
      return a.since.getTime() - b.since.getTime();
    })
    .slice(0, NEEDS_YOU_LIMIT)
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      title: c.title,
      detail: c.detail,
      age: ageLabel(c.since, now),
      at: c.since.toISOString(),
      urgency: c.urgency,
      url: c.url,
    }));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type HubSummary = {
  chase: Array<{ customer: string; days: number | null; level: string | null; amount: string; url: string }>;
  chaseTotal: string;
  chaseAccounts: number;
  holds: {
    count: number;
    items: Array<{ order: string; customer: string; reason: string | null; age: string; at: string; url: string }>;
  };
  invoicing: { toInvoice: number | null; needingReview: number; bounced: number };
  returns: Array<{ rma: string; customer: string; status: string; at: string; url: string }>;
  needsYou: NeedsYouItem[];
  /** The dashboard's Money section, verbatim — see modules/dashboard/money.ts. */
  money: MoneySummary;
  syncedAt: string;
};

const OPEN_RMA_STATUSES = [
  "draft",
  "approved",
  "awaiting_warehouse_number",
  "sent_to_warehouse",
  "received",
] as const;

async function buildSummary(now: Date): Promise<HubSummary> {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const url = (path: string) => `${base}${path}`;
  const notEmailedList = sql.join(
    [...NOT_EMAILED_STATUSES].map((s) => sql`${s}`),
    sql`, `,
  );

  const [chaseAgg, chaseTop, holdOrders, emailCounts, rmaTop, money] = await Promise.all([
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
    listHoldableHoldOrders(50),
    // Same window + status rules as the Email review section; dismissed
    // invoices excluded (the section's time-scoped dismissal rule is finer,
    // but a tile count needn't split that hair).
    db
      .select({
        needingReview: sql<number>`SUM(CASE WHEN ${invoices.emailStatus} IN (${notEmailedList}) THEN 1 ELSE 0 END)`,
        bounced: sql<number>`SUM(CASE WHEN ${invoices.deliveryError} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(invoices)
      .leftJoin(invoiceEmailDismissals, eq(invoiceEmailDismissals.invoiceId, invoices.id))
      .where(
        and(
          sql`${invoices.issueDate} >= ${emailReviewWindowStart(now)}`,
          isNull(invoiceEmailDismissals.invoiceId),
          sql`(${invoices.emailStatus} IN (${notEmailedList}) OR ${invoices.deliveryError} IS NOT NULL)`,
        ),
      ),
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
    getMoneySummaryCached(now),
  ]);

  const needingReview = Number(emailCounts[0]?.needingReview ?? 0);
  const bounced = Number(emailCounts[0]?.bounced ?? 0);
  const reviewUrl = url("/invoicing?section=email-review");

  const candidates: NeedsYouCandidate[] = [];
  for (const o of holdOrders.slice(0, 5)) {
    candidates.push({
      id: `hold:${o.orderId}`,
      kind: "hold",
      title: `Order ${o.orderNumber ?? o.orderId} on hold — ${o.customerName ?? "customer"}`,
      detail: o.reason,
      url: url(`/customers/${o.customerId}`),
      urgency: o.heldDays >= 3 ? "now" : "today",
      since: new Date(now.getTime() - o.heldDays * 86_400_000),
    });
  }
  if (bounced > 0) {
    candidates.push({
      id: "bounce:email-review",
      kind: "bounce",
      title: `${bounced} invoice email${bounced === 1 ? "" : "s"} bounced`,
      detail: "Fix the address, then resend from Today",
      url: reviewUrl,
      urgency: "today",
      since: now,
    });
  }
  for (const r of rmaTop.filter((x) => x.status === "received")) {
    const since = r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt);
    candidates.push({
      id: `return:${r.id}`,
      kind: "return",
      title: `RMA ${r.rmaNumber ?? r.id} — ${r.customerName} awaiting credit memo`,
      detail: "Received at warehouse",
      url: url(`/returns/${r.id}`),
      urgency: "today",
      since,
    });
  }

  return {
    chase: chaseTop.map((c) => ({
      customer: c.name,
      days: null, // per-customer days overdue isn't denormalised; phase 2
      level: null,
      amount: String(c.overdue ?? "0"),
      url: url(`/customers/${c.id}`),
    })),
    chaseTotal: String(chaseAgg[0]?.total ?? "0"),
    chaseAccounts: Number(chaseAgg[0]?.n ?? 0),
    holds: {
      count: holdOrders.length,
      items: holdOrders.slice(0, 5).map((o) => ({
        order: o.orderNumber ?? o.orderId,
        customer: o.customerName ?? "",
        reason: o.reason,
        age: `${o.heldDays}d`,
        at: new Date(now.getTime() - o.heldDays * 86_400_000).toISOString(),
        url: url(`/customers/${o.customerId}`),
      })),
    },
    // toInvoice needs the warehouse-email parse (Gmail + email_log merge);
    // too heavy for a 60 s tile in phase 1 — null means "not provided".
    invoicing: { toInvoice: null, needingReview, bounced },
    returns: rmaTop.map((r) => ({
      rma: r.rmaNumber ?? r.id,
      customer: r.customerName,
      status: r.status,
      at: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
      url: url(`/returns/${r.id}`),
    })),
    needsYou: buildNeedsYou(candidates, now),
    money,
    syncedAt: now.toISOString(),
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
