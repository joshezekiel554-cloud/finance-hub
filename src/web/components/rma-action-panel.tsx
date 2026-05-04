// RmaActionPanel — state-driven action rail for the RMA detail page.
// Buttons shown depend on status + returnType. Per spec §6.3.
// Phase 3 buttons render visibly but disabled with a "(coming in Phase 3)" annotation.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle, ExternalLink } from "lucide-react";
import { Button } from "./ui/button";
import RmaApprovalEmailDialog from "./rma-approval-email-dialog";
import RmaDenialEmailDialog from "./rma-denial-email-dialog";
import RmaCreditMemoDialog from "./rma-credit-memo-dialog";

export type RmaStatus =
  | "draft"
  | "approved"
  | "awaiting_warehouse_number"
  | "sent_to_warehouse"
  | "received"
  | "completed"
  | "denied"
  | "cancelled";

export type RmaReturnType = "damage" | "seasonal" | "non_seasonal";

export type RmaActionPanelProps = {
  rmaId: string;
  rmaNumber: string | null;
  status: RmaStatus;
  returnType: RmaReturnType;
  customerId: string;
  qboCreditMemoId: string | null;
  creditMemoDocNumber: string | null;
  onRefresh: () => void;
};

export default function RmaActionPanel({
  rmaId,
  rmaNumber,
  status,
  returnType,
  customerId,
  qboCreditMemoId,
  creditMemoDocNumber,
  onRefresh,
}: RmaActionPanelProps) {
  const queryClient = useQueryClient();

  // Dialog state
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [approvedRmaData, setApprovedRmaData] = useState<{
    id: string;
    rmaNumber: string | null;
    customerId: string;
  } | null>(null);
  const [denialDialogOpen, setDenialDialogOpen] = useState(false);
  const [creditMemoDialogOpen, setCreditMemoDialogOpen] = useState(false);

  // Confirm state for mark-replacement-sent
  const [confirmReplacementOpen, setConfirmReplacementOpen] = useState(false);

  // Error display
  const [actionError, setActionError] = useState<string | null>(null);

  function clearError() {
    setActionError(null);
  }

  // Approve: POST /api/rmas/:id/approve then open approval email dialog
  const approveMutation = useMutation<
    { id: string; rmaNumber: string | null; customerId: string; status: string },
    Error,
    void
  >({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      clearError();
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
      setApprovedRmaData({ id: data.id, rmaNumber: data.rmaNumber ?? null, customerId: data.customerId ?? customerId });
      setApprovalDialogOpen(true);
    },
    onError: (err) => setActionError(err.message),
  });

  // Mark replacement sent: POST /api/rmas/:id/mark-replacement-sent
  const markReplacementMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/mark-replacement-sent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      clearError();
      setConfirmReplacementOpen(false);
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
      onRefresh();
    },
    onError: (err) => {
      setConfirmReplacementOpen(false);
      setActionError(err.message);
    },
  });

  const isBusy = approveMutation.isPending || markReplacementMutation.isPending;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        Actions
      </h3>

      {/* Error banner */}
      {actionError && (
        <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1">{actionError}</div>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 text-xs underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* draft */}
      {status === "draft" && (
        <div className="space-y-2">
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            disabled={isBusy}
            loading={approveMutation.isPending}
            onClick={() => approveMutation.mutate()}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="w-full"
            disabled={isBusy}
            onClick={() => { clearError(); setDenialDialogOpen(true); }}
          >
            Deny
          </Button>
        </div>
      )}

      {/* approved — damage */}
      {status === "approved" && returnType === "damage" && (
        <div className="space-y-2">
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            disabled={isBusy}
            onClick={() => { clearError(); setCreditMemoDialogOpen(true); }}
          >
            Issue credit memo
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            disabled={isBusy}
            onClick={() => { clearError(); setConfirmReplacementOpen(true); }}
          >
            Mark replacement sent
          </Button>
          {/* Unapprove — endpoint not wired in Phase 1 */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Unapprove
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (not available in Phase 1)
            </span>
          </div>
        </div>
      )}

      {/* approved — seasonal or non_seasonal */}
      {status === "approved" && (returnType === "seasonal" || returnType === "non_seasonal") && (
        <div className="space-y-2">
          <div className="relative">
            <Button
              variant="primary"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Send to warehouse
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (coming in Phase 3)
            </span>
          </div>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Unapprove
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (not available in Phase 1)
            </span>
          </div>
        </div>
      )}

      {/* awaiting_warehouse_number */}
      {status === "awaiting_warehouse_number" && (
        <div className="space-y-2">
          <div className="relative">
            <Button
              variant="primary"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Set warehouse number
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (coming in Phase 3)
            </span>
          </div>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Cancel warehouse export
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (coming in Phase 3)
            </span>
          </div>
        </div>
      )}

      {/* sent_to_warehouse */}
      {status === "sent_to_warehouse" && (
        <div className="space-y-2">
          <div className="relative">
            <Button
              variant="secondary"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Manual mark received
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (coming in Phase 3)
            </span>
          </div>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Cancel
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (coming in Phase 3)
            </span>
          </div>
        </div>
      )}

      {/* received */}
      {status === "received" && (
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => { clearError(); setCreditMemoDialogOpen(true); }}
        >
          Issue credit memo
        </Button>
      )}

      {/* completed */}
      {status === "completed" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle className="size-4 shrink-0" />
            RMA completed
          </div>
          {qboCreditMemoId && (
            <a
              href={`https://app.qbo.intuit.com/app/creditmemo?txnId=${qboCreditMemoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-accent-primary underline underline-offset-2 hover:text-accent-primary/80"
            >
              <ExternalLink className="size-3.5" />
              View CM {creditMemoDocNumber ?? qboCreditMemoId} in QBO
            </a>
          )}
        </div>
      )}

      {/* denied — seasonal: override-approve stubbed for Phase 3 */}
      {status === "denied" && returnType === "seasonal" && (
        <div className="space-y-2">
          <div className="rounded-md border border-default px-3 py-2 text-sm text-muted">
            This RMA was denied.
          </div>
          <div className="relative">
            <Button
              variant="secondary"
              size="sm"
              className="w-full opacity-50 cursor-not-allowed"
              disabled
            >
              Override-approve with reason
            </Button>
            <span className="block text-center text-[10px] text-muted mt-0.5">
              (coming in Phase 3)
            </span>
          </div>
        </div>
      )}

      {/* denied — damage or non_seasonal: read-only */}
      {status === "denied" && (returnType === "damage" || returnType === "non_seasonal") && (
        <div className="rounded-md border border-default px-3 py-2 text-sm text-muted">
          This RMA was denied. No further actions are available.
        </div>
      )}

      {/* cancelled */}
      {status === "cancelled" && (
        <div className="rounded-md border border-default px-3 py-2 text-sm text-muted">
          This RMA was cancelled.
        </div>
      )}

      {/* Mark replacement confirmation mini-dialog */}
      {confirmReplacementOpen && (
        <div className="rounded-md border border-accent-warning/30 bg-accent-warning/10 p-3 space-y-2">
          <p className="text-sm font-medium">Mark replacement as sent?</p>
          <p className="text-xs text-secondary">
            This is irreversible. The RMA will move to Completed status.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={markReplacementMutation.isPending}
              loading={markReplacementMutation.isPending}
              onClick={() => markReplacementMutation.mutate()}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={markReplacementMutation.isPending}
              onClick={() => setConfirmReplacementOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Approval email dialog */}
      {approvedRmaData && (
        <RmaApprovalEmailDialog
          open={approvalDialogOpen}
          onOpenChange={setApprovalDialogOpen}
          rmaId={approvedRmaData.id}
          rmaNumber={approvedRmaData.rmaNumber ?? approvedRmaData.id}
          customerId={approvedRmaData.customerId}
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
            onRefresh();
          }}
        />
      )}

      {/* Denial email dialog */}
      <RmaDenialEmailDialog
        open={denialDialogOpen}
        onOpenChange={setDenialDialogOpen}
        rmaId={rmaId}
        customerId={customerId}
        onSent={() => {
          queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
          onRefresh();
        }}
      />

      {/* Credit memo dialog */}
      <RmaCreditMemoDialog
        open={creditMemoDialogOpen}
        onOpenChange={setCreditMemoDialogOpen}
        rmaId={rmaId}
        customerId={customerId}
        onIssued={() => {
          queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
          onRefresh();
        }}
      />
    </div>
  );
}
