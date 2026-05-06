// RMA matcher — links an incoming Extensiv return-receipt email to an open RMA.
//
// Three-tier lookup strategy:
//   1. Exact tx# match (rma_number or extensiv_tx_number)
//   2. Exact extensiv_ref match
//   3. Fuzzy: customer-name + SKU Jaccard overlap
//
// The function is intentionally free of I/O side-effects (no inserts).
// The caller (Gmail poller integration) is responsible for persisting the result.

import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "~/db/index.js";
import { rmaItems, rmas } from "~/db/schema/returns.js";
import { customers } from "~/db/schema/customers.js";

export type MatchResult =
  | { kind: "exact_tx_number"; rmaId: string }
  | { kind: "exact_ref_string"; rmaId: string }
  | { kind: "fuzzy_customer_sku"; rmaId: string; confidence: number; alternateMatches: string[] }
  | { kind: "no_match" };

// Statuses we'll match against for the exact-identifier tiers (tx# / ref).
// Includes:
//   - "approved": imported RMAs whose warehouse handoff happened in the
//     desktop app, never marked sent_to_warehouse here.
//   - "completed": receipts that arrive after the CM has been issued. The
//     link is purely audit — the receipt has nothing to action — but
//     keeping a record of "yes, this receipt corresponds to that RMA"
//     beats letting it rot in the unmatched bucket.
// Exact identifier match (rma_number / extensiv_tx_number) is unambiguous
// so the wider net doesn't create false positives. Fuzzy matching
// (tier 3) intentionally stays narrow (sent_to_warehouse only) because
// customer-name + SKU overlap CAN false-match across multiple RMAs for
// the same customer.
// Typed as the specific enum literals so Drizzle's inArray overload
// resolves to the enum-column variant (not the generic string[] overload).
const ACTIVE_STATUSES: Array<
  "approved" | "sent_to_warehouse" | "received" | "completed"
> = ["approved", "sent_to_warehouse", "received", "completed"];

// ---------------------------------------------------------------------------
// Jaccard similarity between two sets of strings.
// Returns a value in [0, 1]; both-empty → 0.
// ---------------------------------------------------------------------------
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

// ---------------------------------------------------------------------------
// Token-based customer-name overlap.
//
// Used by tier-3 fuzzy matching. Splits both names on whitespace, lowercases,
// drops short tokens (< 4 chars), and returns true if at least one survivor
// token is shared. Replaces a previous bidirectional `.includes()` check
// that gave a 0.5 score boost when the inferred name was something like
// "Co" — matching every "Cohen", "Corp", "Company" customer indiscriminately
// (Bug I5).
// ---------------------------------------------------------------------------
function customerNameTokenMatch(inferred: string, rma: string): boolean {
  const minLen = 4;
  const tokens = (s: string) =>
    s.toLowerCase().split(/\s+/).filter((t) => t.length >= minLen);
  const inferredTokens = new Set(tokens(inferred));
  if (inferredTokens.size === 0) return false;
  return tokens(rma).some((t) => inferredTokens.has(t));
}

// ---------------------------------------------------------------------------
// matchReceiptToRma
// ---------------------------------------------------------------------------

export async function matchReceiptToRma(input: {
  txNumber?: string;
  refString?: string;
  inferredCustomerName?: string;
  parsedItems?: Array<{ sku: string }>;
}): Promise<MatchResult> {
  const { txNumber, refString, inferredCustomerName, parsedItems } = input;

  // ------------------------------------------------------------------
  // Step 1: exact tx# match
  // ------------------------------------------------------------------
  if (txNumber) {
    const rows = await db
      .select({ id: rmas.id })
      .from(rmas)
      .where(
        and(
          or(eq(rmas.rmaNumber, txNumber), eq(rmas.extensivTxNumber, txNumber)),
          inArray(rmas.status, ACTIVE_STATUSES),
        ),
      )
      .limit(2);

    if (rows.length === 1) {
      return { kind: "exact_tx_number", rmaId: rows[0]!.id };
    }
    // Multiple or zero — fall through to next tier
  }

  // ------------------------------------------------------------------
  // Step 2: exact extensiv_ref match
  // ------------------------------------------------------------------
  if (refString) {
    const rows = await db
      .select({ id: rmas.id })
      .from(rmas)
      .where(
        and(
          eq(rmas.extensivRef, refString),
          inArray(rmas.status, ACTIVE_STATUSES),
        ),
      )
      .limit(2);

    if (rows.length === 1) {
      return { kind: "exact_ref_string", rmaId: rows[0]!.id };
    }
  }

  // ------------------------------------------------------------------
  // Step 3: fuzzy — customer name + SKU overlap
  // ------------------------------------------------------------------
  // Only attempt fuzzy when we have at least one signal to work with.
  if (!inferredCustomerName && (!parsedItems || parsedItems.length === 0)) {
    return { kind: "no_match" };
  }

  // Load all RMAs currently at sent_to_warehouse with their customer names.
  const candidateRmas = await db
    .select({
      id: rmas.id,
      customerId: rmas.customerId,
      customerName: customers.displayName,
    })
    .from(rmas)
    .innerJoin(customers, eq(rmas.customerId, customers.id))
    .where(eq(rmas.status, "sent_to_warehouse"))
    .limit(500);

  if (candidateRmas.length === 0) return { kind: "no_match" };

  // Load items for all candidate RMAs in one query.
  const candidateIds = candidateRmas.map((r) => r.id);
  const allItems =
    candidateIds.length > 0
      ? await db
          .select({ rmaId: rmaItems.rmaId, sku: rmaItems.sku })
          .from(rmaItems)
          .where(inArray(rmaItems.rmaId, candidateIds))
      : [];

  // Build a map: rmaId → Set<sku>
  const itemsByrmaId = new Map<string, Set<string>>();
  for (const item of allItems) {
    if (!itemsByrmaId.has(item.rmaId)) {
      itemsByrmaId.set(item.rmaId, new Set());
    }
    itemsByrmaId.get(item.rmaId)!.add(item.sku.toUpperCase());
  }

  const receiptSkus = new Set(
    (parsedItems ?? []).map((p) => p.sku.toUpperCase()),
  );

  const customerInput = (inferredCustomerName ?? "").trim();

  type ScoredRma = { rmaId: string; score: number };
  const scored: ScoredRma[] = [];

  for (const rma of candidateRmas) {
    let score = 0;

    // Customer name signal: token overlap (≥4-char tokens, case-insensitive).
    // The previous bidirectional `.includes()` check awarded the boost on
    // tiny substrings (e.g. "Co" matching "Cohen Family Co"); requiring a
    // shared 4+ char token rules that out while still catching "Acme" vs
    // "Acme Company".
    if (customerInput) {
      const rmaCustomerName = rma.customerName ?? "";
      if (customerNameTokenMatch(customerInput, rmaCustomerName)) {
        score += 0.5;
      }
    }

    // SKU Jaccard signal
    if (receiptSkus.size > 0) {
      const rmaSkus = itemsByrmaId.get(rma.id) ?? new Set<string>();
      const j = jaccard(receiptSkus, rmaSkus);
      if (j > 0.5) score += 0.5;
    }

    if (score > 0.5) {
      scored.push({ rmaId: rma.id, score });
    }
  }

  if (scored.length === 0) return { kind: "no_match" };

  // Sort descending by score; top match wins.
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  const alternateMatches = scored.slice(1).map((s) => s.rmaId);

  return {
    kind: "fuzzy_customer_sku",
    rmaId: top.rmaId,
    confidence: top.score,
    alternateMatches,
  };
}
