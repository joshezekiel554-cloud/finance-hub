// /returns/new — create a new RMA (damage, seasonal, or non-seasonal).
// Pre-fills the customer when ?customerId=... is in the URL (launched
// from a customer profile). Otherwise shows a customer picker.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import ReturnCreateFormDamage, {
  type DamageFormState,
} from "../components/return-create-form-damage";
import ReturnCreateFormSeasonal, {
  type SeasonalFormState,
} from "../components/return-create-form-seasonal";
import RmaApprovalEmailDialog from "../components/rma-approval-email-dialog";
import RmaDenialEmailDialog from "../components/rma-denial-email-dialog";
import { makeEmptyRow } from "../components/rma-items-table";
import { PhotoUploadZone } from "../components/photo-upload-zone";

// Shape returned by GET /api/customers?q=...
type CustomerHit = {
  id: string;
  qbCustomerId: string | null;
  displayName: string;
  primaryEmail: string | null;
};
type CustomersResponse = { customers: CustomerHit[] };

// Shape returned by GET /api/customers/:id
type CustomerDetail = {
  id: string;
  qbCustomerId: string | null;
  displayName: string;
  primaryEmail: string | null;
};

// Shape returned by POST /api/rmas
type RmaCreated = {
  id: string;
  customerId: string;
  returnType: string;
  status: string;
};

// Shape returned by POST /api/rmas/:id/approve
type ApproveResult = {
  id: string;
  rmaNumber: string | null;
  status: string;
  customerId: string;
};

type RmaReturnType = "damage" | "seasonal" | "non_seasonal";

const RETURN_TYPE_LABELS: Record<RmaReturnType, string> = {
  damage: "Damage",
  seasonal: "Seasonal",
  non_seasonal: "Non-seasonal",
};

export default function ReturnNewPage() {
  const navigate = useNavigate();

  // TanStack Router v1 search params — read customerId from the query string
  const search = useSearch({ strict: false }) as { customerId?: string };
  const prefilledCustomerId = search.customerId ?? null;

  // Return type selection
  const [returnType, setReturnType] = useState<RmaReturnType>("damage");

  // Customer selection state
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerHit | null>(null);
  const [customerPickerQuery, setCustomerPickerQuery] = useState("");
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [customerPickerLoading, setCustomerPickerLoading] = useState(false);
  const [customerPickerResults, setCustomerPickerResults] = useState<
    CustomerHit[]
  >([]);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch pre-filled customer when customerId is in URL
  const prefillQuery = useQuery<CustomerDetail>({
    enabled: !!prefilledCustomerId && !selectedCustomer,
    queryKey: ["customer", prefilledCustomerId],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(prefilledCustomerId!)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { customer: CustomerDetail };
      return body.customer;
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (prefillQuery.data && !selectedCustomer) {
      setSelectedCustomer(prefillQuery.data);
    }
  }, [prefillQuery.data, selectedCustomer]);

  // Customer search debounce
  useEffect(() => {
    if (selectedCustomer) return;
    const trimmed = customerPickerQuery.trim();
    if (trimmed.length < 2) {
      setCustomerPickerResults([]);
      return;
    }
    if (pickTimer.current) clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(async () => {
      setCustomerPickerLoading(true);
      try {
        const res = await fetch(
          `/api/customers?q=${encodeURIComponent(trimmed)}&customerType=all&limit=20`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as CustomersResponse;
        setCustomerPickerResults(body.customers);
        setCustomerPickerOpen(true);
      } finally {
        setCustomerPickerLoading(false);
      }
    }, 250);
    return () => {
      if (pickTimer.current) clearTimeout(pickTimer.current);
    };
  }, [customerPickerQuery, selectedCustomer]);

  // RMA draft state
  const [rmaId, setRmaId] = useState<string | null>(null);

  // Damage form state
  const defaultFormState: DamageFormState = {
    items: [makeEmptyRow()],
    photosUrl: "",
    notes: "",
    resolutionType: "credit",
  };
  const [formState, setFormState] = useState<DamageFormState>(defaultFormState);

  // Seasonal / non-seasonal form state
  const defaultSeasonalState: SeasonalFormState = {
    items: [makeEmptyRow()],
    itemClassifications: {},
    seasonId: null,
    photosUrl: "",
    notes: "",
    overrideThreshold: false,
    overrideReason: "",
  };
  const [seasonalFormState, setSeasonalFormState] =
    useState<SeasonalFormState>(defaultSeasonalState);

  // Create RMA draft mutation (fires on first meaningful interaction if
  // rmaId not yet set, and also on Save Draft click)
  const createMutation = useMutation<RmaCreated, Error, void>({
    mutationFn: async () => {
      if (!selectedCustomer?.id || !selectedCustomer.qbCustomerId) {
        throw new Error("Select a customer first");
      }
      const notes =
        returnType === "damage" ? formState.notes : seasonalFormState.notes;
      // seasonId is only relevant for seasonal/non_seasonal RMAs; damage
      // RMAs leave it null.
      const seasonId =
        returnType === "damage" ? null : seasonalFormState.seasonId;
      const res = await fetch("/api/rmas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: selectedCustomer.id,
          qbCustomerId: selectedCustomer.qbCustomerId,
          returnType,
          notes: notes || null,
          seasonId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setRmaId(data.id);
    },
  });

  // Patch RMA (notes / resolutionType) — only when rmaId exists
  const patchMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      if (!rmaId) return;
      const res = await fetch(`/api/rmas/${rmaId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notes: formState.notes || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
  });

  async function handleSaveDraft() {
    if (!rmaId) {
      await createMutation.mutateAsync();
    } else {
      await patchMutation.mutateAsync();
    }
  }

  // Approval dialog state
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [approvedRma, setApprovedRma] = useState<ApproveResult | null>(null);

  // Denial dialog state
  const [denialDialogOpen, setDenialDialogOpen] = useState(false);

  // Approve flow:
  // 1. If no rmaId, create the RMA first
  // 2. Call POST /api/rmas/:id/approve (with override context for seasonal)
  // 3. Open approval email dialog
  const approveMutation = useMutation<
    ApproveResult,
    Error,
    { overrideThreshold?: boolean; overrideReason?: string }
  >({
    mutationFn: async ({ overrideThreshold, overrideReason }) => {
      let id = rmaId;
      if (!id) {
        const created = await createMutation.mutateAsync();
        id = created.id;
      }
      const body: Record<string, unknown> = {};
      if (overrideThreshold) {
        body.overrideThreshold = true;
        body.overrideReason = overrideReason ?? "";
      }
      const res = await fetch(`/api/rmas/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const resBody = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(resBody.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setApprovedRma(data);
      setApprovalDialogOpen(true);
    },
  });

  function handleApprove() {
    approveMutation.mutate({});
  }

  function handleSeasonalApprove(override: { enabled: boolean; reason: string }) {
    approveMutation.mutate({
      overrideThreshold: override.enabled,
      overrideReason: override.reason,
    });
  }

  function handleDeny() {
    // Ensure RMA exists before opening denial dialog
    if (!rmaId) {
      createMutation.mutate();
      // The dialog open is deferred; we open it once rmaId is available
      // via a separate effect below
      setPendingDenyAfterCreate(true);
    } else {
      setDenialDialogOpen(true);
    }
  }

  const [pendingDenyAfterCreate, setPendingDenyAfterCreate] = useState(false);
  useEffect(() => {
    if (pendingDenyAfterCreate && rmaId && !createMutation.isPending) {
      setPendingDenyAfterCreate(false);
      setDenialDialogOpen(true);
    }
  }, [pendingDenyAfterCreate, rmaId, createMutation.isPending]);

  const isSaving =
    createMutation.isPending ||
    patchMutation.isPending ||
    approveMutation.isPending;

  const saveError =
    createMutation.error?.message ??
    patchMutation.error?.message ??
    approveMutation.error?.message ??
    null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate({ to: "/returns" })}
          className="inline-flex items-center gap-1 text-sm text-secondary hover:text-primary"
        >
          <ArrowLeft className="size-4" />
          Returns
        </button>
        <span className="text-muted">/</span>
        <h1 className="text-xl font-semibold">
          New return — {RETURN_TYPE_LABELS[returnType]}
        </h1>
      </div>

      {/* Customer selection */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Customer</h2>
        </CardHeader>
        <CardBody>
          {selectedCustomer ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{selectedCustomer.displayName}</div>
                {selectedCustomer.primaryEmail && (
                  <div className="mt-0.5 text-xs text-secondary">
                    {selectedCustomer.primaryEmail}
                  </div>
                )}
              </div>
              {!rmaId && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCustomer(null);
                    setCustomerPickerQuery("");
                  }}
                  className="text-xs text-muted hover:text-accent-danger"
                >
                  Change
                </button>
              )}
            </div>
          ) : prefillQuery.isPending ? (
            <div className="text-sm text-muted">Loading customer…</div>
          ) : prefillQuery.isError ? (
            <div className="flex items-center gap-1 text-sm text-accent-danger">
              <AlertCircle className="size-4 shrink-0" />
              Could not load customer — check the URL and try again.
            </div>
          ) : (
            <CustomerPicker
              query={customerPickerQuery}
              onQueryChange={setCustomerPickerQuery}
              open={customerPickerOpen}
              loading={customerPickerLoading}
              results={customerPickerResults}
              onPick={(c) => {
                setSelectedCustomer(c);
                setCustomerPickerOpen(false);
                setCustomerPickerQuery("");
              }}
              onClose={() => setCustomerPickerOpen(false)}
            />
          )}
        </CardBody>
      </Card>

      {/* Return type picker — locked once rmaId is set */}
      {selectedCustomer && !rmaId && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium">Return type</h2>
          </CardHeader>
          <CardBody>
            <div className="flex gap-4">
              {(["damage", "seasonal", "non_seasonal"] as RmaReturnType[]).map((type) => (
                <label key={type} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="returnType"
                    value={type}
                    checked={returnType === type}
                    onChange={() => setReturnType(type)}
                  />
                  <span className="text-sm">{RETURN_TYPE_LABELS[type]}</span>
                </label>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Damage form — shown once customer is selected */}
      {selectedCustomer && returnType === "damage" && (
        <>
          <ReturnCreateFormDamage
            rmaId={rmaId}
            qbCustomerId={selectedCustomer?.qbCustomerId ?? null}
            value={formState}
            onChange={setFormState}
            onApprove={handleApprove}
            onDeny={handleDeny}
            isSaving={isSaving}
            saveError={saveError}
          />

          <PhotoUploadZone rmaId={rmaId} />

          <div className="flex justify-start gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isSaving || !selectedCustomer}
              loading={isSaving}
              onClick={handleSaveDraft}
            >
              {rmaId ? "Save changes" : "Save draft"}
            </Button>
          </div>
        </>
      )}

      {/* Seasonal / non-seasonal form */}
      {selectedCustomer && (returnType === "seasonal" || returnType === "non_seasonal") && (
        <>
          <ReturnCreateFormSeasonal
            rmaId={rmaId}
            qbCustomerId={selectedCustomer?.qbCustomerId ?? null}
            returnType={returnType}
            value={seasonalFormState}
            onChange={setSeasonalFormState}
            onApprove={handleSeasonalApprove}
            onDeny={handleDeny}
            isSaving={isSaving}
            saveError={saveError}
          />

          <div className="flex justify-start gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isSaving || !selectedCustomer}
              loading={isSaving}
              onClick={handleSaveDraft}
            >
              {rmaId ? "Save changes" : "Save draft"}
            </Button>
          </div>
        </>
      )}

      {/* Approval email dialog */}
      {approvedRma && (
        <RmaApprovalEmailDialog
          open={approvalDialogOpen}
          onOpenChange={setApprovalDialogOpen}
          rmaId={approvedRma.id}
          rmaNumber={approvedRma.rmaNumber ?? approvedRma.id}
          customerId={approvedRma.customerId}
          onSent={() => {
            void navigate({ to: "/returns/$rmaId", params: { rmaId: approvedRma.id } });
          }}
        />
      )}

      {/* Denial email dialog */}
      {rmaId && (
        <RmaDenialEmailDialog
          open={denialDialogOpen}
          onOpenChange={setDenialDialogOpen}
          rmaId={rmaId}
          customerId={selectedCustomer?.id ?? ""}
          onSent={() => {
            void navigate({ to: "/returns/$rmaId", params: { rmaId: rmaId } });
          }}
        />
      )}
    </div>
  );
}

// ---- Customer picker -------------------------------------------------------

function CustomerPicker({
  query,
  onQueryChange,
  open,
  loading,
  results,
  onPick,
  onClose,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  open: boolean;
  loading: boolean;
  results: CustomerHit[];
  onPick: (c: CustomerHit) => void;
  onClose: () => void;
}) {
  return (
    <div className="relative">
      <input
        type="text"
        autoFocus
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search customer by name (min 2 chars)…"
        className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
      {open && query.trim().length >= 2 && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-default bg-base shadow-lg">
          {loading && (
            <div className="px-3 py-2 text-xs text-muted">Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">No matches.</div>
          )}
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c)}
              className="block w-full px-3 py-2 text-left hover:bg-elevated"
            >
              <div className="text-sm font-medium">{c.displayName}</div>
              {c.primaryEmail && (
                <div className="text-xs text-secondary">{c.primaryEmail}</div>
              )}
              {!c.qbCustomerId && (
                <div className="text-xs text-accent-warning">
                  No QBO customer ID — cannot create RMA
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
