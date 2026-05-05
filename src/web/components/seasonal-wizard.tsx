// SeasonalWizard — multi-step wizard for seasonal + non-seasonal RMAs.
//
// The wizard maps 1:1 to the state machine in src/modules/returns/rma-state.ts.
// Each step is gated on prerequisites being met AND the underlying RMA being
// in the right status:
//
//   1. Pick season            (no rmaId yet OR rma.status === draft)
//   2. Items                  (no rmaId yet OR rma.status === draft)
//   3. Review eligibility     (no rmaId yet OR rma.status === draft)
//   4. Approve / Deny         (no rmaId yet OR rma.status === draft)
//   5. Generate Extensiv file (rma.status === approved)
//   6. Paste warehouse tx#    (rma.status === awaiting_warehouse_number)
//   7. Send approval email    (rma.status === sent_to_warehouse, fires once)
//
// Approve/Deny in step 4 is the gate that creates the RMA in the backend if
// it doesn't exist yet. After step 7 the wizard hands off to the detail page
// for the warehouse-receive → CM flow.
//
// Damage RMAs do NOT use this wizard — they use the existing single-page form.

import {
  useCallback,
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
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Mail,
  Sparkles,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Select } from "./ui/select";
import { cn } from "../lib/cn";
import RmaItemsTable, {
  type RmaItemRow,
  makeEmptyRow,
} from "./rma-items-table";
import EligibilityCard from "./eligibility-card";
import ParseEmailSection, { type ParsedItem } from "./parse-email-section";
import RmaApprovalEmailDialog from "./rma-approval-email-dialog";
import RmaDenialEmailDialog from "./rma-denial-email-dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeasonalWizardCustomer = {
  id: string;
  qbCustomerId: string;
  displayName: string;
};

export type SeasonalWizardProps = {
  customer: SeasonalWizardCustomer;
  returnType: "seasonal" | "non_seasonal";
  /** Existing RMA id when resuming an in-progress wizard. Null for new RMAs. */
  initialRmaId?: string | null;
  /** Called when the wizard completes (approval email sent). */
  onCompleted?: (rmaId: string) => void;
};

type Season = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
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
  seasonId: string | null;
  qbCustomerId: string | null;
  thresholdOverridden: boolean;
  denialPdfDriveId: string | null;
  items: RmaItemRow[];
};

const STEPS = [
  { id: 1, label: "Season" },
  { id: 2, label: "Items" },
  { id: 3, label: "Eligibility" },
  { id: 4, label: "Approve" },
  { id: 5, label: "Warehouse export" },
  { id: 6, label: "Warehouse number" },
  { id: 7, label: "Approval email" },
] as const;

const CLASSIFICATION_OPTIONS_SEASONAL = [
  { value: "seasonal_current", label: "Current season" },
  { value: "seasonal_prior", label: "Prior season" },
  { value: "non_seasonal", label: "Non-seasonal (tag-along)" },
];
const CLASSIFICATION_OPTIONS_NON_SEASONAL = [
  { value: "non_seasonal", label: "Non-seasonal" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SeasonalWizard({
  customer,
  returnType,
  initialRmaId = null,
  onCompleted,
}: SeasonalWizardProps) {
  const queryClient = useQueryClient();

  const [rmaId, setRmaId] = useState<string | null>(initialRmaId);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [items, setItems] = useState<RmaItemRow[]>([]);
  const [itemClassifications, setItemClassifications] = useState<
    Record<string, string>
  >({});
  const [notes, setNotes] = useState("");
  const [override, setOverride] = useState({ enabled: false, reason: "" });
  const [stepIndex, setStepIndex] = useState(0); // 0-based; step 1 = STEPS[0]

  // Dialog state for approval / denial email send (steps 4 + 7)
  const [denialDialogOpen, setDenialDialogOpen] = useState(false);
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);

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

  // ---- Auto-advance step when RMA status changes ──────────────────────────
  useEffect(() => {
    if (!rma) return;
    const targetStep = stepForStatus(rma.status);
    if (targetStep > stepIndex + 1) {
      setStepIndex(targetStep - 1);
    }
  }, [rma?.status, stepIndex, rma]);

  // ---- Hydrate from RMA when resuming ─────────────────────────────────────
  useEffect(() => {
    if (!rma) return;
    if (rma.seasonId && !seasonId) setSeasonId(rma.seasonId);
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
  }, [rma, seasonId, items.length]);

  // ---- Seasons list ───────────────────────────────────────────────────────
  const seasonsQuery = useQuery<{ seasons: Season[] }>({
    queryKey: ["seasons", { active: true }],
    queryFn: async () => {
      const res = await fetch("/api/seasons?active=true");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  const seasons = seasonsQuery.data?.seasons ?? [];

  // ---- Mutations ──────────────────────────────────────────────────────────
  const createRmaMutation = useMutation<{ id: string; status: string }, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/rmas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: customer.id,
          qbCustomerId: customer.qbCustomerId,
          returnType,
          seasonId,
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

  const addItemsMutation = useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      // Persist all items in parallel.
      await Promise.all(
        items
          .filter((it) => it.qbItemId && !it.id)
          .map(async (it) => {
            const cls =
              itemClassifications[it.localKey] ??
              defaultClassification(returnType);
            const res = await fetch(`/api/rmas/${id}/items`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                qbItemId: it.qbItemId,
                sku: it.sku,
                name: it.name,
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                classification: cls,
                listUnitPrice: it.listUnitPrice ?? null,
                invoiceDiscountPct: it.invoiceDiscountPct ?? null,
                reason: it.reason || null,
                originalInvoiceDocNumber:
                  it.originalInvoiceDocNumber ?? null,
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
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rma-wizard", rmaId] });
    },
  });

  const approveMutation = useMutation<RmaSummary, Error>({
    mutationFn: async () => {
      // Ensure RMA exists
      let id = rmaId;
      if (!id) {
        const created = await createRmaMutation.mutateAsync();
        id = created.id;
      }
      // Persist items if any aren't yet on the backend
      await addItemsMutation.mutateAsync(id);

      // Run approve
      const body: Record<string, unknown> = {};
      if (override.enabled) {
        body.overrideThreshold = true;
        body.overrideReason = override.reason;
      }
      const res = await fetch(`/api/rmas/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
      setStepIndex(4); // step 5 (warehouse export)
    },
  });

  const generateExportMutation = useMutation<
    { rma: RmaSummary; exportFile: { filename: string; content: string } },
    Error
  >({
    mutationFn: async () => {
      if (!rmaId) throw new Error("RMA missing");
      const res = await fetch(
        `/api/rmas/${rmaId}/generate-warehouse-export`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: ({ exportFile }) => {
      // Trigger browser download
      const bytes = Uint8Array.from(atob(exportFile.content), (c) =>
        c.charCodeAt(0),
      );
      const blob = new Blob([bytes], { type: "text/tab-separated-values" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFile.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      void queryClient.invalidateQueries({ queryKey: ["rma-wizard", rmaId] });
      setStepIndex(5); // step 6 (paste tx#)
    },
  });

  const setWarehouseNumberMutation = useMutation<
    { rma: RmaSummary; emailDialogPayload: { pdfDriveId: string | null } },
    Error,
    string
  >({
    mutationFn: async (txNumber) => {
      if (!rmaId) throw new Error("RMA missing");
      const res = await fetch(`/api/rmas/${rmaId}/set-warehouse-number`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txNumber }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rma-wizard", rmaId] });
      setStepIndex(6); // step 7 (approval email)
      setApprovalDialogOpen(true);
    },
  });

  // ---- Step prerequisites + navigation ────────────────────────────────────
  const stepEnabled = (idx: number): boolean => {
    if (idx <= stepIndex) return true; // already visited
    if (idx === 1) return !!seasonId; // step 2 needs season
    if (idx === 2) return !!seasonId && items.some((it) => it.qbItemId); // step 3 needs items
    if (idx === 3) return !!seasonId && items.some((it) => it.qbItemId); // step 4 needs items + season
    return false;
  };

  // ---- Step renderers ─────────────────────────────────────────────────────
  let stepContent: ReactNode;
  switch (stepIndex) {
    case 0:
      stepContent = (
        <StepSeason
          seasons={seasons}
          loading={seasonsQuery.isPending}
          required={returnType === "seasonal"}
          seasonId={seasonId}
          onSeasonChange={setSeasonId}
          onNext={() => setStepIndex(1)}
        />
      );
      break;

    case 1:
      stepContent = (
        <StepItems
          rmaId={rmaId}
          qbCustomerId={customer.qbCustomerId}
          items={items}
          onItemsChange={setItems}
          itemClassifications={itemClassifications}
          onClassificationChange={(localKey, classification) =>
            setItemClassifications((prev) => ({
              ...prev,
              [localKey]: classification,
            }))
          }
          returnType={returnType}
          notes={notes}
          onNotesChange={setNotes}
          onPrev={() => setStepIndex(0)}
          onNext={() => setStepIndex(2)}
        />
      );
      break;

    case 2:
      stepContent = (
        <StepEligibility
          rmaId={rmaId}
          customerId={customer.id}
          qbCustomerId={customer.qbCustomerId}
          seasonId={seasonId}
          items={items}
          itemClassifications={itemClassifications}
          override={override}
          onOverrideChange={setOverride}
          informationalOnly={returnType === "non_seasonal"}
          onPrev={() => setStepIndex(1)}
          onNext={() => setStepIndex(3)}
        />
      );
      break;

    case 3:
      stepContent = (
        <StepApprove
          override={override}
          isPending={approveMutation.isPending || createRmaMutation.isPending}
          error={approveMutation.error || createRmaMutation.error}
          onApprove={() => approveMutation.mutate()}
          onDeny={async () => {
            // Ensure RMA exists before opening denial dialog (denial requires
            // an rmaId).
            if (!rmaId) {
              await createRmaMutation.mutateAsync();
            }
            setDenialDialogOpen(true);
          }}
          onPrev={() => setStepIndex(2)}
        />
      );
      break;

    case 4:
      stepContent = (
        <StepWarehouseExport
          rma={rma}
          isPending={generateExportMutation.isPending}
          error={generateExportMutation.error}
          onGenerate={() => generateExportMutation.mutate()}
          onPrev={() => setStepIndex(3)}
        />
      );
      break;

    case 5:
      stepContent = (
        <StepWarehouseNumber
          rma={rma}
          isPending={setWarehouseNumberMutation.isPending}
          error={setWarehouseNumberMutation.error}
          onSubmit={(txNumber) =>
            setWarehouseNumberMutation.mutate(txNumber)
          }
          onPrev={() => setStepIndex(4)}
          onCancelExport={async () => {
            if (!rmaId) return;
            await fetch(`/api/rmas/${rmaId}/cancel-warehouse-export`, {
              method: "POST",
            });
            await queryClient.invalidateQueries({
              queryKey: ["rma-wizard", rmaId],
            });
            setStepIndex(4);
          }}
        />
      );
      break;

    case 6:
      stepContent = (
        <StepApprovalEmail
          rma={rma}
          onCompleted={() => {
            if (rmaId) onCompleted?.(rmaId);
          }}
        />
      );
      break;

    default:
      stepContent = null;
  }

  return (
    <div className="space-y-4">
      {/* Stepper */}
      <Stepper
        steps={STEPS}
        active={stepIndex}
        stepEnabled={stepEnabled}
        onJump={setStepIndex}
      />

      {/* RMA status badge + cancel/delete actions */}
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
            {rma.thresholdOverridden && (
              <Badge tone="medium">Override applied</Badge>
            )}
          </div>
          <RmaLifecycleActions
            rmaId={rma.id}
            status={rma.status}
            onChanged={() => {
              void queryClient.invalidateQueries({
                queryKey: ["rma-wizard", rmaId],
              });
            }}
          />
        </div>
      )}

      {/* Step content */}
      <div>{stepContent}</div>

      {/* Approval email dialog (auto-opens at step 7) */}
      {rmaId && rma && (
        <RmaApprovalEmailDialog
          open={approvalDialogOpen}
          onOpenChange={setApprovalDialogOpen}
          rmaId={rmaId}
          rmaNumber={rma.rmaNumber ?? rmaId}
          customerId={customer.id}
          pdfDriveId={
            rma.thresholdOverridden ? rma.denialPdfDriveId : null
          }
          onSent={() => {
            setApprovalDialogOpen(false);
            if (rmaId) onCompleted?.(rmaId);
          }}
        />
      )}

      {/* Denial dialog — needs an existing rmaId; ensure created first */}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper UI
// ---------------------------------------------------------------------------

function Stepper({
  steps,
  active,
  stepEnabled,
  onJump,
}: {
  steps: readonly { id: number; label: string }[];
  active: number;
  stepEnabled: (idx: number) => boolean;
  onJump: (idx: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {steps.map((s, idx) => {
        const isActive = idx === active;
        const isPast = idx < active;
        const isEnabled = stepEnabled(idx);
        return (
          <li key={s.id}>
            <button
              type="button"
              disabled={!isEnabled && !isPast && !isActive}
              onClick={() => {
                if (isEnabled || isPast || isActive) onJump(idx);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 transition-colors",
                isActive
                  ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                  : isPast
                    ? "border-default bg-elevated text-secondary hover:bg-elevated/80"
                    : isEnabled
                      ? "border-default text-muted hover:bg-elevated/50"
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
                {isPast ? <Check className="size-3" /> : s.id}
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
// Step 1: Season picker
// ---------------------------------------------------------------------------

function StepSeason({
  seasons,
  loading,
  required,
  seasonId,
  onSeasonChange,
  onNext,
}: {
  seasons: Season[];
  loading: boolean;
  required: boolean;
  seasonId: string | null;
  onSeasonChange: (id: string | null) => void;
  onNext: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">1. Pick a season</h2>
        <p className="mt-1 text-xs text-muted">
          {required
            ? "Required — eligibility math is computed against this season's purchases."
            : "Optional — for non-seasonal returns the season just associates the RMA with a date window for reporting."}
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        {loading ? (
          <div className="text-sm text-muted">Loading seasons…</div>
        ) : (
          <Select
            value={seasonId ?? ""}
            onChange={(e) => onSeasonChange(e.target.value || null)}
          >
            <option value="">— none —</option>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({formatDate(s.startDate)} – {formatDate(s.endDate)})
              </option>
            ))}
          </Select>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            disabled={required && !seasonId}
            onClick={onNext}
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Items
// ---------------------------------------------------------------------------

function StepItems({
  rmaId,
  qbCustomerId,
  items,
  onItemsChange,
  itemClassifications,
  onClassificationChange,
  returnType,
  notes,
  onNotesChange,
  onPrev,
  onNext,
}: {
  rmaId: string | null;
  qbCustomerId: string | null;
  items: RmaItemRow[];
  onItemsChange: (next: RmaItemRow[]) => void;
  itemClassifications: Record<string, string>;
  onClassificationChange: (localKey: string, classification: string) => void;
  returnType: "seasonal" | "non_seasonal";
  notes: string;
  onNotesChange: (next: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const classOpts =
    returnType === "seasonal"
      ? CLASSIFICATION_OPTIONS_SEASONAL
      : CLASSIFICATION_OPTIONS_NON_SEASONAL;

  function appendParsedItems(parsed: ParsedItem[]): void {
    const newRows: RmaItemRow[] = parsed.map((p) => ({
      ...makeEmptyRow(),
      qbItemId: "",
      sku: p.sku ?? "",
      name: p.name ?? "",
      quantity: p.quantity > 0 ? String(p.quantity) : "1",
      reason: p.reason ?? "",
    }));
    for (const row of newRows) {
      onClassificationChange(row.localKey, defaultClassification(returnType));
    }
    onItemsChange([...items, ...newRows]);
  }

  const hasResolvedItems = items.some((it) => it.qbItemId);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">2. Items</h2>
          <p className="mt-1 text-xs text-muted">
            Paste the customer's email to auto-extract items, then resolve them
            against QBO with one click.
          </p>
        </CardHeader>
      </Card>

      <ParseEmailSection onItemsParsed={appendParsedItems} />

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

          {/* Per-item classification — only seasonal RMAs need this UI */}
          {returnType === "seasonal" &&
            items.some((it) => it.qbItemId) && (
              <div className="space-y-1.5 rounded-md border border-default bg-elevated/30 px-3 py-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Item classifications
                </div>
                {items
                  .filter((it) => it.qbItemId)
                  .map((it) => (
                    <div
                      key={it.localKey}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="flex-1 truncate">
                        {it.name || it.sku}
                      </span>
                      <Select
                        className="w-44"
                        value={
                          itemClassifications[it.localKey] ??
                          defaultClassification(returnType)
                        }
                        onChange={(e) =>
                          onClassificationChange(it.localKey, e.target.value)
                        }
                      >
                        {classOpts.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ))}
              </div>
            )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Notes (internal)</h3>
        </CardHeader>
        <CardBody>
          <textarea
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Any context on this return — visible to operators only."
            rows={3}
            className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
          />
        </CardBody>
      </Card>

      <div className="flex justify-between">
        <Button type="button" variant="secondary" onClick={onPrev}>
          <ChevronLeft className="size-4" />
          Back
        </Button>
        <Button type="button" disabled={!hasResolvedItems} onClick={onNext}>
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Eligibility
// ---------------------------------------------------------------------------

function StepEligibility({
  rmaId,
  customerId,
  qbCustomerId,
  seasonId,
  items,
  itemClassifications,
  override,
  onOverrideChange,
  informationalOnly,
  onPrev,
  onNext,
}: {
  rmaId: string | null;
  customerId: string;
  qbCustomerId: string | null;
  seasonId: string | null;
  items: RmaItemRow[];
  itemClassifications: Record<string, string>;
  override: { enabled: boolean; reason: string };
  onOverrideChange: (next: { enabled: boolean; reason: string }) => void;
  informationalOnly: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  // override prop only used for the next-button gate below; eligibility card
  // owns the override toggle and emits changes via onOverrideChange.
  void override;
  const cardItems = useMemo(
    () =>
      items
        .filter((it) => it.qbItemId)
        .map((it) => ({
          classification:
            itemClassifications[it.localKey] ??
            (informationalOnly ? "non_seasonal" : "seasonal_current"),
          lineTotal: it.lineTotal,
        })),
    [items, itemClassifications, informationalOnly],
  );

  const handleOverrideChange = useCallback(
    (next: { enabled: boolean; reason: string }) => onOverrideChange(next),
    [onOverrideChange],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">3. Eligibility</h2>
          <p className="mt-1 text-xs text-muted">
            Live cumulative breakdown. PDF preview shows the report attached to
            the denial email if you deny.
          </p>
        </CardHeader>
      </Card>

      {seasonId && cardItems.length > 0 ? (
        <>
          <EligibilityCard
            rmaId={rmaId}
            customerId={customerId}
            qbCustomerId={qbCustomerId}
            seasonId={seasonId}
            items={cardItems}
            onOverrideChange={handleOverrideChange}
            informationalOnly={informationalOnly}
          />
          <PdfPreviewButton
            rmaId={rmaId}
            customerId={customerId}
            qbCustomerId={qbCustomerId}
            seasonId={seasonId}
            items={items}
            itemClassifications={itemClassifications}
            informationalOnly={informationalOnly}
          />
        </>
      ) : (
        <Card>
          <CardBody>
            <div className="flex items-center gap-2 text-sm text-accent-warning">
              <AlertTriangle className="size-4" />
              {!seasonId
                ? "Select a season in step 1 to compute eligibility."
                : "Resolve items to QBO matches in step 2."}
            </div>
          </CardBody>
        </Card>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="secondary" onClick={onPrev}>
          <ChevronLeft className="size-4" />
          Back
        </Button>
        <Button
          type="button"
          disabled={override.enabled && !override.reason.trim()}
          onClick={onNext}
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PDF preview button — works with or without an rmaId
// ---------------------------------------------------------------------------

function PdfPreviewButton({
  rmaId,
  customerId,
  qbCustomerId,
  seasonId,
  items,
  itemClassifications,
  informationalOnly,
}: {
  rmaId: string | null;
  customerId: string;
  qbCustomerId: string | null;
  seasonId: string | null;
  items: RmaItemRow[];
  itemClassifications: Record<string, string>;
  informationalOnly: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function preview(): Promise<void> {
    if (rmaId) {
      window.open(`/api/rmas/${rmaId}/eligibility-pdf`, "_blank");
      return;
    }
    if (!qbCustomerId || !seasonId) {
      setError("Customer or season missing");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const payloadItems = items
        .filter((it) => it.qbItemId)
        .map((it) => ({
          sku: it.sku,
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          lineTotal: it.lineTotal,
          classification:
            itemClassifications[it.localKey] ??
            (informationalOnly ? "non_seasonal" : "seasonal_current"),
          priorSeasonId: null,
        }));
      const res = await fetch("/api/rmas/qbo-eligibility-pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId,
          qbCustomerId,
          seasonId,
          items: payloadItems,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      // Don't revoke immediately — the new tab needs the URL to load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview PDF");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <button
        type="button"
        onClick={() => void preview()}
        disabled={pending}
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-default bg-base px-2 py-1 text-accent-primary hover:bg-elevated disabled:opacity-50"
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <FileText className="size-3.5" />
        )}
        {pending ? "Generating…" : "Preview eligibility report (PDF)"}
      </button>
      <span className="ml-0.5">
        Same report attached to the denial email if you deny.
      </span>
      {error && (
        <span className="text-accent-danger">
          <AlertCircle className="mr-1 inline size-3" />
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Approve / Deny
// ---------------------------------------------------------------------------

function StepApprove({
  override,
  isPending,
  error,
  onApprove,
  onDeny,
  onPrev,
}: {
  override: { enabled: boolean; reason: string };
  isPending: boolean;
  error: Error | null;
  onApprove: () => void;
  onDeny: () => void;
  onPrev: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">4. Approve or deny</h2>
        <p className="mt-1 text-xs text-muted">
          {override.enabled
            ? "Override is set — approving here records the override + reason and proceeds to the warehouse step."
            : "Approving here records the eligibility decision and proceeds to the warehouse step. The customer is NOT yet emailed."}
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        {override.enabled && (
          <div className="rounded-md border border-accent-warning/30 bg-accent-warning/5 px-3 py-2 text-xs">
            <div className="font-semibold text-accent-warning">
              Override pending
            </div>
            <div className="mt-1 text-muted">{override.reason}</div>
          </div>
        )}

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
// Step 5: Generate Extensiv export
// ---------------------------------------------------------------------------

function StepWarehouseExport({
  rma,
  isPending,
  error,
  onGenerate,
  onPrev,
}: {
  rma: RmaSummary | null;
  isPending: boolean;
  error: Error | null;
  onGenerate: () => void;
  onPrev: () => void;
}) {
  const alreadyGenerated = rma?.status === "awaiting_warehouse_number";

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">
          5. Generate the Extensiv warehouse file
        </h2>
        <p className="mt-1 text-xs text-muted">
          Click below to download the tab-delimited file. Then upload it to
          Extensiv to receive a transaction number — that number IS the RMA
          number you'll give the customer.
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error.message}
          </div>
        )}

        {alreadyGenerated && (
          <div className="rounded-md bg-success/10 border border-success/30 px-3 py-2 text-xs text-success">
            Export generated. Upload to Extensiv, then proceed to step 6.
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={onPrev}>
            <ChevronLeft className="size-4" />
            Back
          </Button>
          <Button type="button" onClick={onGenerate} disabled={isPending}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            <Download className="size-4" />
            {alreadyGenerated
              ? "Re-download Extensiv file"
              : "Generate + download Extensiv file"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Paste warehouse tx#
// ---------------------------------------------------------------------------

function StepWarehouseNumber({
  rma,
  isPending,
  error,
  onSubmit,
  onPrev,
  onCancelExport,
}: {
  rma: RmaSummary | null;
  isPending: boolean;
  error: Error | null;
  onSubmit: (txNumber: string) => void;
  onPrev: () => void;
  onCancelExport: () => void;
}) {
  const [tx, setTx] = useState("");

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">6. Paste the warehouse number</h2>
        <p className="mt-1 text-xs text-muted">
          Extensiv returns a transaction number after upload. Paste it here —
          it becomes the customer-facing RMA number, and the approval email
          fires as soon as you submit.
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error.message}
          </div>
        )}

        {rma?.status === "awaiting_warehouse_number" ? (
          <input
            type="text"
            value={tx}
            onChange={(e) => setTx(e.target.value)}
            placeholder="Extensiv transaction number…"
            className="w-full rounded-md border border-default bg-base px-3 py-2 text-sm"
          />
        ) : (
          <div className="text-xs text-muted">
            Generate the Extensiv file first (step 5).
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onPrev}>
              <ChevronLeft className="size-4" />
              Back
            </Button>
            {rma?.status === "awaiting_warehouse_number" && (
              <Button
                type="button"
                variant="secondary"
                onClick={onCancelExport}
              >
                Cancel export
              </Button>
            )}
          </div>
          <Button
            type="button"
            disabled={!tx.trim() || isPending}
            onClick={() => onSubmit(tx.trim())}
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Submit + send approval email →
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 7: Approval email (just a success summary — dialog auto-opened)
// ---------------------------------------------------------------------------

function StepApprovalEmail({
  rma,
  onCompleted,
}: {
  rma: RmaSummary | null;
  onCompleted: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">7. Approval email</h2>
        <p className="mt-1 text-xs text-muted">
          The dialog opened automatically. Review the rendered subject + body
          and click Send. The customer will see this RMA number:{" "}
          <span className="font-mono font-medium text-primary">
            {rma?.rmaNumber ?? "—"}
          </span>
        </p>
      </CardHeader>
      <CardBody>
        <div className="flex items-center gap-2 rounded-md bg-success/10 border border-success/30 px-3 py-2 text-sm text-success">
          <CheckCircle2 className="size-4" />
          RMA is at warehouse. Once the warehouse confirms receipt, you'll
          process the credit memo from the RMA's detail page.
        </div>
        <div className="mt-3 flex justify-end">
          <Button type="button" variant="secondary" onClick={onCompleted}>
            Done
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cancel / Delete actions
// ---------------------------------------------------------------------------

function RmaLifecycleActions({
  rmaId,
  status,
  onChanged,
}: {
  rmaId: string;
  status: RmaSummary["status"];
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState<null | "cancel" | "delete">(
    null,
  );
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCancel =
    status === "approved" ||
    status === "awaiting_warehouse_number" ||
    status === "sent_to_warehouse";
  const canDelete = status === "draft" || status === "cancelled";

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
      setConfirmOpen(null);
      // Hard navigation back to the list since the RMA no longer exists.
      window.location.href = "/returns";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setPending(false);
    }
  }

  if (!canCancel && !canDelete) return null;

  return (
    <>
      <div className="flex gap-1.5">
        {canCancel && (
          <button
            type="button"
            onClick={() => {
              setConfirmOpen("cancel");
              setError(null);
            }}
            className="rounded border border-default bg-base px-2 py-1 text-[11px] text-secondary hover:bg-elevated"
          >
            Cancel RMA
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => {
              setConfirmOpen("delete");
              setError(null);
            }}
            className="rounded border border-accent-danger/40 bg-accent-danger/5 px-2 py-1 text-[11px] text-accent-danger hover:bg-accent-danger/10"
          >
            Delete
          </button>
        )}
      </div>

      {confirmOpen === "cancel" && (
        <div className="mt-2 w-full rounded-md border border-default bg-base p-3">
          <div className="text-sm font-medium">Cancel this RMA?</div>
          <div className="mt-1 text-xs text-muted">
            The RMA stays in your records (audit trail) but no further action
            can be taken. Cancellation reason is optional.
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            rows={2}
            className="mt-2 w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
          />
          {error && (
            <div className="mt-2 text-xs text-accent-danger">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmOpen(null)}
              disabled={pending}
              className="rounded border border-default bg-base px-3 py-1 text-xs text-secondary hover:bg-elevated"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void runCancel()}
              disabled={pending}
              className="rounded bg-accent-warning px-3 py-1 text-xs text-white hover:bg-accent-warning/90 disabled:opacity-50"
            >
              {pending ? "Cancelling…" : "Confirm cancel"}
            </button>
          </div>
        </div>
      )}

      {confirmOpen === "delete" && (
        <div className="mt-2 w-full rounded-md border border-accent-danger/40 bg-accent-danger/5 p-3">
          <div className="text-sm font-medium text-accent-danger">
            Delete this RMA permanently?
          </div>
          <div className="mt-1 text-xs text-muted">
            This wipes the RMA + its items from the database. Photos in Drive
            are not deleted. This is only allowed for draft or cancelled RMAs.
          </div>
          {error && (
            <div className="mt-2 text-xs text-accent-danger">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmOpen(null)}
              disabled={pending}
              className="rounded border border-default bg-base px-3 py-1 text-xs text-secondary hover:bg-elevated"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void runDelete()}
              disabled={pending}
              className="rounded bg-accent-danger px-3 py-1 text-xs text-white hover:bg-accent-danger/90 disabled:opacity-50"
            >
              {pending ? "Deleting…" : "Yes, delete"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultClassification(
  returnType: "seasonal" | "non_seasonal",
): string {
  return returnType === "seasonal" ? "seasonal_current" : "non_seasonal";
}

function stepForStatus(status: RmaSummary["status"]): number {
  switch (status) {
    case "draft":
      return 4; // step 4 — operator hasn't approved yet
    case "approved":
      return 5; // step 5 — generate export
    case "awaiting_warehouse_number":
      return 6; // step 6 — paste tx#
    case "sent_to_warehouse":
    case "received":
    case "completed":
      return 7; // step 7 — email already sent
    case "denied":
    case "cancelled":
      return 1; // back to start; this RMA path is done
    default:
      return 1;
  }
}

function statusLabel(status: RmaSummary["status"]): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "approved":
      return "Approved";
    case "awaiting_warehouse_number":
      return "Awaiting warehouse #";
    case "sent_to_warehouse":
      return "At warehouse";
    case "received":
      return "Received";
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
):
  | "neutral"
  | "success"
  | "info"
  | "high"
  | "medium"
  | "critical" {
  switch (status) {
    case "draft":
      return "neutral";
    case "approved":
    case "completed":
      return "success";
    case "awaiting_warehouse_number":
      return "high";
    case "sent_to_warehouse":
    case "received":
      return "info";
    case "denied":
      return "critical";
    case "cancelled":
      return "medium";
    default:
      return "neutral";
  }
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  let d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) {
    d = new Date(`${dateStr}T00:00:00`);
  }
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
