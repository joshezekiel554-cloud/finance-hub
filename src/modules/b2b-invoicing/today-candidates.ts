// Candidate selection for the Invoicing Today queue.
//
// The queue's source set is every warehouse "requested transaction
// notification" email in the lookback window — ~580 per 7 days in
// production. Enriching all of them is too expensive (each row with an
// order number costs a Shopify order lookup over the network), but
// truncating the source set by raw recency silently hides real work:
// a shipment email from six days ago is exactly the one the operator
// still has to invoice.
//
// So we split the set by what it costs us to be wrong:
//
//   - Has an order number and not dismissed → NEVER capped. These are the
//     B2B shipments (and B2C sales receipts) the page exists to action.
//     Missing one of these is the bug this module was written to fix.
//   - No order number and not dismissed → unparseable noise. Kept
//     newest-first up to a cap; the operator only ever skims these.
//   - Dismissed (whatever its parse state) → already actioned. Kept
//     newest-first up to a smaller cap so the Dismissed tab still shows
//     recent history.
//
// Anything dropped is counted in `truncated` so the UI can say so out
// loud rather than lying by omission.

export type TodayCandidate = {
  gmailId: string;
  emailDate: Date;
  hasOrderNumber: boolean;
  dismissed: boolean;
};

export type TodayCandidateCaps = {
  unparseable: number;
  dismissed: number;
};

export const TODAY_CANDIDATE_CAPS: TodayCandidateCaps = {
  unparseable: 100,
  dismissed: 50,
};

export type TodaySelection = {
  // Gmail ids to enrich and return.
  keep: Set<string>;
  // How many candidates were dropped, split by the reason they were
  // eligible for capping.
  truncated: { unparseable: number; dismissed: number };
};

// Whether a row still needs its Shopify order fetched.
//
// The Shopify lookup is the single most expensive thing /today does: one
// network call per row, against a 40-request bucket that leaks 2/s. Once
// commit 1 lifted the 50-email cap the row count went to ~150 and the page
// blew through nginx's 60 s upstream timeout. Shopify data is only ever
// USED to reconcile an invoice the operator is about to send, so any row
// that can't be sent doesn't need the call.
export type ShopifyLookupInput = {
  // False for dismissed rows — they're history, never reconciled.
  wantShopify: boolean;
  // Null when no QB doc resolved: either nothing matched the DocNumber, or
  // the B2C paid-upfront gate fired. Neither can be actioned.
  resolvedDocType: "invoice" | "salesreceipt" | null;
  // QBO's EmailStatus on the resolved doc. "EmailSent" means the row lives
  // in the Sent tab, which is display-only.
  emailStatus: string | null;
};

export function shouldLookupShopify(input: ShopifyLookupInput): boolean {
  if (!input.wantShopify) return false;
  if (input.resolvedDocType === null) return false;
  if (input.emailStatus === "EmailSent") return false;
  return true;
}

export function selectTodayCandidates(
  candidates: TodayCandidate[],
  caps: TodayCandidateCaps = TODAY_CANDIDATE_CAPS,
): TodaySelection {
  const unparseableCap = Math.max(0, caps.unparseable);
  const dismissedCap = Math.max(0, caps.dismissed);

  // Newest first. Array.prototype.sort is stable, so equal timestamps keep
  // their input order.
  const ordered = [...candidates].sort(
    (a, b) => b.emailDate.getTime() - a.emailDate.getTime(),
  );

  const keep = new Set<string>();
  let unparseableKept = 0;
  let unparseableDropped = 0;
  let dismissedKept = 0;
  let dismissedDropped = 0;

  for (const candidate of ordered) {
    if (candidate.dismissed) {
      // Dismissed rows compete against each other only — a dismissed row
      // that happens to have an order number is still history, not work.
      if (dismissedKept < dismissedCap) {
        keep.add(candidate.gmailId);
        dismissedKept++;
      } else {
        dismissedDropped++;
      }
      continue;
    }

    if (candidate.hasOrderNumber) {
      keep.add(candidate.gmailId);
      continue;
    }

    if (unparseableKept < unparseableCap) {
      keep.add(candidate.gmailId);
      unparseableKept++;
    } else {
      unparseableDropped++;
    }
  }

  return {
    keep,
    truncated: { unparseable: unparseableDropped, dismissed: dismissedDropped },
  };
}
