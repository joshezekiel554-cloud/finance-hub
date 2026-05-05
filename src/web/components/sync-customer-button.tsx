// SyncCustomerButton — per-customer "Refresh from QB" action.
//
// Calls POST /api/customers/:id/sync-qb which re-pulls just this
// customer's QBO record + their invoices + their payments (~3 QBO
// calls). Invalidates relevant React Query caches so the page re-
// renders with the fresh data without a manual reload. Shows a
// "Refreshed just now" pill for ~5 seconds after a successful run so
// the operator gets confirmation, but no persistent timestamp UI —
// they hit it when they need to.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "./ui/button";

export function SyncCustomerButton({
  customerId,
}: {
  customerId: string;
}) {
  const queryClient = useQueryClient();
  const [confirmedAt, setConfirmedAt] = useState<number | null>(null);

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/customers/${customerId}/sync-qb`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      // Invalidate any query that derives from this customer's QBO data
      // — detail page, invoice lists, customer-list overdue balance, etc.
      void queryClient.invalidateQueries({
        queryKey: ["customer", customerId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["customer-invoices", customerId],
      });
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
      void queryClient.invalidateQueries({ queryKey: ["chase"] });
      setConfirmedAt(Date.now());
      // Auto-dismiss the "Refreshed" chip after ~5s so it doesn't loiter.
      setTimeout(() => setConfirmedAt(null), 5_000);
    },
  });

  const isPending = syncMutation.isPending;
  const isFresh =
    confirmedAt !== null && Date.now() - confirmedAt < 5_000;

  return (
    <div className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={isPending}
        onClick={() => syncMutation.mutate()}
        title="Re-pull this customer + their invoices + payments from QBO (~3 calls). Other customers are not affected."
      >
        {isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        {isPending ? "Refreshing…" : "Refresh from QB"}
      </Button>
      {isFresh && (
        <span className="inline-flex items-center gap-1 text-xs text-success">
          <CheckCircle2 className="size-3.5" />
          Refreshed
        </span>
      )}
      {syncMutation.isError && (
        <span className="text-xs text-accent-danger">
          {(syncMutation.error as Error).message}
        </span>
      )}
    </div>
  );
}
