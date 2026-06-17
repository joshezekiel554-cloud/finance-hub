// Event-driven AI-card invalidation.
//
// The per-customer AI summary card is a cached snapshot. When something it
// summarises changes — a new email (in/out), a manual note, a payment or other
// QB-sync activity, a call/SMS — we DROP the cached card so it regenerates
// fresh the next time the customer is opened (refresh-on-view). Invalidation is
// free (a DB delete); the paid LLM regeneration only happens on view, so an
// active mailbox can't burn the AI budget on cards nobody looks at.
//
// All of those changes flow through recordActivity -> the "activity.created"
// domain event (emails from the Gmail poller, notes from the API, payments from
// the QB sync), plus "phone-communication.received" for calls/SMS. So one
// subscription covers them all.
//
// ⚠ The event bus is IN-PROCESS. Notes fire in the WEB server; the Gmail poller
// and QB sync fire in the WORKER. So this must be registered in BOTH processes
// (server boot + worker boot) — each invalidates the shared DB row for events
// emitted in its own process.

import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";
import { invalidateCustomerCard } from "./customer-card.js";

const log = createLogger({ component: "ai-agent.card-invalidation" });

// Activity kinds that DON'T change what the card summarises can be added here
// to avoid a needless regen. Kept as an explicit deny-list so new/unknown kinds
// default to invalidating (safer to over-refresh than show a stale card).
const IGNORED_ACTIVITY_KINDS = new Set<string>();

export function registerCardInvalidation(): () => void {
  const invalidate = (customerId: string, why: string) => {
    void invalidateCustomerCard(customerId).catch((err) =>
      log.warn({ err, customerId, why }, "ai-card invalidation failed"),
    );
  };

  const offActivity = events.on("activity.created", (e) => {
    if (IGNORED_ACTIVITY_KINDS.has(e.kind)) return;
    invalidate(e.customerId, `activity:${e.kind}`);
  });
  const offPhone = events.on("phone-communication.received", (e) => {
    invalidate(e.customerId, "phone-communication");
  });

  log.info({}, "ai-card invalidation listeners registered");
  return () => {
    offActivity();
    offPhone();
  };
}
