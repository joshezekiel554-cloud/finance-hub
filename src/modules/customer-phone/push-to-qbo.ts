// Push the customer's main phone number to QBO so QBO's UI + any
// downstream sync targets match what finance-hub has. Mirrors the
// shape of customer-terms / customer-emails pushes: best-effort,
// fire-and-forget from the PATCH route, log + skip on the expected
// miss cases.
//
// The additional_phones JSON column is intentionally NOT pushed.
// QBO's customer schema only has PrimaryPhone + AlternatePhone +
// Mobile + Fax — a tight set; mapping arbitrary labels into those
// slots would be lossy. Additional phones stay local-only by design;
// they're for the operator's eyeballs (bookkeeper direct line, AR
// clerk, etc.), not for QBO-side automation.

import { QboClient } from "../../integrations/qb/client.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "customer-phone.push" });

export type PushPhoneResult =
  | { status: "pushed"; qbCustomerId: string }
  | { status: "skipped"; reason: PushSkipReason; qbCustomerId: string | null };

export type PushSkipReason =
  | "no_qb_customer_id"
  | "qb_customer_not_found"
  | "qb_no_sync_token";

export async function pushCustomerPhoneToQbo(args: {
  qbCustomerId: string | null;
  phone: string | null;
  qbClient?: QboClient;
}): Promise<PushPhoneResult> {
  const { qbCustomerId, phone } = args;

  if (!qbCustomerId) {
    return {
      status: "skipped",
      reason: "no_qb_customer_id",
      qbCustomerId: null,
    };
  }

  const qb = args.qbClient ?? new QboClient();
  const qboCustomer = await qb.getCustomerById(qbCustomerId);
  if (!qboCustomer) {
    log.warn(
      { qbCustomerId },
      "QBO customer not found; skipping phone push",
    );
    return {
      status: "skipped",
      reason: "qb_customer_not_found",
      qbCustomerId,
    };
  }
  if (!qboCustomer.SyncToken) {
    return {
      status: "skipped",
      reason: "qb_no_sync_token",
      qbCustomerId,
    };
  }

  // QBO accepts a sparse update. PrimaryPhone is the field exposed in
  // the UI as the customer's main phone; setting it to null clears.
  const trimmed = phone?.trim() ?? "";
  await qb.updateCustomer({
    Id: qbCustomerId,
    SyncToken: qboCustomer.SyncToken,
    sparse: true,
    PrimaryPhone:
      trimmed.length > 0 ? { FreeFormNumber: trimmed } : null,
  });
  return { status: "pushed", qbCustomerId };
}
