// Bookkeeper-thread linkage for the TJ dispute loop (origin-split-2 W2 T2).
//
// When the operator sends a bookkeeper email from the dispute flow, the
// compose context carries `disputeInvoiceId` and the email-send route
// records the resulting Gmail threadId on `invoices.bookkeeper_thread_id`.
// That linkage is what lets the tj_dispute_nudge proposer (W2 T3) tell a
// thread gone silent apart from an invoice still awaiting its first
// bookkeeper email.
//
// Split into two pure-ish steps so the route stays thin and the logic is
// testable without a Fastify harness (repo has none — see
// routes/statements.test.ts for the same pattern):
//   1. guardDisputeInvoice — runs BEFORE the Gmail send, so a bad invoice
//      id rejects the whole request instead of half-completing (email out,
//      linkage lost).
//   2. linkBookkeeperThread — runs AFTER a successful send; writes the
//      threadId + audit_log row.

import { nanoid } from "nanoid";

// The slice of the invoice row the linkage needs. Kept narrow so tests
// don't have to fabricate full Invoice rows.
export type DisputeInvoiceForLink = {
  id: string;
  origin: "feldart" | "tj";
  bookkeeperThreadId: string | null;
};

export type GuardDisputeInvoiceResult =
  // No disputeInvoiceId on the request — plain send, nothing to link.
  | { kind: "skip" }
  // Bad id: reject the send with a 400 before any email goes out.
  | { kind: "invalid"; message: string }
  // Valid TJ invoice — link after the send succeeds.
  | { kind: "ok"; invoice: DisputeInvoiceForLink };

// Validate the dispute invoice BEFORE sending. Returns "skip" when no id
// was supplied (the loader must not be called at all in that case — plain
// sends shouldn't pay a DB roundtrip).
export async function guardDisputeInvoice(
  loadInvoice: (id: string) => Promise<DisputeInvoiceForLink | null>,
  disputeInvoiceId: string | undefined,
): Promise<GuardDisputeInvoiceResult> {
  if (!disputeInvoiceId) return { kind: "skip" };
  const invoice = await loadInvoice(disputeInvoiceId);
  if (!invoice) {
    return { kind: "invalid", message: "dispute invoice not found" };
  }
  if (invoice.origin !== "tj") {
    return {
      kind: "invalid",
      message: "bookkeeper thread linkage is TJ-only; invoice is not a Torah Judaica invoice",
    };
  }
  return { kind: "ok", invoice };
}

// Shape of the audit_log row this linkage writes — matches NewAuditLog
// minus the columns the DB defaults (occurredAt).
export type BookkeeperThreadLinkAuditRow = {
  id: string;
  userId: string;
  action: "dispute.bookkeeper_thread_linked";
  entityType: "invoice";
  entityId: string;
  before: { bookkeeperThreadId: string | null };
  after: { bookkeeperThreadId: string };
};

export type LinkBookkeeperThreadDeps = {
  updateThreadId: (invoiceId: string, threadId: string) => Promise<void>;
  insertAudit: (row: BookkeeperThreadLinkAuditRow) => Promise<void>;
};

// Persist the sent thread onto the invoice + audit it. Deliberately
// OVERWRITES any existing bookkeeperThreadId: a re-link is fine — the
// latest bookkeeper thread wins (the operator may start a fresh thread
// when an earlier one went stale or bounced), and the audit row's
// before/after preserves the superseded id.
export async function linkBookkeeperThread(
  deps: LinkBookkeeperThreadDeps,
  args: { invoice: DisputeInvoiceForLink; threadId: string; userId: string },
): Promise<void> {
  const { invoice, threadId, userId } = args;
  await deps.updateThreadId(invoice.id, threadId);
  await deps.insertAudit({
    id: nanoid(24),
    userId,
    action: "dispute.bookkeeper_thread_linked",
    entityType: "invoice",
    entityId: invoice.id,
    before: { bookkeeperThreadId: invoice.bookkeeperThreadId },
    after: { bookkeeperThreadId: threadId },
  });
}
