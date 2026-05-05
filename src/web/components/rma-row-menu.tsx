// RmaRowMenu — three-dot menu with cancel + delete actions for an RMA row.
// Used on the /returns list page and the customer profile Returns tab.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreVertical } from "lucide-react";

export type RmaRowMenuStatus =
  | "draft"
  | "approved"
  | "awaiting_warehouse_number"
  | "sent_to_warehouse"
  | "received"
  | "completed"
  | "denied"
  | "cancelled";

export type RmaRowMenuProps = {
  rmaId: string;
  status: RmaRowMenuStatus;
  /** Query keys to invalidate after a successful action — e.g. ["returns-list"]. */
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
};

export default function RmaRowMenu({
  rmaId,
  status,
  invalidateKeys = [],
}: RmaRowMenuProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "cancel" | "delete">(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canCancel =
    status === "approved" ||
    status === "awaiting_warehouse_number" ||
    status === "sent_to_warehouse";
  const canDelete = status === "draft" || status === "cancelled";

  function invalidate(): void {
    for (const key of invalidateKeys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }

  const cancelMutation = useMutation<void, Error, string>({
    mutationFn: async (rsn) => {
      const res = await fetch(`/api/rmas/${rmaId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: rsn || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      setReason("");
      setOpen(false);
    },
    onError: (err) => setError(err.message),
  });

  const deleteMutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      setOpen(false);
    },
    onError: (err) => setError(err.message),
  });

  if (!canCancel && !canDelete) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
          setError(null);
          setConfirm(null);
        }}
        aria-label="Row actions"
        className="rounded p-1 text-muted hover:bg-elevated hover:text-primary"
      >
        <MoreVertical className="size-4" />
      </button>

      {open && !confirm && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-default bg-base shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {canCancel && (
            <button
              type="button"
              onClick={() => setConfirm("cancel")}
              className="block w-full px-3 py-2 text-left text-xs text-secondary hover:bg-elevated"
            >
              Cancel RMA
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setConfirm("delete")}
              className="block w-full px-3 py-2 text-left text-xs text-accent-danger hover:bg-elevated"
            >
              Delete RMA
            </button>
          )}
        </div>
      )}

      {open && confirm === "cancel" && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-72 rounded-md border border-default bg-base p-3 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs font-medium">Cancel this RMA?</div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            rows={2}
            className="mt-2 w-full rounded-md border border-default bg-base px-2 py-1.5 text-xs"
          />
          {error && (
            <div className="mt-1 text-xs text-accent-danger">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setConfirm(null);
                setError(null);
              }}
              disabled={cancelMutation.isPending}
              className="rounded border border-default px-2.5 py-1 text-xs text-secondary hover:bg-elevated"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => cancelMutation.mutate(reason)}
              disabled={cancelMutation.isPending}
              className="rounded bg-accent-warning px-2.5 py-1 text-xs text-white hover:bg-accent-warning/90 disabled:opacity-50"
            >
              {cancelMutation.isPending ? "Cancelling…" : "Confirm cancel"}
            </button>
          </div>
        </div>
      )}

      {open && confirm === "delete" && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-72 rounded-md border border-accent-danger/40 bg-accent-danger/5 p-3 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs font-medium text-accent-danger">
            Delete permanently?
          </div>
          {error && (
            <div className="mt-1 text-xs text-accent-danger">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setConfirm(null);
                setError(null);
              }}
              disabled={deleteMutation.isPending}
              className="rounded border border-default px-2.5 py-1 text-xs text-secondary hover:bg-elevated"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded bg-accent-danger px-2.5 py-1 text-xs text-white hover:bg-accent-danger/90 disabled:opacity-50"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
