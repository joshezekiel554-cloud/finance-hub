import type { QboCreditMemo } from "./types.js";

// Sum each customer's unapplied credit memo balances. Used by the QB
// sync to populate customers.unapplied_credit_balance. Returns a map
// keyed by qb_customer_id; customers absent from the map should have
// their unapplied_credit_balance reset to 0 (a credit applied since the
// last sync drops the customer out of the input list).
//
// Filters: only memos with finite, positive Balance and a non-empty
// CustomerRef.value contribute. QBO occasionally returns Balance=0
// memos in the unfiltered query response — those are fully-applied
// and don't reduce overdue.
export function aggregateCreditBalanceByQbCustomerId(
  memos: QboCreditMemo[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const m of memos) {
    const qbCustomerId = m.CustomerRef?.value;
    if (!qbCustomerId) continue;
    const balance = Number(m.Balance ?? 0);
    if (!Number.isFinite(balance) || balance <= 0) continue;
    totals.set(qbCustomerId, (totals.get(qbCustomerId) ?? 0) + balance);
  }
  return totals;
}
