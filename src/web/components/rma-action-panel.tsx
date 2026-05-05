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
import RmaWarehouseExportAction from "./rma-warehouse-export-action";
import RmaSetWarehouseNumberAction from "./rma-set-warehouse-number-action";
import RmaOverrideApproveAction from "./rma-override-approve-action";

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
  trackingNumber: string | null;
  trackingCarrier: string | null;
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
  trackingNumber,
  trackingCarrier,
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

  // "Already credited" inline form (used to reconcile imported RMAs whose
  // desktop status was stale — CM was issued in QBO but the imported row
  // landed at "approved"). Operator pastes the QBO doc#, we look it up,
  // verify, and transition to completed.
  const [alreadyCreditedOpen, setAlreadyCreditedOpen] = useState(false);
  const [alreadyCreditedDocNumber, setAlreadyCreditedDocNumber] = useState("");

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

  const markAlreadyCreditedMutation = useMutation<unknown, Error, string>({
    mutationFn: async (docNumber) => {
      const res = await fetch(`/api/rmas/${rmaId}/mark-already-credited`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creditMemoDocNumber: docNumber }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      clearError();
      setAlreadyCreditedOpen(false);
      setAlreadyCreditedDocNumber("");
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
      onRefresh();
    },
    onError: (err) => setActionError(err.message),
  });

  const isBusy =
    approveMutation.isPending ||
    markReplacementMutation.isPending ||
    markAlreadyCreditedMutation.isPending;

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
          <AlreadyCreditedAction
            open={alreadyCreditedOpen}
            onOpenChange={(next) => {
              setAlreadyCreditedOpen(next);
              if (!next) setAlreadyCreditedDocNumber("");
            }}
            docNumber={alreadyCreditedDocNumber}
            onDocNumberChange={setAlreadyCreditedDocNumber}
            isPending={markAlreadyCreditedMutation.isPending}
            disabled={isBusy}
            onSubmit={() =>
              markAlreadyCreditedMutation.mutate(alreadyCreditedDocNumber)
            }
          />
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
          <RmaWarehouseExportAction
            rmaId={rmaId}
            onDone={() => {
              queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
              onRefresh();
            }}
          />
          <AlreadyCreditedAction
            open={alreadyCreditedOpen}
            onOpenChange={(next) => {
              setAlreadyCreditedOpen(next);
              if (!next) setAlreadyCreditedDocNumber("");
            }}
            docNumber={alreadyCreditedDocNumber}
            onDocNumberChange={setAlreadyCreditedDocNumber}
            isPending={markAlreadyCreditedMutation.isPending}
            disabled={isBusy}
            onSubmit={() =>
              markAlreadyCreditedMutation.mutate(alreadyCreditedDocNumber)
            }
          />
        </div>
      )}

      {/* awaiting_warehouse_number */}
      {status === "awaiting_warehouse_number" && (
        <div className="space-y-2">
          <RmaSetWarehouseNumberAction
            rmaId={rmaId}
            customerId={customerId}
            onDone={() => {
              queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
              onRefresh();
            }}
          />
          <CancelWarehouseExportButton
            rmaId={rmaId}
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
              onRefresh();
            }}
          />
        </div>
      )}

      {/* sent_to_warehouse */}
      {status === "sent_to_warehouse" && (
        <div className="space-y-2">
          <TrackingAction
            rmaId={rmaId}
            existingTrackingNumber={trackingNumber}
            existingTrackingCarrier={trackingCarrier}
            onSaved={() => {
              queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
              onRefresh();
            }}
          />
          <ManualMarkReceivedButton
            rmaId={rmaId}
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
              onRefresh();
            }}
          />
        </div>
      )}

      {/* received */}
      {status === "received" && (
        <div className="space-y-2">
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            onClick={() => { clearError(); setCreditMemoDialogOpen(true); }}
          >
            Issue credit memo
          </Button>
          <AlreadyCreditedAction
            open={alreadyCreditedOpen}
            onOpenChange={(next) => {
              setAlreadyCreditedOpen(next);
              if (!next) setAlreadyCreditedDocNumber("");
            }}
            docNumber={alreadyCreditedDocNumber}
            onDocNumberChange={setAlreadyCreditedDocNumber}
            isPending={markAlreadyCreditedMutation.isPending}
            disabled={isBusy}
            onSubmit={() =>
              markAlreadyCreditedMutation.mutate(alreadyCreditedDocNumber)
            }
          />
        </div>
      )}

      {/* completed */}
      {status === "completed" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle className="size-4 shrink-0" />
            RMA completed
          </div>
          {qboCreditMemoId ? (
            <a
              href={`https://app.qbo.intuit.com/app/creditmemo?txnId=${qboCreditMemoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-accent-primary underline underline-offset-2 hover:text-accent-primary/80"
            >
              <ExternalLink className="size-3.5" />
              View CM {creditMemoDocNumber ?? qboCreditMemoId} in QBO
            </a>
          ) : (
            // Imported RMA without a CM link yet — let the operator backfill
            // the QBO doc number using the same Already credited flow.
            <AlreadyCreditedAction
              open={alreadyCreditedOpen}
              onOpenChange={(next) => {
                setAlreadyCreditedOpen(next);
                if (!next) setAlreadyCreditedDocNumber("");
              }}
              docNumber={alreadyCreditedDocNumber}
              onDocNumberChange={setAlreadyCreditedDocNumber}
              isPending={markAlreadyCreditedMutation.isPending}
              disabled={isBusy}
              onSubmit={() =>
                markAlreadyCreditedMutation.mutate(alreadyCreditedDocNumber)
              }
            />
          )}
        </div>
      )}

      {/* denied — seasonal: override-approve */}
      {status === "denied" && returnType === "seasonal" && (
        <div className="space-y-2">
          <div className="rounded-md border border-default px-3 py-2 text-sm text-muted">
            This RMA was denied.
          </div>
          <RmaOverrideApproveAction
            rmaId={rmaId}
            onDone={() => {
              queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
              onRefresh();
            }}
          />
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

      {/* Cancel + Delete — visible at the end of the action panel.
          Cancel: approved / awaiting_warehouse_number / sent_to_warehouse only.
          Delete: draft / cancelled only. */}
      <div className="border-t border-default pt-3">
        <RmaLifecycleActionsInPanel
          rmaId={rmaId}
          status={status}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
            onRefresh();
          }}
        />
      </div>
    </div>
  );
}

// ---- Tracking number + warehouse notification ------------------------------
// Shown on a sent_to_warehouse RMA: operator pastes the customer's return
// tracking number and we POST it. Backend saves the columns and (if
// warehouse_team_email is configured) emails the warehouse team so they
// know to expect the parcel. Updates are allowed — operator can re-save a
// corrected number.

const CARRIER_OPTIONS = [
  "UPS",
  "FedEx",
  "USPS",
  "DHL",
  "Royal Mail",
  "Parcelforce",
  "Other",
] as const;

function TrackingAction({
  rmaId,
  existingTrackingNumber,
  existingTrackingCarrier,
  onSaved,
}: {
  rmaId: string;
  existingTrackingNumber: string | null;
  existingTrackingCarrier: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState(
    existingTrackingNumber ?? "",
  );
  const [trackingCarrier, setTrackingCarrier] = useState(
    existingTrackingCarrier ?? "UPS",
  );
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setPending(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch(`/api/rmas/${rmaId}/set-tracking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackingNumber: trackingNumber.trim(),
          trackingCarrier: trackingCarrier || null,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        emailedTo: string | null;
      };
      setSavedNotice(
        data.emailedTo
          ? `Tracking saved. Emailed warehouse team at ${data.emailedTo}.`
          : "Tracking saved. Set warehouse_team_email in settings to auto-notify the warehouse.",
      );
      setNotes("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    // Show summary chip if tracking is already set, otherwise a CTA.
    return existingTrackingNumber ? (
      <div className="space-y-1">
        <div className="rounded-md border border-default bg-subtle px-3 py-2 text-xs">
          <div className="text-muted">Tracking</div>
          <div className="mt-0.5 font-mono">
            {existingTrackingCarrier ? `${existingTrackingCarrier} · ` : ""}
            {existingTrackingNumber}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => {
            setOpen(true);
            setError(null);
            setSavedNotice(null);
          }}
        >
          Update tracking
        </Button>
      </div>
    ) : (
      <Button
        type="button"
        variant="primary"
        size="sm"
        className="w-full"
        onClick={() => {
          setOpen(true);
          setError(null);
          setSavedNotice(null);
        }}
      >
        Add tracking #
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-default bg-subtle p-3 space-y-2">
      <p className="text-xs font-medium">
        {existingTrackingNumber ? "Update tracking" : "Add tracking number"}
      </p>
      <p className="text-[11px] text-muted">
        Saved tracking is emailed to the warehouse team
        {" "}
        (configured via <code>warehouse_team_email</code> in settings).
      </p>
      <label className="block">
        <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted">
          Carrier
        </span>
        <select
          value={trackingCarrier}
          onChange={(e) => setTrackingCarrier(e.target.value)}
          className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
        >
          {CARRIER_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted">
          Tracking number
        </span>
        <input
          type="text"
          autoFocus
          value={trackingNumber}
          onChange={(e) => setTrackingNumber(e.target.value)}
          placeholder="e.g. 1Z999AA10123456784"
          className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm font-mono"
          onKeyDown={(e) => {
            if (e.key === "Enter" && trackingNumber.trim()) void submit();
            if (e.key === "Escape") setOpen(false);
          }}
        />
      </label>
      <label className="block">
        <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted">
          Notes for warehouse (optional)
        </span>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. fragile — handle with care"
          className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
        />
      </label>
      {error && <div className="text-xs text-accent-danger">{error}</div>}
      {savedNotice && (
        <div className="text-xs text-success">{savedNotice}</div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Close
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending || !trackingNumber.trim()}
          onClick={() => void submit()}
        >
          {pending ? "Saving…" : "Save & notify warehouse"}
        </Button>
      </div>
    </div>
  );
}

// ---- Already credited (manual reconciliation) -------------------------------
// Inline button + form for marking an RMA as completed without creating a new
// QBO credit memo — used when the imported desktop status was stale and the
// CM was actually issued in QBO under a known doc number.

function AlreadyCreditedAction({
  open,
  onOpenChange,
  docNumber,
  onDocNumberChange,
  isPending,
  disabled,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  docNumber: string;
  onDocNumberChange: (next: string) => void;
  isPending: boolean;
  disabled: boolean;
  onSubmit: () => void;
}) {
  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full"
        disabled={disabled}
        onClick={() => onOpenChange(true)}
      >
        Already credited (link existing CM)
      </Button>
    );
  }
  return (
    <div className="rounded-md border border-default bg-subtle p-3 space-y-2">
      <p className="text-xs font-medium">Already credited in QBO?</p>
      <p className="text-[11px] text-muted">
        Paste the QBO credit memo doc number (e.g. <code>18329CR</code>). We'll
        verify it exists and move this RMA to Completed without re-creating
        anything in QBO.
      </p>
      <input
        type="text"
        autoFocus
        value={docNumber}
        onChange={(e) => onDocNumberChange(e.target.value)}
        placeholder="QBO CM doc number"
        className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter" && docNumber.trim()) onSubmit();
          if (e.key === "Escape") onOpenChange(false);
        }}
      />
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={isPending || !docNumber.trim()}
          loading={isPending}
          onClick={onSubmit}
        >
          Mark completed
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---- Cancel + Delete on the detail page -------------------------------------

function RmaLifecycleActionsInPanel({
  rmaId,
  status,
  onChanged,
}: {
  rmaId: string;
  status: RmaStatus;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState<
    null | "cancel" | "delete" | "revert" | "changeStatus"
  >(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Target status for the manual status override
  const [targetStatus, setTargetStatus] = useState<RmaStatus>("draft");

  const canCancel =
    status === "approved" ||
    status === "awaiting_warehouse_number" ||
    status === "sent_to_warehouse";
  const canDelete = status === "draft" || status === "cancelled";
  const canRevert =
    status === "approved" ||
    status === "awaiting_warehouse_number" ||
    status === "sent_to_warehouse" ||
    status === "received" ||
    status === "denied";

  // No early return — the manual status override is always available as an
  // admin escape hatch, so the lifecycle row always has at least one button.

  async function runCancel(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/rmas/${rmaId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setConfirmOpen(null);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setPending(false);
    }
  }

  async function runDelete(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/rmas/${rmaId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      window.location.href = "/returns";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setPending(false);
    }
  }

  async function runRevert(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/rmas/${rmaId}/revert-to-draft`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setConfirmOpen(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revert failed");
    } finally {
      setPending(false);
    }
  }

  async function runForceStatus(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/rmas/${rmaId}/force-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: targetStatus,
          reason: reason || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setConfirmOpen(null);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status change failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {canRevert && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setConfirmOpen("revert");
              setError(null);
            }}
          >
            Edit (revert to draft)
          </Button>
        )}
        {canCancel && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setConfirmOpen("cancel");
              setError(null);
            }}
          >
            Cancel RMA
          </Button>
        )}
        {canDelete && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => {
              setConfirmOpen("delete");
              setError(null);
            }}
          >
            Delete
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setConfirmOpen("changeStatus");
            setTargetStatus(status);
            setError(null);
          }}
        >
          Change status…
        </Button>
      </div>

      {confirmOpen === "cancel" && (
        <div className="rounded-md border border-default bg-elevated p-3 text-xs">
          <div className="font-medium">Cancel this RMA?</div>
          <div className="mt-1 text-muted">
            Stays in your records (audit trail) but no further action can be
            taken. Reason is optional.
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            rows={2}
            className="mt-2 w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
          />
          {error && (
            <div className="mt-2 text-accent-danger">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmOpen(null)}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void runCancel()}
              disabled={pending}
            >
              {pending ? "Cancelling…" : "Confirm cancel"}
            </Button>
          </div>
        </div>
      )}

      {confirmOpen === "revert" && (
        <div className="rounded-md border border-accent-warning/40 bg-accent-warning/5 p-3 text-xs">
          <div className="font-medium text-accent-warning">
            Revert to draft for editing?
          </div>
          <div className="mt-1 text-muted">
            Wipes the workflow state (warehouse number, export timestamp,
            approval/denial info). Items + activity history are preserved.
            You'll need to re-walk Approve → Warehouse export → tx# afterwards.
            If you've already emailed the customer their RMA number, this will
            invalidate it — best to coordinate with them first.
          </div>
          {error && (
            <div className="mt-2 text-accent-danger">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmOpen(null)}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void runRevert()}
              disabled={pending}
            >
              {pending ? "Reverting…" : "Revert to draft"}
            </Button>
          </div>
        </div>
      )}

      {confirmOpen === "delete" && (
        <div className="rounded-md border border-accent-danger/40 bg-accent-danger/5 p-3 text-xs">
          <div className="font-medium text-accent-danger">
            Delete permanently?
          </div>
          <div className="mt-1 text-muted">
            Wipes the RMA + items from the database. Drive photos remain.
          </div>
          {error && (
            <div className="mt-2 text-accent-danger">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmOpen(null)}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => void runDelete()}
              disabled={pending}
            >
              {pending ? "Deleting…" : "Yes, delete"}
            </Button>
          </div>
        </div>
      )}

      {confirmOpen === "changeStatus" && (
        <div className="rounded-md border border-accent-warning/40 bg-accent-warning/5 p-3 text-xs space-y-2">
          <div className="font-medium text-accent-warning">
            Manually change status
          </div>
          <div className="text-muted">
            Bypasses the normal workflow — use only to fix imported RMAs whose
            lifecycle drifted (e.g. flip "Approved" → "Awaiting return"
            because the warehouse handoff already happened in the desktop
            app). Other fields aren't touched.
          </div>
          <label className="block">
            <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted">
              New status
            </span>
            <select
              value={targetStatus}
              onChange={(e) => setTargetStatus(e.target.value as RmaStatus)}
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            >
              {STATUS_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value} disabled={value === status}>
                  {label}
                  {value === status ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted">
              Reason (optional, for audit log)
            </span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. imported, warehouse handoff already done"
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>
          {error && <div className="text-accent-danger">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setConfirmOpen(null);
                setReason("");
              }}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || targetStatus === status}
              onClick={() => void runForceStatus()}
            >
              {pending ? "Updating…" : "Set status"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Status options for the manual override dropdown. Mirrors the labels
// shown on the returns list / detail page so operators see consistent
// terminology.
const STATUS_OPTIONS: Array<{ value: RmaStatus; label: string }> = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "awaiting_warehouse_number", label: "Awaiting warehouse #" },
  { value: "sent_to_warehouse", label: "Awaiting return" },
  { value: "received", label: "Received" },
  { value: "completed", label: "Completed" },
  { value: "denied", label: "Denied" },
  { value: "cancelled", label: "Cancelled" },
];

// ---- Cancel warehouse export -------------------------------------------------

function CancelWarehouseExportButton({
  rmaId,
  onSuccess,
}: {
  rmaId: string;
  onSuccess: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const cancelMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/cancel-warehouse-export`, {
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
    onSuccess: () => { setError(null); onSuccess(); },
    onError: (err) => setError(err.message),
  });

  return (
    <div className="space-y-1">
      <Button
        variant="ghost"
        size="sm"
        className="w-full"
        loading={cancelMutation.isPending}
        onClick={() => { setError(null); cancelMutation.mutate(); }}
      >
        Cancel warehouse export
      </Button>
      {error && (
        <div className="flex items-center gap-1 text-xs text-accent-danger">
          <AlertCircle className="size-3 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

// ---- Manual mark received ---------------------------------------------------

function ManualMarkReceivedButton({
  rmaId,
  onSuccess,
}: {
  rmaId: string;
  onSuccess: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/manual-mark-received`, {
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
    onSuccess: () => { setError(null); setConfirm(false); onSuccess(); },
    onError: (err) => { setError(err.message); setConfirm(false); },
  });

  if (confirm) {
    return (
      <div className="rounded-md border border-accent-warning/30 bg-accent-warning/10 p-3 space-y-2">
        <p className="text-sm font-medium">Mark as received?</p>
        <p className="text-xs text-secondary">
          Use this if automatic warehouse matching hasn't picked up the receipt.
        </p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Confirm
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => setConfirm(false)}
          >
            Cancel
          </Button>
        </div>
        {error && (
          <div className="flex items-center gap-1 text-xs text-accent-danger">
            <AlertCircle className="size-3 shrink-0" />
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => setConfirm(true)}
      >
        Manual mark received
      </Button>
      {error && (
        <div className="flex items-center gap-1 text-xs text-accent-danger">
          <AlertCircle className="size-3 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
