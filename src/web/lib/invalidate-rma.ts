// Centralised cache-invalidation helper for any RMA state change.
//
// The codebase repeatedly hit a bug-class where a mutation only
// invalidated `["rma", id]` and left the global Returns list, the
// customer's Returns tab, the chase RMA pill, and the customer-detail
// "RMA in flight" badge stale until hard reload. Single source of
// truth for which keys derive from `rmas` so every mutation
// onSuccess can fire one call and trust the rest of the UI to
// reflect reality.
//
// Cheap to over-invalidate: TanStack Query refetches are
// deduplicated and any unobserved query stays inert. Don't worry
// about pruning keys per-mutation — call this everywhere.
import type { QueryClient } from "@tanstack/react-query";

export function invalidateAfterRmaChange(
  qc: QueryClient,
  args: { rmaId?: string | null; customerId?: string | null },
): void {
  // Detail page for the specific RMA (rma-action-panel + dialogs read this).
  if (args.rmaId) {
    void qc.invalidateQueries({ queryKey: ["rma", args.rmaId] });
  }

  // Global Returns list page (`/returns`) — driven by both keys
  // depending on call site; invalidate both so neither goes stale.
  void qc.invalidateQueries({ queryKey: ["rmas"] });
  void qc.invalidateQueries({ queryKey: ["returns-list"] });

  if (args.customerId) {
    // Customer profile Returns tab.
    void qc.invalidateQueries({
      queryKey: ["customer-rmas", args.customerId],
    });
    // Customer detail page header + KPI strip (hasPendingRma, last
    // contacted, activity timeline picks up rma_* events).
    void qc.invalidateQueries({ queryKey: ["customer", args.customerId] });
  }

  // Customers list (hasPendingRma column flag) and the chase list
  // (RMA pending pill). Both compute from `rmas.status` server-side.
  void qc.invalidateQueries({ queryKey: ["customers"] });
  void qc.invalidateQueries({ queryKey: ["chase", "customers"] });
}
