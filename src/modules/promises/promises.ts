// Customer-level "promised to pay by" (hub Chief of Staff phase 2).
//
//   setPromise   — saves customers.promised_pay_by/_note/_set_by/_set_at, pauses
//                  the hold ladder on each of the customer's on-hold orders
//                  until the end of that day (same as the order-level picker),
//                  writes a timeline note + an audit row. Idempotent: the same
//                  date + note again is a no-op.
//   clearPromise — removes it, resumes order pauses that came from it, and
//                  records the clear on the timeline + audit log.
//
// Every chase path checks isPromiseActive / noActivePromiseSql (promise-state.ts),
// so a saved promise silences chasing through the promised day.

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { users } from "../../db/schema/auth.js";
import { orders } from "../../db/schema/catalog.js";
import { customers } from "../../db/schema/customers.js";
import { createLogger } from "../../lib/logger.js";
import { recordActivity, type RecordActivityInput } from "../crm/activity-ingester.js";
import { pauseHoldLadder } from "../orders/hold-actions.js";
import { endOfDayNewYork, promiseDateError, toYmd } from "./promise-state.js";

const log = createLogger({ component: "promises" });

export const PROMISE_NOTE_MAX = 300;

export type PromiseSource = "hub" | "finance";

export type CustomerPromise = {
  customerId: string;
  promisedBy: string; // YYYY-MM-DD
  note: string | null;
  setBy: string | null;
};

export type PromiseResult =
  | { ok: true; changed: boolean; promise: CustomerPromise | null }
  | { ok: false; reason: "bad_date" | "not_found"; error: string };

type CustomerPromiseRow = {
  id: string;
  displayName: string;
  promisedPayBy: string | Date | null;
  promiseNote: string | null;
  promiseSetBy: string | null;
  promiseSetAt: Date | null;
};

type HeldOrderRow = { id: string; holdLadderPausedUntil: Date | string | null };

/** DB seams — replaceable in tests (tj-chase.ts pattern). */
export type PromiseDeps = {
  loadCustomer: (customerId: string) => Promise<CustomerPromiseRow | null>;
  saveCustomer: (
    customerId: string,
    fields: { promisedPayBy: string | null; promiseNote: string | null; promiseSetBy: string | null; promiseSetAt: Date | null },
  ) => Promise<void>;
  listHeldOrders: (customerId: string) => Promise<HeldOrderRow[]>;
  pauseOrder: (orderId: string, userId: string | null, until: Date | null, note: string | null) => Promise<{ ok: boolean; reason?: string }>;
  recordActivity: (input: RecordActivityInput) => Promise<string | null>;
  writeAudit: (row: { userId: string | null; action: string; entityId: string; before: Record<string, unknown>; after: Record<string, unknown> }) => Promise<void>;
  userIdFor: (email: string) => Promise<string | null>;
  now: () => Date;
};

export const defaultPromiseDeps: PromiseDeps = {
  async loadCustomer(customerId) {
    const [row] = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        promisedPayBy: customers.promisedPayBy,
        promiseNote: customers.promiseNote,
        promiseSetBy: customers.promiseSetBy,
        promiseSetAt: customers.promiseSetAt,
      })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    return row ?? null;
  },
  async saveCustomer(customerId, fields) {
    await db.update(customers).set(fields).where(eq(customers.id, customerId));
  },
  async listHeldOrders(customerId) {
    return db
      .select({ id: orders.id, holdLadderPausedUntil: orders.holdLadderPausedUntil })
      .from(orders)
      .where(and(eq(orders.customerId, customerId), eq(orders.holdState, "on_hold")));
  },
  async pauseOrder(orderId, userId, until, note) {
    return pauseHoldLadder(orderId, userId, { until, note });
  },
  recordActivity: (input) => recordActivity(input),
  async writeAudit(row) {
    await db.insert(auditLog).values({ id: nanoid(24), entityType: "customer", ...row });
  },
  async userIdFor(email) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
    return u?.id ?? null;
  },
  now: () => new Date(),
};

const normNote = (n: string | null | undefined): string | null => {
  const t = (n ?? "").trim().replace(/\s+/g, " ");
  return t ? t.slice(0, PROMISE_NOTE_MAX) : null;
};

/** Timeline text for a saved promise. */
export function promiseNoteText(p: { date: string; note: string | null; source: PromiseSource; actorEmail: string }): string {
  return `Promise: pay by ${p.date}${p.note ? ` — ${p.note}` : ""} (via ${p.source}, ${p.actorEmail})`;
}

export async function setPromise(
  input: { customerId: string; date: string; note?: string | null; actorEmail: string; source: PromiseSource; userId?: string | null },
  deps: PromiseDeps = defaultPromiseDeps,
): Promise<PromiseResult> {
  const now = deps.now();
  const dateErr = promiseDateError(input.date, now);
  if (dateErr) return { ok: false, reason: "bad_date", error: dateErr };

  const cust = await deps.loadCustomer(input.customerId);
  if (!cust) return { ok: false, reason: "not_found", error: "unknown customer" };

  const note = normNote(input.note);
  const actor = input.actorEmail.trim().toLowerCase();
  const prevDate = toYmd(cust.promisedPayBy);

  // Same date + same note = no-op (the hub may retry).
  if (prevDate === input.date && normNote(cust.promiseNote) === note) {
    return {
      ok: true,
      changed: false,
      promise: { customerId: cust.id, promisedBy: input.date, note, setBy: cust.promiseSetBy },
    };
  }

  const userId = input.userId !== undefined ? input.userId : await deps.userIdFor(actor);

  await deps.saveCustomer(cust.id, {
    promisedPayBy: input.date,
    promiseNote: note,
    promiseSetBy: actor,
    promiseSetAt: now,
  });

  // Mirror onto every on-hold order so the hold ladder (and the order's own
  // "chasing paused" chip) agrees. Best-effort per order.
  const until = endOfDayNewYork(input.date);
  const pausedOrders: string[] = [];
  for (const o of await deps.listHeldOrders(cust.id)) {
    try {
      const r = await deps.pauseOrder(o.id, userId, until, note);
      if (r.ok) pausedOrders.push(o.id);
      else log.warn({ orderId: o.id, reason: r.reason }, "promise: could not pause order ladder");
    } catch (err) {
      log.warn({ err, orderId: o.id }, "promise: pausing order ladder failed");
    }
  }

  await deps.recordActivity({
    customerId: cust.id,
    kind: "manual_note",
    source: "user_action",
    userId,
    subject: "Promise to pay",
    body: promiseNoteText({ date: input.date, note, source: input.source, actorEmail: actor }),
    refType: "customer_promise",
    refId: cust.id,
    meta: { source: input.source, promisedBy: input.date, setBy: actor, note },
  });

  await deps.writeAudit({
    userId,
    action: "customer.promise_set",
    entityId: cust.id,
    before: { promisedPayBy: prevDate, promiseNote: cust.promiseNote, promiseSetBy: cust.promiseSetBy },
    after: { promisedPayBy: input.date, promiseNote: note, promiseSetBy: actor, source: input.source, pausedOrders },
  });

  log.info({ customerId: cust.id, promisedBy: input.date, source: input.source, pausedOrders: pausedOrders.length }, "customer promise saved");
  return { ok: true, changed: true, promise: { customerId: cust.id, promisedBy: input.date, note, setBy: actor } };
}

export async function clearPromise(
  input: { customerId: string; actorEmail: string; source: PromiseSource; userId?: string | null },
  deps: PromiseDeps = defaultPromiseDeps,
): Promise<PromiseResult> {
  const cust = await deps.loadCustomer(input.customerId);
  if (!cust) return { ok: false, reason: "not_found", error: "unknown customer" };
  const prevDate = toYmd(cust.promisedPayBy);
  if (!prevDate) return { ok: true, changed: false, promise: null };

  const actor = input.actorEmail.trim().toLowerCase();
  const userId = input.userId !== undefined ? input.userId : await deps.userIdFor(actor);

  await deps.saveCustomer(cust.id, { promisedPayBy: null, promiseNote: null, promiseSetBy: null, promiseSetAt: null });

  // Resume only the order pauses this promise created (same end-of-day
  // instant); a pause someone set by hand for another date stays.
  const until = endOfDayNewYork(prevDate)?.getTime();
  const resumed: string[] = [];
  for (const o of await deps.listHeldOrders(cust.id)) {
    const t = o.holdLadderPausedUntil ? new Date(o.holdLadderPausedUntil).getTime() : NaN;
    if (until === undefined || t !== until) continue;
    try {
      const r = await deps.pauseOrder(o.id, userId, null, null);
      if (r.ok) resumed.push(o.id);
    } catch (err) {
      log.warn({ err, orderId: o.id }, "promise clear: resuming order ladder failed");
    }
  }

  await deps.recordActivity({
    customerId: cust.id,
    kind: "manual_note",
    source: "user_action",
    userId,
    subject: "Promise cleared",
    body: `Promise cleared (was: pay by ${prevDate}${cust.promiseNote ? ` — ${cust.promiseNote}` : ""}) (via ${input.source}, ${actor})`,
    refType: "customer_promise",
    refId: cust.id,
    meta: { source: input.source, cleared: true, promisedBy: prevDate, clearedBy: actor },
  });

  await deps.writeAudit({
    userId,
    action: "customer.promise_cleared",
    entityId: cust.id,
    before: { promisedPayBy: prevDate, promiseNote: cust.promiseNote, promiseSetBy: cust.promiseSetBy },
    after: { promisedPayBy: null, source: input.source, resumedOrders: resumed },
  });

  log.info({ customerId: cust.id, was: prevDate, resumed: resumed.length }, "customer promise cleared");
  return { ok: true, changed: true, promise: null };
}
