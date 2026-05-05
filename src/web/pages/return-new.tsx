// /returns/new — create a new RMA (damage, seasonal, or non-seasonal).
// Pre-fills the customer when ?customerId=... is in the URL (launched
// from a customer profile). Otherwise shows a customer picker.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import SeasonalWizard from "../components/seasonal-wizard";
import DamageWizard from "../components/damage-wizard";

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

type RmaReturnType = "damage" | "seasonal" | "non_seasonal";

const RETURN_TYPE_LABELS: Record<RmaReturnType, string> = {
  damage: "Damage",
  seasonal: "Seasonal",
  non_seasonal: "Non-seasonal",
};

export default function ReturnNewPage() {
  const navigate = useNavigate();

  // TanStack Router v1 search params — read customerId + rmaId from query string.
  // rmaId is set when resuming/editing an existing RMA in the wizard.
  const search = useSearch({ strict: false }) as {
    customerId?: string;
    rmaId?: string;
  };
  const prefilledCustomerId = search.customerId ?? null;
  const resumeRmaId = search.rmaId ?? null;

  // When resuming an existing RMA, fetch it to know returnType + customerId
  // so we can preselect the right form/wizard.
  const resumeRmaQuery = useQuery<{
    id: string;
    customerId: string;
    qbCustomerId: string | null;
    returnType: RmaReturnType;
    status: string;
  }>({
    enabled: !!resumeRmaId,
    queryKey: ["rma-resume", resumeRmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${resumeRmaId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // Return type selection
  const [returnType, setReturnType] = useState<RmaReturnType>("damage");

  // When the resume-RMA arrives, hydrate returnType + selected customer.
  useEffect(() => {
    if (!resumeRmaQuery.data) return;
    setReturnType(resumeRmaQuery.data.returnType);
    if (!selectedCustomer) {
      setSelectedCustomer({
        id: resumeRmaQuery.data.customerId,
        qbCustomerId: resumeRmaQuery.data.qbCustomerId,
        displayName: "",
        primaryEmail: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeRmaQuery.data]);

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

  // Customer to fetch — either from ?customerId= or from the resumed RMA's customerId.
  const customerIdToFetch =
    prefilledCustomerId ?? resumeRmaQuery.data?.customerId ?? null;

  // Use a distinct query key — `["customer", id]` is owned by the customer
  // detail page and stores the full `{ customer, recentActivities }` shape;
  // unwrapping `.customer` here under the same key poisoned that page's cache
  // (causing intermittent "reading 'balance' of undefined" until refresh).
  const prefillQuery = useQuery<CustomerDetail>({
    enabled: !!customerIdToFetch,
    queryKey: ["customer-summary", customerIdToFetch],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerIdToFetch!)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { customer: CustomerDetail };
      return body.customer;
    },
    staleTime: 60_000,
  });

  // When the customer detail arrives, replace the placeholder customer with the
  // real one (or set it if not yet picked). Always overwrite when resuming so
  // the empty-displayName placeholder is replaced.
  useEffect(() => {
    if (!prefillQuery.data) return;
    if (!selectedCustomer || !selectedCustomer.displayName) {
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

  // RMA draft state. When the page is opened with ?rmaId= we seed this from
  // the URL so the form/wizard treats the existing RMA as the working draft.
  const [rmaId, setRmaId] = useState<string | null>(resumeRmaId);

  // If the URL changes (e.g. user navigates between resume sessions) keep the
  // local rmaId in sync.
  useEffect(() => {
    if (resumeRmaId) setRmaId(resumeRmaId);
  }, [resumeRmaId]);

  // The DamageWizard / SeasonalWizard manages all post-customer-selection
  // state (items, mutations, approval/denial). This page just brokers the
  // customer + returnType selection and hands off to the right wizard.

  // Back link target — when the operator came from a customer page (the
  // "Create return" CTA on the Returns tab passes ?customerId), bounce
  // them back there instead of dumping them on the global /returns list.
  const backTarget = prefilledCustomerId
    ? {
        to: "/customers/$customerId" as const,
        params: { customerId: prefilledCustomerId },
        label:
          selectedCustomer?.displayName ?? "Customer",
      }
    : { to: "/returns" as const, params: undefined, label: "Returns" };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() =>
            backTarget.params
              ? navigate({
                  to: backTarget.to,
                  params: backTarget.params,
                })
              : navigate({ to: backTarget.to })
          }
          className="inline-flex items-center gap-1 text-sm text-secondary hover:text-primary"
        >
          <ArrowLeft className="size-4" />
          {backTarget.label}
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

      {/* Damage — multi-step wizard */}
      {selectedCustomer && returnType === "damage" && selectedCustomer.qbCustomerId && (
        <DamageWizard
          customer={{
            id: selectedCustomer.id,
            qbCustomerId: selectedCustomer.qbCustomerId,
            displayName: selectedCustomer.displayName,
          }}
          initialRmaId={rmaId}
          onCompleted={(id) => {
            void navigate({
              to: "/returns/$rmaId",
              params: { rmaId: id },
            });
          }}
        />
      )}
      {selectedCustomer && returnType === "damage" && !selectedCustomer.qbCustomerId && (
        <div className="flex items-center gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
          <AlertCircle className="size-4 shrink-0" />
          This customer has no QBO customer id — cannot create an RMA.
        </div>
      )}

      {/* Seasonal / non-seasonal — multi-step wizard */}
      {selectedCustomer && (returnType === "seasonal" || returnType === "non_seasonal") && (
        <SeasonalWizard
          customer={{
            id: selectedCustomer.id,
            qbCustomerId: selectedCustomer.qbCustomerId ?? "",
            displayName: selectedCustomer.displayName,
          }}
          returnType={returnType}
          initialRmaId={rmaId}
          onCompleted={(id) => {
            void navigate({
              to: "/returns/$rmaId",
              params: { rmaId: id },
            });
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
