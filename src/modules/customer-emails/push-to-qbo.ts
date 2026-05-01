// Pushes a customer's invoice TO to QBO so that invoices QBO sends
// on its own (e.g. the Shopify→QBO pipeline) reach the address the
// operator picked in finance-hub.
//
// IMPORTANT — what QBO actually accepts on the Customer entity:
//   - PrimaryEmailAddr: ✅ valid, single email; this is the only
//     customer-level email field QBO has.
//   - BillEmail / BillEmailCc / BillEmailBcc: ❌ NOT valid on
//     Customer. Those are per-Invoice fields. Sending them on a
//     Customer.update is silently dropped by QBO.
//
// Implication: per-customer CC/BCC do NOT round-trip to QBO. They
// apply only to invoices finance-hub itself sends. For QBO-auto-sent
// invoices (Shopify pipeline), CC/BCC fall back to QBO's company-
// level Preferences.SalesFormsPrefs.SalesEmailCc/Bcc — which is a
// single global setting, not per-customer or per-tag.
//
// We push `recipients.to` (invoice override → primary fallback) as
// PrimaryEmailAddr so the QBO customer record reflects where invoices
// should go. The CC/BCC computed by resolveRecipients are deliberately
// dropped here; they live in finance-hub's send paths instead.
//
// Best-effort by design: a failure logs a warning but doesn't roll
// back the local edit.

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

  // Sparse update: only PrimaryEmailAddr. The CC/BCC from
  // recipients.cc / .bcc are intentionally dropped — they're not
  // settable on the Customer entity. Multiple TO addresses get
  // comma-joined into the single PrimaryEmailAddr.Address string;
  // QBO accepts that and renders them as a multi-recipient TO.
  const primaryAddress =
    recipients.to.length > 0 ? recipients.to.join(", ") : null;
  const payload: Record<string, unknown> = {
    Id: qbCustomerId,
    SyncToken: qboCustomer.SyncToken,
    sparse: true,
    PrimaryEmailAddr: primaryAddress ? { Address: primaryAddress } : null,
  };

  await qb.updateCustomer(payload);
  return { status: "pushed", qbCustomerId };
}
