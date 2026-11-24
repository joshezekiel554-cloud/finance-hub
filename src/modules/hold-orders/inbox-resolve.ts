// onHoldReleased → inbox-4's "resolve the ⚠ HOLD thread" endpoint.
//
// Contract (inbox-4, confirmed 2026-11-24):
//   POST {INBOX_HOLD_RESOLVE_URL}   Authorization: Bearer <INBOX_SERVICE_TOKEN>
//   { customerId, orderNumber?, action: "released"|"held"|"recorded",
//     note, actingEmail, idempotencyKey }  → { matched, closed, threadIds }
//
// Called on EVERY release — notify ("released") and record-only ("recorded")
// — plus automatic releases. Fire-and-forget with a short timeout: a failure
// is logged and never blocks or fails the user's action. Skipped silently
// when INBOX_HOLD_RESOLVE_URL (or the service token) is unset.

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "hold-orders.inbox-resolve" });

export const INBOX_RESOLVE_TIMEOUT_MS = 4000;

export type HoldResolveAction = "released" | "held" | "recorded";

export type HoldResolveInput = {
  orderId: string;
  customerId: string | null;
  orderNumber: string | null;
  action: HoldResolveAction;
  note: string;
  actingEmail: string | null;
  // Unique per state change so inbox can dedupe retries.
  idempotencyKey: string;
};

export type HoldResolveBody = {
  customerId: string;
  orderNumber?: string;
  action: HoldResolveAction;
  note: string;
  actingEmail: string;
  idempotencyKey: string;
};

/** Pure: the wire body, or null when there's nothing to send (no customer). */
export function buildHoldResolveBody(input: HoldResolveInput): HoldResolveBody | null {
  if (!input.customerId) return null;
  const body: HoldResolveBody = {
    customerId: input.customerId,
    action: input.action,
    note: input.note.slice(0, 1000),
    actingEmail: input.actingEmail ?? "system@finance",
    idempotencyKey: input.idempotencyKey,
  };
  // Shopify order number as finance shows it ("#18926"), when known.
  if (input.orderNumber) body.orderNumber = input.orderNumber;
  return body;
}

/** Await-able variant (tests); production callers use onHoldReleased. */
export async function postHoldResolve(
  input: HoldResolveInput,
  fetchImpl: typeof fetch = fetch,
): Promise<"skipped" | "ok" | "failed"> {
  const url = env.INBOX_HOLD_RESOLVE_URL;
  const token = env.INBOX_SERVICE_TOKEN;
  if (!url || !token) return "skipped";
  const body = buildHoldResolveBody(input);
  if (!body) return "skipped";
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INBOX_RESOLVE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn(
        { orderId: input.orderId, status: res.status, body: text.slice(0, 300) },
        "inbox hold-resolve call failed",
      );
      return "failed";
    }
    const json = (await res.json().catch(() => ({}))) as {
      matched?: boolean;
      closed?: number | boolean;
      threadIds?: string[];
    };
    log.info(
      { orderId: input.orderId, action: input.action, matched: json.matched, closed: json.closed },
      "inbox hold thread resolve",
    );
    return "ok";
  } catch (err) {
    log.warn({ err, orderId: input.orderId }, "inbox hold-resolve call errored");
    return "failed";
  }
}

/** Fire-and-forget hook. Never throws, never blocks the caller. */
export function onHoldReleased(input: HoldResolveInput): void {
  void postHoldResolve(input).catch(() => undefined);
}
