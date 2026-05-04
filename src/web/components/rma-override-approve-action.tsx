// RmaOverrideApproveAction — override-approve panel shown when
// status = denied AND returnType = seasonal.
// Operator enters a reason, submits, status transitions denied → approved.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Button } from "./ui/button";

type OverrideApproveResponse = {
  id: string;
  status: string;
  rmaNumber: string | null;
  customerId: string;
};

export default function RmaOverrideApproveAction({
  rmaId,
  onDone,
}: {
  rmaId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const overrideMutation = useMutation<OverrideApproveResponse, Error, void>({
    mutationFn: async () => {
      if (!reason.trim()) throw new Error("A reason is required to override-approve");
      const res = await fetch(`/api/rmas/${rmaId}/override-approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
      onDone();
    },
    onError: (err) => setError(err.message),
  });

  if (!expanded) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => setExpanded(true)}
      >
        Override-approve with reason
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-accent-warning/30 bg-accent-warning/5 p-3 space-y-2">
      <p className="text-sm font-medium">Override-approve this RMA</p>
      <p className="text-xs text-secondary">
        This will transition the RMA from Denied to Approved and begin the
        warehouse round-trip flow.
      </p>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-secondary">
          Reason (required)
        </span>
        <textarea
          rows={3}
          placeholder="Reason for overriding the denial…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
        />
      </label>
      {error && (
        <div className="flex items-start gap-2 text-xs text-accent-danger">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!reason.trim()}
          loading={overrideMutation.isPending}
          onClick={() => { setError(null); overrideMutation.mutate(); }}
        >
          Confirm override
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={overrideMutation.isPending}
          onClick={() => { setExpanded(false); setReason(""); setError(null); }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
