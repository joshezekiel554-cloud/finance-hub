// Hold Orders actions — every state change has two modes:
//
//   notify       — the system emails the people the change concerns (the
//                  warehouse alert / "CLEARED — good to send", and, for a hold
//                  that starts the ladder, the customer's Day-0 notice on the
//                  next ladder pass). Exactly the emails the preview lists.
//   record_only  — "the system catches up silently": state, audit and the
//                  inbox thread-resolve hook still happen, but NO email goes
//                  to anyone (warehouse, customer or internal) and the ladder
//                  is not (re)started.
//
// Shopify tags: Feldart's Shopify tags (b2b / b2b-b2b-upfront, see
// modules/holds/apply.ts) are CUSTOMER-level account state that gates the
// B2B storefront. Per-order holds have never touched them (neither the
// existing finance order-hold actions nor these do), so there is nothing to
// keep in sync per order; account-level hold flips stay on finance's customer
// page.
//
// One status record: the order row's hold_* columns. Full history: audit_log
// rows (entity "order"), each carrying actor + mode + who was emailed.

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { loadAppSettings, type AppSettingsMap } from "../statements/settings.js";
import {
  displayOrderNumber,
  planHoldAlertEmail,
  planLadderNoticeEmail,
  planReleaseEmail,
  sendPlannedEmail,
  type LadderNoticeInput,
  type PlannedEmail,
} from "../orders/hold-email-plan.js";
import { manualHoldReasonLine, OVERDUE_HOLD_REASON_LINE, pauseHoldLadder } from "../orders/hold-actions.js";
import { onHoldReleased } from "./inbox-resolve.js";
import { affectedRows } from "./claim.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "hold-orders.actions" });

export type HoldMode = "notify" | "record_only";
export type ManualHoldReason = "manual" | "overdue_non_communicating";
export type PaidOutsideMethod = "cheque" | "stripe" | "bank" | "other";

export type Actor = { userId: string | null; email: string | null };

export type ActionResult =
  | { ok: true; emailed: EmailSummary[] }
  | { ok: false; reason: string };

export type EmailSummary = {
  to: string;
  cc?: string;
  role: PlannedEmail["role"];
  template: PlannedEmail["template"];
  subject: string;
  when: PlannedEmail["when"];
};

export function summarizeEmails(plan: readonly PlannedEmail[]): EmailSummary[] {
  return plan.map((p) => ({
    to: p.to,
    ...(p.cc ? { cc: p.cc } : {}),
    role: p.role,
    template: p.template,
    subject: p.subject,
    when: p.when,
  }));
}

export type OrderCtx = LadderNoticeInput & {
  holdState: string | null;
  holdNote: string | null;
};

export async function loadOrderCtx(orderId: string): Promise<OrderCtx | null> {
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      shopifyOrderId: orders.shopifyOrderId,
      total: orders.total,
      holdState: orders.holdState,
      holdReason: orders.holdReason,
      holdNote: orders.holdNote,
      holdAlertThreadId: orders.holdAlertThreadId,
      holdAlertMessageId: orders.holdAlertMessageId,
      holdLadderPausedUntil: orders.holdLadderPausedUntil,
      customerId: orders.customerId,
      customerName: customers.displayName,
      customerPromisedPayBy: customers.promisedPayBy,
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
      invoiceToEmails: customers.invoiceToEmails,
      invoiceCcEmails: customers.invoiceCcEmails,
      invoiceBccEmails: customers.invoiceBccEmails,
      statementToEmails: customers.statementToEmails,
      statementCcEmails: customers.statementCcEmails,
      statementBccEmails: customers.statementBccEmails,
      tags: customers.tags,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    primaryEmail: r.primaryEmail ?? null,
    billingEmails: r.billingEmails ?? null,
    invoiceToEmails: r.invoiceToEmails ?? null,
    invoiceCcEmails: r.invoiceCcEmails ?? null,
    invoiceBccEmails: r.invoiceBccEmails ?? null,
    statementToEmails: r.statementToEmails ?? null,
    statementCcEmails: r.statementCcEmails ?? null,
    statementBccEmails: r.statementBccEmails ?? null,
    tags: r.tags ?? null,
    customerName: r.customerName ?? null,
    customerPromisedPayBy: r.customerPromisedPayBy ?? null,
  };
}

export type HoldOpts = {
  reason: ManualHoldReason;
  note?: string | null;
  startLadder: boolean;
  mode: HoldMode;
};

function holdReasonLine(reason: ManualHoldReason, note: string | null): string {
  return reason === "overdue_non_communicating"
    ? note
      ? `${OVERDUE_HOLD_REASON_LINE} Note: ${note}`
      : OVERDUE_HOLD_REASON_LINE
    : manualHoldReasonLine(note);
}

/** Exactly the emails a hold would send. record_only → []. */
export async function planHoldAction(
  o: OrderCtx,
  settings: AppSettingsMap,
  opts: HoldOpts,
): Promise<PlannedEmail[]> {
  if (opts.mode === "record_only") return [];
  const note = opts.note?.trim() || null;
  const plan: PlannedEmail[] = [];
  const alert = planHoldAlertEmail(o, settings, {
    reasonLine: holdReasonLine(opts.reason, note),
    holdStatus: opts.reason === "manual" ? "manual" : "overdue",
  });
  if (alert) plan.push(alert);
  if (opts.startLadder) {
    // The ladder will send the Day-0 notice on its next pass, from a FRESH
    // hold (markers reset, pause cleared) with this reason.
    const notice = await planLadderNoticeEmail(
      { ...o, holdReason: opts.reason, holdLadderPausedUntil: null },
      settings,
    );
    if (notice) plan.push(notice);
  }
  return plan;
}

/** Exactly the emails a release would send. record_only → []. */
export function planReleaseAction(
  o: OrderCtx,
  settings: AppSettingsMap,
  mode: HoldMode,
): PlannedEmail[] {
  if (mode === "record_only") return [];
  const p = planReleaseEmail(o, settings);
  return p ? [p] : [];
}

async function audit(args: {
  orderId: string;
  actor: Actor;
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): Promise<string> {
  const id = nanoid(24);
  await db.insert(auditLog).values({
    id,
    userId: args.actor.userId,
    action: args.action,
    entityType: "order",
    entityId: args.orderId,
    before: args.before,
    after: { ...args.after, via: "holdorders", actorEmail: args.actor.email },
  });
  return id;
}

export async function holdOrder(
  orderId: string,
  actor: Actor,
  opts: HoldOpts,
): Promise<ActionResult> {
  const o = await loadOrderCtx(orderId);
  if (!o) return { ok: false, reason: "not_found" };
  if (o.holdState === "on_hold") return { ok: false, reason: "already_on_hold" };
  if (o.holdState === "cancelled") return { ok: false, reason: "cancelled" };

  const note = opts.note?.trim() || null;
  const settings = await loadAppSettings();
  const plan = await planHoldAction(o, settings, opts);

  // 1) CLAIM the transition from the state we loaded. Someone else holding
  //    it (or a rule pass) in between → 0 rows → nothing sent.
  const now = new Date();
  const ladder = opts.mode === "notify" && opts.startLadder;
  const fromState = (o.holdState ?? "none") as "none" | "released";
  const claimed = affectedRows(
    await db
      .update(orders)
      .set({
        holdState: "on_hold",
        holdReason: opts.reason,
        holdNote: note,
        holdLadderEnabled: ladder,
        holdLadderPausedUntil: null,
        holdLadderPauseNote: null,
        holdStartedAt: now,
        // Always stamped: marks the hold as handled so the standard detection
        // pass never sends its own alert for this order (a record-only hold
        // must stay silent).
        holdAlertedAt: now,
        holdAlertThreadId: null,
        holdAlertMessageId: null,
        holdNoticeAt: null,
        holdWarnedAt: null,
        holdCancelNotifiedAt: null,
        holdReleasedAt: null,
        holdReleasedByUserId: null,
      })
      .where(and(eq(orders.id, orderId), eq(orders.holdState, fromState))),
  );
  if (claimed !== 1) return { ok: false, reason: "changed_concurrently" };

  // 2) SEND (claimer only), then stamp the alert thread for the release reply.
  let threadId: string | null = null;
  let messageId: string | null = null;
  if (!env.SHADOW_MODE) {
    for (const p of plan) {
      if (p.when !== "now") continue;
      try {
        const r = await sendPlannedEmail(p);
        if (p.template === "hold_alert") {
          threadId = r.threadId;
          messageId = r.messageId;
        }
      } catch (err) {
        // Never block the state change on an email.
        log.error({ err, orderId, template: p.template }, "hold: email failed");
      }
    }
  }
  if (threadId || messageId) {
    await db
      .update(orders)
      .set({ holdAlertThreadId: threadId, holdAlertMessageId: messageId })
      .where(eq(orders.id, orderId));
  }
  const emailed = summarizeEmails(plan);
  await audit({
    orderId,
    actor,
    action: "order.hold_started",
    before: { holdState: o.holdState },
    after: {
      holdState: "on_hold",
      holdReason: opts.reason,
      mode: opts.mode,
      startLadder: ladder,
      note,
      emailed,
      shadowMode: env.SHADOW_MODE,
    },
  });
  log.info({ orderId, mode: opts.mode, reason: opts.reason, ladder }, "hold-orders: order held");
  return { ok: true, emailed };
}

export type ReleaseOpts = {
  mode: HoldMode;
  note?: string | null;
  paidOutsideQbo?: { method: PaidOutsideMethod; note: string } | null;
};

export async function releaseOrder(
  orderId: string,
  actor: Actor,
  opts: ReleaseOpts,
): Promise<ActionResult> {
  const o = await loadOrderCtx(orderId);
  if (!o) return { ok: false, reason: "not_found" };
  if (o.holdState !== "on_hold") return { ok: false, reason: "not_on_hold" };
  if (opts.paidOutsideQbo && !opts.paidOutsideQbo.note.trim()) {
    return { ok: false, reason: "paid_outside_note_required" };
  }

  const settings = await loadAppSettings();
  const plan = planReleaseAction(o, settings, opts.mode);

  // 1) CLAIM on_hold → released; a concurrent release / auto-release wins → stop.
  const now = new Date();
  const claimed = affectedRows(
    await db
      .update(orders)
      .set({
        holdState: "released",
        holdReleasedAt: now,
        holdReleasedByUserId: actor.userId,
      })
      .where(and(eq(orders.id, orderId), eq(orders.holdState, "on_hold"))),
  );
  if (claimed !== 1) return { ok: false, reason: "changed_concurrently" };

  // 2) SEND (claimer only).
  if (!env.SHADOW_MODE) {
    for (const p of plan) {
      try {
        await sendPlannedEmail(p);
      } catch (err) {
        log.error({ err, orderId, template: p.template }, "release: email failed");
      }
    }
  }
  const note = opts.note?.trim() || null;
  const paid = opts.paidOutsideQbo
    ? { method: opts.paidOutsideQbo.method, note: opts.paidOutsideQbo.note.trim() }
    : null;
  const emailed = summarizeEmails(plan);
  await audit({
    orderId,
    actor,
    action: "order.hold_released",
    before: { holdState: "on_hold", holdReason: o.holdReason },
    after: {
      holdState: "released",
      mode: opts.mode,
      note,
      paidOutsideQbo: paid,
      emailed,
      shadowMode: env.SHADOW_MODE,
    },
  });

  const noteParts = [
    paid ? `Paid outside QBO (${paid.method}): ${paid.note}` : null,
    note,
    opts.mode === "record_only" ? "Recorded only — nobody emailed." : "Warehouse told to ship.",
  ].filter((s): s is string => Boolean(s));
  onHoldReleased({
    orderId,
    customerId: o.customerId,
    orderNumber: displayOrderNumber(o),
    action: opts.mode === "record_only" ? "recorded" : "released",
    note: noteParts.join(" · "),
    actingEmail: actor.email,
    idempotencyKey: `hold-release:${orderId}:${now.getTime()}`,
  });
  log.info({ orderId, mode: opts.mode, paidOutside: Boolean(paid) }, "hold-orders: order released");
  return { ok: true, emailed };
}

export async function pauseOrder(
  orderId: string,
  actor: Actor,
  opts: { until: Date | null; note?: string | null },
): Promise<ActionResult> {
  const r = await pauseHoldLadder(orderId, actor.userId, opts);
  if (!r.ok) return r;
  return { ok: true, emailed: [] };
}

export async function addHoldNote(
  orderId: string,
  actor: Actor,
  note: string,
): Promise<ActionResult> {
  const text = note.trim();
  if (!text) return { ok: false, reason: "empty_note" };
  const o = await db
    .select({ id: orders.id, holdState: orders.holdState })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!o[0]) return { ok: false, reason: "not_found" };
  await audit({
    orderId,
    actor,
    action: "order.hold_note",
    before: {},
    after: { note: text.slice(0, 1000), holdState: o[0].holdState },
  });
  return { ok: true, emailed: [] };
}

export type PreviewEmail = EmailSummary & { body: string };

export type PreviewResult = {
  emails: PreviewEmail[];
  // In shadow mode nothing actually sends, whatever the plan says.
  shadowMode: boolean;
};

export const FINANCE_LINK_HIDDEN = "(finance customer link — not shown)";

/**
 * Hide finance customer-page links (`<PUBLIC_URL>/customers/<id>`) from a
 * preview body. For viewers who can't open finance (the holds role) — the
 * email actually sent to the warehouse is unchanged.
 */
export function redactFinanceLinks(text: string, publicUrl: string): string {
  const base = publicUrl.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${base}/customers/[A-Za-z0-9_-]+`, "g"), FINANCE_LINK_HIDDEN);
}

export async function previewAction(
  orderId: string,
  input:
    | { action: "hold"; opts: HoldOpts }
    | { action: "release"; mode: HoldMode },
  view: { hideFinanceLinks: boolean } = { hideFinanceLinks: false },
): Promise<PreviewResult | null> {
  const o = await loadOrderCtx(orderId);
  if (!o) return null;
  const settings = await loadAppSettings();
  const plan =
    input.action === "hold"
      ? await planHoldAction(o, settings, input.opts)
      : planReleaseAction(o, settings, input.mode);
  const summaries = summarizeEmails(plan);
  const emails = summaries.map((s, i) => {
    const text = plan[i]!.text;
    return { ...s, body: view.hideFinanceLinks ? redactFinanceLinks(text, env.PUBLIC_URL) : text };
  });
  return { emails, shadowMode: env.SHADOW_MODE };
}
