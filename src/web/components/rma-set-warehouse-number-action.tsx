// RmaSetWarehouseNumberAction — panel shown when status = awaiting_warehouse_number.
// Operator pastes the Extensiv transaction number, submits, and the RMA
// transitions to sent_to_warehouse. On success: open the approval email dialog
// (with optional eligibility PDF attachment if thresholdOverridden).

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import RmaApprovalEmailDialog from "./rma-approval-email-dialog";

type SetWarehouseNumberResponse = {
  id: string;
  rmaNumber: string | null;
  status: string;
  customerId: string;
  thresholdOverridden?: boolean;
  denialPdfDriveId?: string | null;
};

export default function RmaSetWarehouseNumberAction({
  rmaId,
  customerId,
  onDone,
}: {
  rmaId: string;
  customerId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [txNumber, setTxNumber] = useState("");
  const [error, setError] = useState<string | null>(null);

  // After successful set-warehouse-number, open the approval email dialog
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [approvedRmaData, setApprovedRmaData] = useState<{
    id: string;
    rmaNumber: string | null;
    customerId: string;
    pdfDriveId?: string | null;
  } | null>(null);

  const setNumberMutation = useMutation<SetWarehouseNumberResponse, Error, void>({
    mutationFn: async () => {
      if (!txNumber.trim()) throw new Error("Transaction number is required");
      const res = await fetch(`/api/rmas/${rmaId}/set-warehouse-number`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txNumber: txNumber.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
      setApprovedRmaData({
        id: data.id,
        rmaNumber: data.rmaNumber ?? null,
        customerId: data.customerId ?? customerId,
        pdfDriveId: data.denialPdfDriveId ?? null,
      });
      setApprovalDialogOpen(true);
    },
    onError: (err) => setError(err.message),
  });

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-default bg-subtle px-3 py-3 space-y-2">
        <label className="block text-xs font-medium text-secondary">
          Extensiv transaction number
        </label>
        <input
          type="text"
          value={txNumber}
          onChange={(e) => setTxNumber(e.target.value)}
          placeholder="e.g. 12345678"
          onKeyDown={(e) => {
            if (e.key === "Enter") setNumberMutation.mutate();
          }}
          className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
        />
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          disabled={!txNumber.trim()}
          loading={setNumberMutation.isPending}
          onClick={() => { setError(null); setNumberMutation.mutate(); }}
        >
          Submit
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-xs text-accent-danger">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Open approval email dialog on success */}
      {approvedRmaData && (
        <RmaApprovalEmailDialog
          open={approvalDialogOpen}
          onOpenChange={setApprovalDialogOpen}
          rmaId={approvedRmaData.id}
          rmaNumber={approvedRmaData.rmaNumber ?? approvedRmaData.id}
          customerId={approvedRmaData.customerId}
          pdfDriveId={approvedRmaData.pdfDriveId ?? null}
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
            onDone();
          }}
        />
      )}
    </div>
  );
}
