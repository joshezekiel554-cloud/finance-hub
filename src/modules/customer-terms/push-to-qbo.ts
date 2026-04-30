// Push a customer's payment terms from finance-hub to QBO. Used by:
//   - PATCH /api/customers/:id (single edit on the detail page)
//   - POST /api/monday-sync/apply-terms (the bulk Monday backfill)
//
// "Best-effort" semantics: a failure to push to QBO never blocks or
// rolls back the local write. Reasoning — finance-hub is the source of
// truth (per the QB sync fix that stopped overwriting paymentTerms on
// update), so a missed push is recoverable by retrying. The local
// state stays consistent with the operator's intent either way.
//
// Term-name → QBO term resolution: terms are an entity in QBO with an
// Id. We cache the term list in-memory for 5 min so a batch push (140
// customers from Monday) makes one getTerms() call, not 140.

import type { QboTerm } from "../../integrations/qb/types.js";
import { QboClient } from "../../integrations/qb/client.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "customer-terms.push" });

const TERM_CACHE_MS = 5 * 60_000;
let cachedTerms: { fetchedAt: number; terms: QboTerm[] } | null = null;

async function getActiveTerms(qb: QboClient): Promise<QboTerm[]> {
  const now = Date.now();
  if (cachedTerms && now - cachedTerms.fetchedAt < TERM_CACHE_MS) {
    return cachedTerms.terms;
  }
  const terms = await qb.getTerms();
  cachedTerms = {
    fetchedAt: now,
    terms: terms.filter((t) => t.Active !== false),
  };
  return cachedTerms.terms;
}

// Resolve a finance-hub display string ("Net 30", "Due on Receipt") to
// the QBO term Id. Match is case-insensitive on the term Name. Returns
// null when no term in QBO matches — caller logs + skips, leaving the
// local value alone on the QBO side.
function resolveTermId(
  displayString: string,
  terms: QboTerm[],
): string | null {
  const want = displayString.trim().toLowerCase();
  for (const t of terms) {
    if (t.Name.trim().toLowerCase() === want) return t.Id;
  }
  return null;
}

export type PushTermsResult =
  | { status: "pushed"; qbCustomerId: string; qbTermId: string }
  | { status: "cleared"; qbCustomerId: string }
  | { status: "skipped"; reason: PushSkipReason; qbCustomerId: string | null };

export type PushSkipReason =
  | "no_qb_customer_id"
  | "term_not_found_in_qbo"
  | "qb_customer_not_found"
  | "qb_no_sync_token";

// Pushes one customer's term to QBO. `paymentTerms === null` means
// clear the SalesTermRef on QBO. Anything else is resolved against the
// QBO term list; if no match, we skip (the local value stays, QBO
// stays unchanged). Throws on network/auth failures so the caller can
// log + decide; doesn't throw on "expected skip" cases.
export async function pushCustomerTermsToQbo(args: {
  qbCustomerId: string | null;
  paymentTerms: string | null;
  qbClient?: QboClient;
}): Promise<PushTermsResult> {
  const { qbCustomerId, paymentTerms } = args;

  if (!qbCustomerId) {
    return {
      status: "skipped",
      reason: "no_qb_customer_id",
      qbCustomerId: null,
    };
  }

  const qb = args.qbClient ?? new QboClient();

  // Need the SyncToken — sparse update is rejected without it.
  const customer = await qb.getCustomerById(qbCustomerId);
  if (!customer) {
    log.warn(
      { qbCustomerId },
      "QBO customer not found; skipping terms push",
    );
    return {
      status: "skipped",
      reason: "qb_customer_not_found",
      qbCustomerId,
    };
  }
  if (!customer.SyncToken) {
    return {
      status: "skipped",
      reason: "qb_no_sync_token",
      qbCustomerId,
    };
  }

  // Clear path: explicit null means "remove SalesTermRef". QBO clears
  // a ref by sending it as the empty value — we send SalesTermRef:
  // null to wipe; if QBO ever rejects that, the operator can tweak in
  // QBO directly. For Feldart's account we've never had to clear.
  if (paymentTerms === null) {
    if (!customer.SalesTermRef) {
      // Already cleared on QBO side — no-op, no need to round-trip.
      return { status: "cleared", qbCustomerId };
    }
    await qb.updateCustomer({
      Id: qbCustomerId,
      SyncToken: customer.SyncToken,
      sparse: true,
      // Setting to null is the documented clear pattern for refs in
      // QBO sparse updates.
      SalesTermRef: null,
    });
    return { status: "cleared", qbCustomerId };
  }

  // Resolve the display string to a QBO term Id.
  const terms = await getActiveTerms(qb);
  const qbTermId = resolveTermId(paymentTerms, terms);
  if (!qbTermId) {
    log.warn(
      { qbCustomerId, paymentTerms, termCount: terms.length },
      "no QBO term matches local paymentTerms; skipping push",
    );
    return {
      status: "skipped",
      reason: "term_not_found_in_qbo",
      qbCustomerId,
    };
  }

  // No-op if QBO already has the right ref.
  if (customer.SalesTermRef?.value === qbTermId) {
    return { status: "pushed", qbCustomerId, qbTermId };
  }

  await qb.updateCustomer({
    Id: qbCustomerId,
    SyncToken: customer.SyncToken,
    sparse: true,
    SalesTermRef: { value: qbTermId },
  });

  return { status: "pushed", qbCustomerId, qbTermId };
}

// Reset for tests + after a Monday push completes — the term list
// usually doesn't change, but if the operator adds a new QBO term to
// fill a gap we don't want a stale cache to hold a fresh apply back.
export function clearTermsCache(): void {
  cachedTerms = null;
}
