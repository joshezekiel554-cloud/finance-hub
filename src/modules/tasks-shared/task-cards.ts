// Finance operational queues as LIVE board cards (shared-tasks M3).
//
// getTaskCards() assembles the actionable finance queues fresh on every call —
// they are NOT stored tasks. The inbox board polls GET /api/ext/task-cards and
// renders these as a third card type (alongside threads + tasks). Because the
// feed is read live from finance state, auto-clear is free: when a hold is
// released / a proposal is approved / an overdue balance settles, the source row
// drops out and the card simply disappears on the next board refresh. Zero
// stored state, no drift.
//
// Card types + V1 action depth (finance-lane spec §6):
//   hold            ← orders.holdState='on_hold' (listHoldableHoldOrders)
//                     → Good-to-send + Cancel (api) + Chase (link)
//   overdue_review  ← listFlaggedOverdueOrders (already excludes dismissed)
//                     → Place-on-hold + Dismiss (api)
//   ai_proposal     ← pending/drafted ai_proposals
//                     → Approve + Reject (api) + context in meta
//   chase           ← dunning queue (getOverdueCustomers)  → deep-LINK only
//   rma             ← stalled RMAs (findCandidates)        → deep-LINK only
//
// The reused feed functions own the business rules; this module only shapes them
// into cards + attaches the action descriptors the board needs.

import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";
import { customers } from "../../db/schema/customers.js";
import { createLogger } from "../../lib/logger.js";
import { listHoldableHoldOrders } from "../orders/hold-alerts.js";
import { listFlaggedOverdueOrders } from "../orders/overdue-alerts.js";
import { getOverdueCustomers } from "../chase/lookups.js";
import { findCandidates as findStalledRmas } from "../ai-agent/candidates/ops-rma-stalled.js";

const log = createLogger({ component: "tasks-shared.task-cards" });

// Board column. v1: every queue card needs operator action, so they all land in
// TODO. (Column mapping vs a dedicated "Finance queue" swimlane is an open
// question with inbox — see finance-lane spec §6 / open questions.)
export const TASK_CARD_COLUMN = "TODO";

export type TaskCardType =
  | "hold"
  | "overdue_review"
  | "ai_proposal"
  | "chase"
  | "rma";

export type TaskCardAction =
  | {
      label: string;
      kind: "api";
      method: "POST";
      // Path the inbox board POSTs to (relative to finance origin). The board
      // adds the bearer token + {actorEmail, actorTeamMemberId} body.
      endpoint: string;
    }
  | {
      label: string;
      kind: "link";
      // Deep-link into finance (relative path; board prefixes the finance origin).
      url: string;
    };

export type TaskCard = {
  id: string; // `${type}:${entityId}` — stable, lets the action route re-derive type+id
  type: TaskCardType;
  title: string;
  customerId: string | null;
  customerName: string | null;
  column: string;
  meta: Record<string, unknown>;
  actions: TaskCardAction[];
};

// Per-feed caps so a board poll can never pull an unbounded list.
const HOLD_LIMIT = 25;
const OVERDUE_LIMIT = 25;
const PROPOSAL_LIMIT = 50;
const CHASE_LIMIT = 25;
const RMA_LIMIT = 25;

function actionEndpoint(
  type: TaskCardType,
  entityId: string,
  action: string,
): string {
  return `/api/ext/task-cards/${type}/${encodeURIComponent(entityId)}/${action}`;
}

function customerLink(customerId: string | null): string {
  return customerId ? `/customers/${customerId}` : "/customers";
}

// ── hold ──────────────────────────────────────────────────────────────────
async function holdCards(): Promise<TaskCard[]> {
  const rows = await listHoldableHoldOrders(HOLD_LIMIT);
  return rows.map((r) => {
    const orderNumber = r.orderNumber ?? `#${r.orderId}`;
    return {
      id: `hold:${r.orderId}`,
      type: "hold" as const,
      title: `Hold: order ${orderNumber} — ${r.customerName ?? "(unknown)"}`,
      customerId: r.customerId,
      customerName: r.customerName,
      column: TASK_CARD_COLUMN,
      meta: {
        orderId: r.orderId,
        orderNumber,
        orderDate: r.orderDate,
        orderTotal: r.orderTotal,
        reason: r.reason,
        heldDays: r.heldDays,
      },
      actions: [
        {
          label: "Good to send",
          kind: "api",
          method: "POST",
          endpoint: actionEndpoint("hold", r.orderId, "good-to-send"),
        },
        {
          label: "Cancel",
          kind: "api",
          method: "POST",
          endpoint: actionEndpoint("hold", r.orderId, "cancel"),
        },
        { label: "Chase", kind: "link", url: customerLink(r.customerId) },
      ],
    };
  });
}

// ── overdue_review ──────────────────────────────────────────────────────────
async function overdueReviewCards(): Promise<TaskCard[]> {
  const rows = await listFlaggedOverdueOrders(OVERDUE_LIMIT);
  return rows.map((r) => {
    const orderNumber = r.orderNumber ?? `#${r.orderId}`;
    return {
      id: `overdue_review:${r.orderId}`,
      type: "overdue_review" as const,
      title: `Review order ${orderNumber} — ${r.customerName ?? "(unknown)"} (${r.overdueBalance} overdue)`,
      customerId: r.customerId,
      customerName: r.customerName,
      column: TASK_CARD_COLUMN,
      meta: {
        orderId: r.orderId,
        orderNumber,
        orderDate: r.orderDate,
        orderTotal: r.orderTotal,
        overdueBalance: r.overdueBalance,
        alerted: r.alerted,
      },
      actions: [
        {
          label: "Place on hold",
          kind: "api",
          method: "POST",
          endpoint: actionEndpoint("overdue_review", r.orderId, "place-on-hold"),
        },
        {
          label: "Dismiss",
          kind: "api",
          method: "POST",
          endpoint: actionEndpoint("overdue_review", r.orderId, "dismiss"),
        },
      ],
    };
  });
}

// ── ai_proposal ─────────────────────────────────────────────────────────────
// The active proposal queue (same filter as the /autopilot list: not terminal,
// not silently-snoozed, not expired). Joins customer name when the proposal is
// customer-scoped. Carries enough context in meta for the board to render the
// proposal + its Approve/Reject buttons.
async function aiProposalCards(): Promise<TaskCard[]> {
  const rows = await db
    .select({
      id: aiProposals.id,
      category: aiProposals.category,
      origin: aiProposals.origin,
      status: aiProposals.status,
      entityType: aiProposals.entityType,
      entityId: aiProposals.entityId,
      candidateSummary: aiProposals.candidateSummary,
      draftedPreview: aiProposals.draftedPreview,
      reasoning: aiProposals.reasoning,
      confidence: aiProposals.confidence,
      customerName: customers.displayName,
    })
    .from(aiProposals)
    .leftJoin(
      customers,
      and(
        eq(aiProposals.entityType, "customer"),
        eq(aiProposals.entityId, customers.id),
      ),
    )
    .where(
      and(
        sql`${aiProposals.status} NOT IN ('executed', 'expired', 'superseded', 'dismissed', 'rejected', 'approved')`,
        or(
          sql`${aiProposals.status} != 'snoozed'`,
          sql`${aiProposals.snoozedUntil} <= NOW()`,
        ),
        sql`${aiProposals.expiresAt} > NOW()`,
      ),
    )
    .orderBy(desc(aiProposals.createdAt))
    .limit(PROPOSAL_LIMIT);

  return rows.map((r) => {
    const customerId = r.entityType === "customer" ? r.entityId : null;
    const customerName = customerId ? r.customerName : null;
    const subject =
      (r.candidateSummary as { subject?: unknown } | null)?.subject;
    return {
      id: `ai_proposal:${r.id}`,
      type: "ai_proposal" as const,
      title: `AI: ${r.category}${customerName ? ` — ${customerName}` : ""}`,
      customerId,
      customerName,
      column: TASK_CARD_COLUMN,
      meta: {
        proposalId: r.id,
        category: r.category,
        origin: r.origin,
        status: r.status,
        entityType: r.entityType,
        entityId: r.entityId,
        confidence: r.confidence,
        reasoning: r.reasoning,
        preview: r.draftedPreview,
        subject: typeof subject === "string" ? subject : null,
        candidateSummary: r.candidateSummary,
      },
      actions: [
        {
          label: "Approve",
          kind: "api",
          method: "POST",
          endpoint: actionEndpoint("ai_proposal", r.id, "approve"),
        },
        {
          label: "Reject",
          kind: "api",
          method: "POST",
          endpoint: actionEndpoint("ai_proposal", r.id, "reject"),
        },
      ],
    };
  });
}

// ── chase (deep-link only) ──────────────────────────────────────────────────
// The dunning queue is too rich for a one-click board button in v1, so chase
// cards are link-only: they surface the overdue account and deep-link into the
// finance chase/customer screen. Top accounts by severity score.
async function chaseCards(): Promise<TaskCard[]> {
  const rows = await getOverdueCustomers();
  return rows.slice(0, CHASE_LIMIT).map((r) => ({
    id: `chase:${r.customerId}`,
    type: "chase" as const,
    title: `Chase: ${r.customer.displayName ?? "(unknown)"} — ${r.severity.totalOverdue.toFixed(2)} overdue`,
    customerId: r.customerId,
    customerName: r.customer.displayName,
    column: TASK_CARD_COLUMN,
    meta: {
      totalOverdue: r.severity.totalOverdue,
      daysOverdue: r.severity.daysOverdue,
      tier: r.severity.tier,
      score: r.severity.score,
    },
    actions: [
      { label: "Open in finance", kind: "link", url: customerLink(r.customerId) },
    ],
  }));
}

// ── rma (deep-link only) ────────────────────────────────────────────────────
// RMA resolution is a multi-step workflow; real card actions land later. v1 is a
// deep-link card listing the stalled RMA.
async function rmaCards(): Promise<TaskCard[]> {
  const rows = await findStalledRmas();
  return rows.slice(0, RMA_LIMIT).map((r) => {
    const s = r.summary as {
      rmaNumber?: unknown;
      customerName?: unknown;
      status?: unknown;
      daysInState?: unknown;
    };
    const rmaNumber = typeof s.rmaNumber === "string" ? s.rmaNumber : r.entityId;
    const customerName =
      typeof s.customerName === "string" ? s.customerName : null;
    return {
      id: `rma:${r.entityId}`,
      type: "rma" as const,
      title: `RMA ${rmaNumber}${customerName ? ` — ${customerName}` : ""} stalled`,
      customerId: null,
      customerName,
      column: TASK_CARD_COLUMN,
      meta: {
        rmaId: r.entityId,
        rmaNumber,
        status: s.status ?? null,
        daysInState: s.daysInState ?? null,
      },
      actions: [
        { label: "Open RMA in finance", kind: "link", url: `/rmas/${r.entityId}` },
      ],
    };
  });
}

// Assemble the full live feed. Feeds run in parallel; any one failing should not
// blank the whole board, so each is wrapped — a failed feed contributes [].
export async function getTaskCards(): Promise<TaskCard[]> {
  const feeds: Array<[TaskCardType, () => Promise<TaskCard[]>]> = [
    ["hold", holdCards],
    ["overdue_review", overdueReviewCards],
    ["ai_proposal", aiProposalCards],
    ["chase", chaseCards],
    ["rma", rmaCards],
  ];
  const settled = await Promise.allSettled(feeds.map(([, fn]) => fn()));
  const cards: TaskCard[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      cards.push(...r.value);
    } else {
      log.error({ feed: feeds[i]?.[0] ?? "unknown", err: r.reason }, "task-card feed failed");
    }
  });
  return cards;
}
