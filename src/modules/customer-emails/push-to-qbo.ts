// Pushes a customer's resolved invoice recipients to QBO so that
// invoices QBO generates and sends on its own (e.g. the Shopify→QBO
// pipeline) carry the right TO / CC / BCC. The same fields are used
// by /invoicing/today's Send button when going through QboClient.
//
// Best-effort by design: a failure here logs a warning but doesn't
// roll back the local edit. Mirrors push-to-qbo for terms.
//
// QBO field map:
//   BillEmail    ← invoice TO
//   BillEmailCc  ← invoice CC, comma-joined
//   BillEmailBcc ← invoice BCC (tag-derived), comma-joined
// QBO accepts comma- or semicolon-separated multi-address strings on
// BillEmailCc / BillEmailBcc, so we render with ", ".

import { QboClient } from "../../integrations/qb/client.js";
import { createLogger } from "../../lib/logger.js";
import {
  resolveRecipientsWithRules,
  loadRulesForTags,
  type CustomerEmailInput,
} from "./recipients.js";

const log = createLogger({ component: "customer-emails.push" });

export type PushInvoiceEmailsResult =
  | { status: "pushed"; qbCustomerId: string }
  | { status: "skipped"; reason: PushSkipReason; qbCustomerId: string | null };

export type PushSkipReason =
  | "no_qb_customer_id"
  | "qb_customer_not_found"
  | "qb_no_sync_token";

// Pushes the resolved invoice TO / CC / BCC for one customer to QBO.
// Caller passes the full customer email shape so this helper doesn't
// need to query the DB — easier to compose with the PATCH route's
// after-image. Throws on network/auth failures (caller logs + decides);
// returns "skipped" for the expected miss cases.
export async function pushCustomerInvoiceEmailsToQbo(args: {
  qbCustomerId: string | null;
  customer: CustomerEmailInput;
  qbClient?: QboClient;
}): Promise<PushInvoiceEmailsResult> {
  const { qbCustomerId, customer } = args;

  if (!qbCustomerId) {
    return {
      status: "skipped",
      reason: "no_qb_customer_id",
      qbCustomerId: null,
    };
  }

  const qb = args.qbClient ?? new QboClient();
  const rules = await loadRulesForTags(customer.tags ?? []);
  const recipients = resolveRecipientsWithRules(
    "invoice",
    customer,
    rules,
  );

  const qboCustomer = await qb.getCustomerById(qbCustomerId);
  if (!qboCustomer) {
    log.warn(
      { qbCustomerId },
      "QBO customer not found; skipping email push",
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

  // Compose the sparse-update payload. QBO expects PrimaryEmailAddr
  // for the TO field; BillEmailCc / BillEmailBcc are the CC + BCC
  // strings respectively. Sending null clears each ref.
  const payload: Record<string, unknown> = {
    Id: qbCustomerId,
    SyncToken: qboCustomer.SyncToken,
    sparse: true,
    PrimaryEmailAddr: recipients.to
      ? { Address: recipients.to }
      : null,
  };
  // QBO docs: BillEmail is the TO too on invoices. PrimaryEmailAddr
  // is the customer-level "main" email. Setting both keeps QBO's UI
  // self-consistent — older accounts surface BillEmail, newer ones
  // PrimaryEmailAddr; setting both is harmless either way.
  if (recipients.to) {
    payload.BillEmail = { Address: recipients.to };
  } else {
    payload.BillEmail = null;
  }
  payload.BillEmailCc =
    recipients.cc.length > 0 ? { Address: recipients.cc.join(", ") } : null;
  payload.BillEmailBcc =
    recipients.bcc.length > 0 ? { Address: recipients.bcc.join(", ") } : null;

  await qb.updateCustomer(payload);
  return { status: "pushed", qbCustomerId };
}
