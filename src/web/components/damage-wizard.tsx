// DamageWizard — 3-step wizard for damage RMAs.
//
//   1. Items     — parse email + items table + bulk lookup. Soft warning when
//                  an item isn't on the customer's prior invoices.
//   2. Decide    — Approve (silent, no email) or Deny (opens denial dialog
//                  with quick-pick reasons).
//   3. Issue CM  — auto-opens the RmaCreditMemoDialog where the operator
//                  reviews deductions, sales tax, and sends the credit memo
//                  email with the QBO PDF attached.
//
// Damage RMAs skip warehouse handling and approval emails — the credit memo
// itself is the customer-facing artifact, so there's no separate "you've
// been approved" message. Approve transitions draft → approved (which also
// allocates the DC-... rmaNumber) then auto-advances to step 3.
//
// Seasonal/non-seasonal RMAs use SeasonalWizard instead.

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";
import RmaItemsTable, {
  type RmaItemRow,
  makeEmptyRow,
} from "./rma-items-table";
import ParseEmailSection, { type ParsedItem } from "./parse-email-section";
import RmaDenialEmailDialog from "./rma-denial-email-dialog";
import RmaCreditMemoDialog from "./rma-credit-memo-dialog";
import { PhotoUploadZone } from "./photo-upload-zone";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DamageWizardCustomer = {
  id: string;
  qbCustomerId: string;
  displayName: string;
};

export type DamageWizardProps = {
  customer: DamageWizardCustomer;
  /** Existing RMA id when resuming an in-progress wizard. Null for new RMAs. */
  initialRmaId?: string | null;
  /** Called once the credit memo dialog confirms the email was sent. */
  onCompleted?: (rmaId: string) => void;
};

type RmaSummary = {
  id: string;
  rmaNumber: string | null;
  status:
    | "draft"
    | "approved"
    | "awaiting_warehouse_number"
    | "sent_to_warehouse"
    | "received"
    | "completed"
    | "denied"
    | "cancelled";
  qbCustomerId: string | null;
  items: RmaItemRow[];
};

const STEPS = [
  { id: 1, label: "Items" },
  { id: 2, label: "Decide" },
  { id: 3, label: "Credit memo" },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DamageWizard({
  customer,
  initialRmaId = null,
  onCompleted,
}: DamageWizardProps) {
  const queryClient = useQueryClient();

  const [rmaId, setRmaId] = useState<string | null>(initialRmaId);
  const [items, setItems] = useState<RmaItemRow[]>([]);
  const [notes, setNotes] = useState("");
  const [stepIndex, setStepIndex] = useState(0);

  // Per-item override: if the operator has explicitly OK'd an item that the
  // prior-invoice check flagged, we hide the warning. Keyed by localKey.
  const [overriddenWarnings, setOverriddenWarnings] = useState<
    Record<string, boolean>
  >({});

  const [denialDialogOpen, setDenialDialogOpen] = useState(false);
  const [creditMemoDialogOpen, setCreditMemoDialogOpen] = useState(false);

  // ---- Fetch RMA when rmaId set ───────────────────────────────────────────
  const rmaQuery = useQuery<RmaSummary | null>({
    queryKey: ["rma-wizard", rmaId],
    enabled: !!rmaId,
    queryFn: async () => {
      if (!rmaId) return null;
      const res = await fetch(`/api/rmas/${rmaId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<RmaSummary>;
    },
    refetchInterval: false,
  });

  const rma = rmaQuery.data ?? null;

  // ---- Hydrate from existing RMA when resuming ─────────────────────────────
  useEffect(() => {
    if (!rma) return;
    if (rma.items && rma.items.length > 0 && items.length === 0) {
      const rows: RmaItemRow[] = rma.items.map((it) => ({
        ...makeEmptyRow(),
        id: it.id,
        qbItemId: it.qbItemId,
        sku: it.sku,
        name: it.name,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        listUnitPrice: it.listUnitPrice,
        invoiceDiscountPct: it.invoiceDiscountPct,
        lineTotal: it.lineTotal,
        originalInvoiceDocNumber: it.originalInvoiceDocNumber,
        originalInvoiceDate: it.originalInvoiceDate,
        reason: it.reason ?? "",
      }));
      setItems(rows);
    }
  }, [rma, items.length]);

  // ---- Auto-advance step based on RMA status (forward only) ──────────────
  useEffect(() => {
    if (!rma) return;
    // Damage flow: draft → step 1, approved → step 3, completed → step 3 (terminal).
    let target: number;
    switch (rma.status) {
      case "approved":
      case "received":
      case "completed":
        target = 2;
        break;
      case "denied":
      case "cancelled":
        target = 1;
        break;
      default:
        target = 0;
    }
    if (target > stepIndex) setStepIndex(target);
  }, [rma?.status, stepIndex, rma]);

  // ---- Prior-invoice items lookup ─────────────────────────────────────────
  const priorItemsQuery = useQuery<{ qbItemIds: string[] }>({
    queryKey: ["qbo-prior-invoice-items", customer.qbCustomerId],
    enabled: !!customer.qbCustomerId,
    queryFn: async () => {
      const res = await fetch(
        `/api/rmas/qbo-prior-invoice-items?qbCustomerId=${encodeURIComponent(
          customer.qbCustomerId,
        )}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const priorItemIdSet = useMemo(
    () => new Set(priorItemsQuery.data?.qbItemIds ?? []),
    [priorItemsQuery.data],
  );

  // Each row's warning state. Skip rows with no qbItemId resolved yet — the
  // operator hasn't picked an item, so we can't usefully check membership.
  // The override flag lets the operator dismiss the chip once acknowledged.
  function isFlagged(row: RmaItemRow): boolean {
    if (!row.qbItemId) return false;
    if (overriddenWarnings[row.localKey]) return false;
    if (priorItemsQuery.data == null) return false;
    return !priorItemIdSet.has(row.qbItemId);
  }

  // ---- Mutations ──────────────────────────────────────────────────────────
  const createRmaMutation = useMutation<{ id: string }, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/rmas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: customer.id,
          qbCustomerId: customer.qbCustomerId,
          returnType: "damage",
          notes: notes || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setRmaId(data.id);
    },
  });

  // Photo upload needs an existing rmaId, so create the draft eagerly when
  // the wizard mounts (and we don't already have one). The orphan-draft cost
  // is mitigated by the Delete button in the lifecycle actions row + the
  // returns list; the win is photos can be dragged in immediately while the
  // operator is still working through the items step.
  useEffect(() => {
    if (rmaId) return;
    if (createRmaMutation.isPending || createRmaMutation.isError) return;
    createRmaMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addItemsMutation = useMutation<void, Error, string>({
    mutationFn: async (id) => {
      // POST new items (no DB id yet) and PATCH existing ones whose local
      // state has been edited (e.g. imported rows where the operator just
      // picked the real QBO item via the picker — qbItemId now needs to
      // reach the backend).
      const newItems = items.filter((it) => it.qbItemId && !it.id);
      const existingItems = items.filter((it) => it.qbItemId && it.id);
      await Promise.all([
        ...newItems.map(async (it) => {
          const res = await fetch(`/api/rmas/${id}/items`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              qbItemId: it.qbItemId,
              sku: it.sku,
              name: it.name,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              classification: "damage",
              listUnitPrice: it.listUnitPrice ?? null,
              invoiceDiscountPct: it.invoiceDiscountPct ?? null,
              reason: it.reason || null,
              originalInvoiceDocNumber: it.originalInvoiceDocNumber ?? null,
              originalInvoiceDate: it.originalInvoiceDate ?? null,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? `HTTP ${res.status}`);
          }
        }),
        ...existingItems.map(async (it) => {
          const res = await fetch(`/api/rmas/${id}/items/${it.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              qbItemId: it.qbItemId,
              sku: it.sku,
              name: it.name,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              listUnitPrice: it.listUnitPrice ?? null,
              invoiceDiscountPct: it.invoiceDiscountPct ?? null,
              reason: it.reason || null,
              originalInvoiceDocNumber: it.originalInvoiceDocNumber ?? null,
              originalInvoiceDate: it.originalInvoiceDate ?? null,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? `HTTP ${res.status}`);
          }
        }),
      ]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rma-wizard", rmaId] });
    },
  });

  const approveMutation = useMutation<RmaSummary, Error>({
    mutationFn: async () => {
      let id = rmaId;
      if (!id) {
        const created = await createRmaMutation.mutateAsync();
        id = created.id;
      }
      // Persist any new items
      await addItemsMutation.mutateAsync(id);

      // Damage approve: silent — no email. Just transition draft → approved.
      const res = await fetch(`/api/rmas/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rma-wizard", rmaId] });
      setStepIndex(2); // Credit memo
      setCreditMemoDialogOpen(true);
    },
  });

  // ---- Step prerequisites + navigation ────────────────────────────────────
  const hasResolvedItems = items.some((it) => it.qbItemId);

  function appendParsedItems(parsed: ParsedItem[]): void {
    const newRows: RmaItemRow[] = parsed.map((p) => ({
      ...makeEmptyRow(),
      qbItemId: "",
      sku: p.sku ?? "",
      name: p.name ?? "",
      quantity: p.quantity > 0 ? String(p.quantity) : "1",
      reason: p.reason ?? "",
    }));
    setItems((prev) => [...prev, ...newRows]);
  }

  // ---- Step renderers ─────────────────────────────────────────────────────
  let stepContent: ReactNode;
  switch (stepIndex) {
    case 0:
      stepContent = (
        <StepItems
          rmaId={rmaId}
          qbCustomerId={customer.qbCustomerId}
          items={items}
          onItemsChange={setItems}
          onItemsParsed={appendParsedItems}
          notes={notes}
          onNotesChange={setNotes}
          isFlagged={isFlagged}
          onOverrideWarning={(localKey) =>
            setOverriddenWarnings((prev) => ({ ...prev, [localKey]: true }))
          }
          priorItemsLoading={priorItemsQuery.isPending}
          showPhotos={!!rmaId}
          onNext={() => setStepIndex(1)}
          canProceed={hasResolvedItems}
        />
      );
      break;

    case 1:
      stepContent = (
        <StepDecide
          items={items}
          isPending={
            approveMutation.isPending || createRmaMutation.isPending
          }
          error={approveMutation.error || createRmaMutation.error}
          onApprove={() => approveMutation.mutate()}
          onDeny={async () => {
            // Denial requires an existing rmaId — auto-create the draft if
            // it doesn't exist yet, then open the dialog.
            let id = rmaId;
            if (!id) {
              const created = await createRmaMutation.mutateAsync();
              id = created.id;
              await addItemsMutation.mutateAsync(id);
            }
            setDenialDialogOpen(true);
          }}
          onPrev={() => setStepIndex(0)}
        />
      );
      break;

    case 2:
      stepContent = (
        <StepIssueCm
          rma={rma}
          onOpen={() => setCreditMemoDialogOpen(true)}
        />
      );
      break;

    default:
      stepContent = null;
  }

  return (
    <div className="space-y-4">
      {/* Stepper */}
      <Stepper steps={STEPS} active={stepIndex} onJump={setStepIndex} />

      {/* RMA status badge */}
      {rma && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-default bg-subtle px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-secondary">
            <span>RMA</span>
            <span className="font-mono text-primary">
              {rma.rmaNumber ?? `Draft ${rma.id.slice(0, 8)}…`}
            </span>
            <Badge tone={statusTone(rma.status)}>
              {statusLabel(rma.status)}
            </Badge>
          </div>
        </div>
      )}

      {/* Step content */}
      <div>{stepContent}</div>

      {/* Denial dialog */}
      {rmaId && (
        <RmaDenialEmailDialog
          open={denialDialogOpen}
          onOpenChange={setDenialDialogOpen}
          rmaId={rmaId}
          customerId={customer.id}
          onSent={() => {
            setDenialDialogOpen(false);
            if (rmaId) onCompleted?.(rmaId);
          }}
        />
      )}

      {/* Credit memo dialog (auto-opens at step 3) */}
      {rmaId && (
        <RmaCreditMemoDialog
          open={creditMemoDialogOpen}
          onOpenChange={setCreditMemoDialogOpen}
          rmaId={rmaId}
          customerId={customer.id}
          onIssued={() => {
            setCreditMemoDialogOpen(false);
            if (rmaId) onCompleted?.(rmaId);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper UI
// ---------------------------------------------------------------------------

function Stepper({
  steps,
  active,
  onJump,
}: {
  steps: readonly { id: number; label: string }[];
  active: number;
  onJump: (idx: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {steps.map((s, idx) => {
        const isActive = idx === active;
        const isPast = idx < active;
        const isClickable = isPast || isActive;
        return (
          <li key={s.id}>
            <button
              type="button"
              disabled={!isClickable}
              onClick={() => {
                if (isClickable) onJump(idx);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 transition-colors",
                isActive
                  ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                  : isPast
                    ? "border-default bg-elevated text-secondary hover:bg-elevated/80"
                    : "border-default text-muted opacity-50 cursor-not-allowed",
              )}
            >
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full text-[10px] font-semibold",
                  isActive
                    ? "bg-accent-primary text-white"
                    : isPast
                      ? "bg-success/30 text-success"
                      : "bg-elevated text-muted",
                )}
              >
                {isPast ? <Check className="size-3" /> : idx + 1}
              </span>
              <span className="font-medium">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Items
// ---------------------------------------------------------------------------

function StepItems({
  rmaId,
  qbCustomerId,
  items,
  onItemsChange,
  onItemsParsed,
  notes,
  onNotesChange,
  isFlagged,
  onOverrideWarning,
  priorItemsLoading,
  showPhotos,
  onNext,
  canProceed,
}: {
  rmaId: string | null;
  qbCustomerId: string;
  items: RmaItemRow[];
  onItemsChange: (next: RmaItemRow[]) => void;
  onItemsParsed: (parsed: ParsedItem[]) => void;
  notes: string;
  onNotesChange: (next: string) => void;
  isFlagged: (row: RmaItemRow) => boolean;
  onOverrideWarning: (localKey: string) => void;
  priorItemsLoading: boolean;
  showPhotos: boolean;
  onNext: () => void;
  canProceed: boolean;
}) {
  const flaggedRows = items.filter(isFlagged);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Items</h2>
          <p className="mt-1 text-xs text-muted">
            Paste the customer's email to auto-extract items, then resolve
            them against QBO and pull list prices + original invoice numbers.
          </p>
        </CardHeader>
      </Card>

      <ParseEmailSection onItemsParsed={onItemsParsed} />

      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Items being returned</h3>
        </CardHeader>
        <CardBody className="space-y-3">
          <RmaItemsTable
            rmaId={rmaId}
            qbCustomerId={qbCustomerId}
            items={items}
            onChange={onItemsChange}
          />

          {/* Soft warnings: items not on any prior invoice. */}
          {!priorItemsLoading && flaggedRows.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-accent-warning/30 bg-accent-warning/5 px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-accent-warning">
                <AlertTriangle className="size-3.5" />
                Not on any prior invoice
              </div>
              <p className="text-[11px] text-muted">
                The customer has no record of buying these items. Confirm
                before approving — or click "OK, allow" to dismiss.
              </p>
              {flaggedRows.map((row) => (
                <div
                  key={row.localKey}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate">
                    <span className="font-mono text-muted">{row.sku}</span>
                    <span className="ml-1.5">{row.name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onOverrideWarning(row.localKey)}
                    className="shrink-0 rounded border border-default bg-base px-2 py-0.5 text-[11px] text-secondary hover:bg-elevated"
                  >
                    OK, allow
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Photo upload — damage RMAs need photos for the credit memo case
          file. Available immediately because the draft RMA is auto-created
          on wizard mount. */}
      {showPhotos && <PhotoUploadZone rmaId={rmaId} />}

      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Notes (internal)</h3>
        </CardHeader>
        <CardBody>
          <textarea
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Any context on this damage return — visible to operators only."
            rows={3}
            className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
          />
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button type="button" disabled={!canProceed} onClick={onNext}>
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Decide
// ---------------------------------------------------------------------------

function StepDecide({
  items,
  isPending,
  error,
  onApprove,
  onDeny,
  onPrev,
}: {
  items: RmaItemRow[];
  isPending: boolean;
  error: Error | null;
  onApprove: () => void;
  onDeny: () => void;
  onPrev: () => void;
}) {
  const resolvedItems = items.filter((it) => it.qbItemId);
  const totalValue = resolvedItems.reduce((sum, it) => {
    const lineTotal = parseFloat(it.lineTotal ?? "0");
    if (Number.isFinite(lineTotal) && lineTotal !== 0) return sum + lineTotal;
    const qty = parseFloat(it.quantity) || 0;
    const price = parseFloat(it.unitPrice) || 0;
    return sum + qty * price;
  }, 0);

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Approve or deny</h2>
        <p className="mt-1 text-xs text-muted">
          Approving here records the damage RMA and proceeds to the credit
          memo step. The customer is NOT emailed at this stage — the credit
          memo email is the only customer-facing message in the damage flow.
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="rounded-md border border-default bg-subtle px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-secondary">
              {resolvedItems.length} item
              {resolvedItems.length === 1 ? "" : "s"}
            </span>
            <span className="tabular-nums font-medium">
              ${totalValue.toFixed(2)}
            </span>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error.message}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={onPrev}>
            <ChevronLeft className="size-4" />
            Back
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="danger"
              onClick={onDeny}
              disabled={isPending}
            >
              Deny
            </Button>
            <Button type="button" onClick={onApprove} disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              Approve →
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Issue credit memo
// ---------------------------------------------------------------------------

function StepIssueCm({
  rma,
  onOpen,
}: {
  rma: RmaSummary | null;
  onOpen: () => void;
}) {
  const isCompleted = rma?.status === "completed";
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Issue credit memo</h2>
        <p className="mt-1 text-xs text-muted">
          Review deductions and sales tax in the dialog, then send the credit
          memo email with the QBO PDF attached.
        </p>
      </CardHeader>
      <CardBody>
        {isCompleted ? (
          <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            <Check className="size-4 shrink-0" />
            Credit memo issued.
          </div>
        ) : (
          <Button type="button" onClick={onOpen}>
            Open credit memo dialog
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusLabel(status: RmaSummary["status"]): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "approved":
      return "Approved";
    case "completed":
      return "Completed";
    case "denied":
      return "Denied";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function statusTone(
  status: RmaSummary["status"],
): "neutral" | "info" | "success" | "high" | "critical" {
  switch (status) {
    case "draft":
      return "neutral";
    case "approved":
      return "info";
    case "completed":
      return "success";
    case "denied":
    case "cancelled":
      return "critical";
    default:
      return "neutral";
  }
}
