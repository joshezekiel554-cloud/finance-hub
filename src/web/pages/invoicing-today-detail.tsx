// Mobile-only full-screen detail page for a single shipment from the
// Today queue. Tap a row on /invoicing → navigate here → review/edit
// → Send to QBO. Desktop redirects to /invoicing (inline ShipmentCard
// covers the desktop UX).
//
// Implementation note: this is a parallel implementation of the
// edit/send/dismiss flow already in the desktop ShipmentCard component.
// We didn't extract a shared hook to avoid risk of regression in the
// desktop send path (the desktop card is the operator's daily driver).
// The two paths call the same backend endpoints
// (`/api/invoicing/{today,send,dismiss,restore,items/search,terms}`)
// so server-side behavior is identical. Future polish: consolidate
// when both surfaces have matured.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Mail, FileText, Truck, X } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody } from "../components/ui/card";
import { MobileAppBar } from "../components/mobile-app-bar";
import { StickyActionBar, StickyActionBarSpacer } from "../components/sticky-action-bar";
import { cn } from "../lib/cn";

// ---------- Shared types (mirror what /api/invoicing/today returns) ----------

type ReconcileAction =
  | { type: "set_metadata"; trackingNumber: string; shipVia: string; shipDate: string }
  | { type: "keep"; lineId: string; sku: string; qty: number }
  | {
      type: "qty_change";
      lineId: string;
      sku: string;
      fromQty: number;
      toQty: number;
      unitPriceOverride?: number;
      reason:
        | "shipped_less"
        | "shipped_more"
        | "not_shipped"
        | "split_zero"
        | "user_override"
        | "price_change";
    }
  | {
      type: "remove";
      lineId: string;
      sku: string;
      qty: number;
      reason: "not_shipped";
    }
  | {
      type: "add";
      sku: string;
      qty: number;
      unitPrice: number | null;
      priceSource: "shopify_b2b" | "fallback" | "qb_item_lookup";
      itemId?: string;
      itemName?: string;
    };

type QbItemSearchHit = {
  id: string;
  name: string;
  sku: string | null;
  unitPrice: number | null;
  type: string | null;
};

type Row = {
  gmailId: string;
  receivedAt: string | null;
  parseConfidence: number;
  parseMissingFields: string[];
  emailSubject: string;
  emailFrom: string;
  emailSnippet: string;
  emailBody: string;
  parsed: {
    poNumber: string | null;
    shopifyOrderNumber: string | null;
    transactionNumber: string | null;
    endCustomerName: string | null;
    carrierShort: string | null;
    carrierLong: string | null;
    trackingNumber: string | null;
    shipDate: string | null;
    lineItems: Array<{ sku: string; quantity: string }>;
  };
  qbInvoice: {
    docType: "invoice" | "salesreceipt";
    id: string;
    docNumber: string;
    syncToken: string;
    customerId: string | null;
    customerName: string | null;
    totalAmt: number;
    balance: number;
    currency: string | null;
    existingTrackingNum: string | null;
    existingShipDate: string | null;
    existingShipVia: string | null;
    existingTermsId: string | null;
    existingTermsName: string | null;
    emailStatus: string | null;
    lastSentAt: string | null;
    billEmail: string | null;
    billEmailCc: string | null;
    billEmailBcc: string | null;
    lines: Array<{
      lineId: string;
      sku: string | null;
      qty: number;
      unitPrice: number;
      itemName: string | null;
    }>;
  } | null;
  qbInvoiceError: string | null;
  shopifyOrder: {
    id: number;
    name: string;
    orderNumber: number;
    customerEmail: string | null;
    lineCount: number;
    note: string | null;
    lineItems: Array<{ sku: string; paidPrice: number }>;
  } | null;
  shopifyOrderError: string | null;
  reconcileResult: {
    actions: ReconcileAction[];
    summary: {
      keep: number;
      qty_change: number;
      add: number;
      remove: number;
      addsNeedingPrice: string[];
    };
  } | null;
};

type DismissReason = "b2c_paid_upfront" | "etsy_faire" | "other";
type DismissedRecord = {
  reason: DismissReason;
  reasonNote: string | null;
  dismissedAt: string;
};
type ApiResponse = {
  rows: Row[];
  dismissed: Record<string, DismissedRecord>;
  shadowMode: boolean;
};
type Term = { id: string; name: string; dueDays: number | null };
type TermsResponse = { terms: Term[] };
type SendResult =
  | {
      ok: true;
      status: "shadow" | "sent";
      email?: { sentTo: string | null; sentAt: string } | null;
      emailError?: string | null;
    }
  | { ok: false; error: string };

const REASON_LABELS: Record<DismissReason, string> = {
  b2c_paid_upfront: "B2C / paid upfront",
  etsy_faire: "Etsy / Faire",
  other: "Other",
};

// ---------- Page ----------

export default function InvoicingTodayDetailPage() {
  const { gmailId } = useParams({ from: "/invoicing/$gmailId" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Desktop users land here by accident → bounce back to the list.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (mq.matches) void navigate({ to: "/invoicing" });
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [navigate]);

  const { data, isPending, isError, error } = useQuery<ApiResponse>({
    queryKey: ["invoicing", "today"],
    queryFn: async () => {
      const res = await fetch("/api/invoicing/today");
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const { data: termsData } = useQuery<TermsResponse>({
    queryKey: ["invoicing", "terms"],
    queryFn: async () => {
      const res = await fetch("/api/invoicing/terms");
      if (!res.ok) throw new Error(`terms fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const terms = termsData?.terms ?? [];

  const row = useMemo<Row | null>(
    () => data?.rows.find((r) => r.gmailId === gmailId) ?? null,
    [data, gmailId],
  );
  const dismissedRecord = row ? data?.dismissed[row.gmailId] ?? null : null;

  if (isPending) {
    return (
      <div className="-m-4 md:-m-6 md:hidden">
        <MobileAppBar
          title="Loading…"
          back={() => void navigate({ to: "/invoicing" })}
        />
        <div className="p-4 text-sm text-muted">Loading shipment…</div>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="-m-4 md:-m-6 md:hidden">
        <MobileAppBar
          title="Error"
          back={() => void navigate({ to: "/invoicing" })}
        />
        <div className="p-4 text-sm text-accent-danger">
          {(error as Error).message}
        </div>
      </div>
    );
  }
  if (!row || !data) {
    return (
      <div className="-m-4 md:-m-6 md:hidden">
        <MobileAppBar
          title="Not found"
          back={() => void navigate({ to: "/invoicing" })}
        />
        <div className="p-4">
          <p className="text-sm text-secondary">
            This shipment isn't in today's queue. It may have been sent
            already, dismissed, or fallen outside the 7-day window.
          </p>
          <Button
            variant="primary"
            size="sm"
            className="mt-4"
            onClick={() => void navigate({ to: "/invoicing" })}
          >
            Back to Today
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DetailBody
      row={row}
      dismissedRecord={dismissedRecord}
      shadowMode={data.shadowMode}
      terms={terms}
      onBack={() => void navigate({ to: "/invoicing" })}
      queryClient={queryClient}
    />
  );
}

// ---------- Detail body — owns the editable state ----------

type DetailBodyProps = {
  row: Row;
  dismissedRecord: DismissedRecord | null;
  shadowMode: boolean;
  terms: Term[];
  onBack: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
};

type Panel = "email" | "invoice" | "dismiss" | null;

function DetailBody(props: DetailBodyProps) {
  const { row, dismissedRecord, shadowMode, terms, onBack, queryClient } = props;

  const [editedActions, setEditedActions] = useState<ReconcileAction[]>(
    row.reconcileResult?.actions ?? [],
  );
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [selectedTermId, setSelectedTermId] = useState<string>(
    row.qbInvoice?.existingTermsId ?? "",
  );
  const [customerMemo, setCustomerMemo] = useState<string>("");
  const [docNumberSuffix, setDocNumberSuffix] = useState<string>("");
  const [billEmailTo, setBillEmailTo] = useState<string>(row.qbInvoice?.billEmail ?? "");
  const [billEmailCc, setBillEmailCc] = useState<string>(row.qbInvoice?.billEmailCc ?? "");
  const [billEmailBcc, setBillEmailBcc] = useState<string>(row.qbInvoice?.billEmailBcc ?? "");
  const todayNY = useMemo(
    () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()),
    [],
  );
  const [txnDate, setTxnDate] = useState<string>(todayNY);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [panel, setPanel] = useState<Panel>(null);

  const blockingAdds = useMemo(
    () =>
      editedActions.filter(
        (a) => a.type === "add" && (a.unitPrice === null || a.unitPrice <= 0),
      ),
    [editedActions],
  );

  function updateLineQty(lineId: string, newQty: number) {
    setEditedActions((prev) =>
      prev.map((a) => {
        if (a.type === "keep" && a.lineId === lineId) {
          if (newQty === a.qty) return a;
          return { type: "qty_change", lineId: a.lineId, sku: a.sku, fromQty: a.qty, toQty: newQty, reason: "user_override" };
        }
        if (a.type === "qty_change" && a.lineId === lineId) {
          if (newQty === a.fromQty) {
            return { type: "keep", lineId: a.lineId, sku: a.sku, qty: a.fromQty };
          }
          return { ...a, toQty: newQty };
        }
        if (a.type === "remove" && a.lineId === lineId) {
          if (newQty === a.qty) {
            return { type: "keep", lineId: a.lineId, sku: a.sku, qty: a.qty };
          }
          return { type: "qty_change", lineId: a.lineId, sku: a.sku, fromQty: a.qty, toQty: newQty, reason: "user_override" };
        }
        return a;
      }),
    );
    setSendResult(null);
  }

  function updateAddPrice(sku: string, newPrice: number) {
    setEditedActions((prev) =>
      prev.map((a) =>
        a.type === "add" && a.sku === sku
          ? { ...a, unitPrice: Number.isFinite(newPrice) ? newPrice : null, priceSource: "shopify_b2b" as const }
          : a,
      ),
    );
    setSendResult(null);
  }

  function updateAddQty(sku: string, newQty: number) {
    setEditedActions((prev) =>
      prev.map((a) => (a.type === "add" && a.sku === sku ? { ...a, qty: newQty } : a)),
    );
    setSendResult(null);
  }

  function removeAddLine(sku: string) {
    setEditedActions((prev) => prev.filter((a) => !(a.type === "add" && a.sku === sku)));
    setSendResult(null);
  }

  function addQbItemLine(item: QbItemSearchHit) {
    const existing = editedActions.find((a) => a.type === "add" && a.itemId === item.id);
    if (existing) {
      setSendResult({ ok: false, error: `${item.name} is already in this invoice` });
      return;
    }
    setEditedActions((prev) => [
      ...prev,
      {
        type: "add",
        sku: item.sku ?? item.name,
        qty: 1,
        unitPrice: item.unitPrice,
        priceSource: "qb_item_lookup",
        itemId: item.id,
        itemName: item.name,
      },
    ]);
    setSendResult(null);
  }

  const sendMutation = useMutation({
    mutationFn: async (): Promise<SendResult> => {
      if (!row.qbInvoice) return { ok: false, error: "no qb invoice" };
      const termsChanged =
        selectedTermId !== "" && selectedTermId !== row.qbInvoice.existingTermsId;
      const selectedTerm = termsChanged ? terms.find((t) => t.id === selectedTermId) : undefined;
      const res = await fetch("/api/invoicing/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceId: row.qbInvoice.id,
          docType: row.qbInvoice.docType,
          expectedSyncToken: row.qbInvoice.syncToken,
          actions: editedActions,
          discountPercent: discountPercent > 0 ? discountPercent : undefined,
          salesTermId: selectedTerm?.id,
          salesTermName: selectedTerm?.name,
          customerMemo: customerMemo.trim() || undefined,
          docNumberSuffix: docNumberSuffix.trim() || undefined,
          billEmailTo:
            billEmailTo.trim() && billEmailTo.trim() !== (row.qbInvoice?.billEmail ?? "")
              ? billEmailTo.trim()
              : undefined,
          billEmailCc:
            billEmailCc.trim() && billEmailCc.trim() !== (row.qbInvoice?.billEmailCc ?? "")
              ? billEmailCc.trim()
              : undefined,
          billEmailBcc:
            billEmailBcc.trim() && billEmailBcc.trim() !== (row.qbInvoice?.billEmailBcc ?? "")
              ? billEmailBcc.trim()
              : undefined,
          txnDate: txnDate !== todayNY ? txnDate : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
      return {
        ok: true,
        status: body.outcome?.status ?? "shadow",
        email: body.outcome?.email ?? null,
        emailError: body.outcome?.emailError ?? null,
      };
    },
    onSuccess: (result) => {
      setSendResult(result);
      if (result.ok && result.status === "sent") {
        void queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      }
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (payload: { reason: DismissReason; reasonNote?: string }) => {
      const res = await fetch("/api/invoicing/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gmailId: row.gmailId, ...payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      setPanel(null);
      onBack();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/invoicing/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gmailId: row.gmailId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] }),
  });

  const po = row.parsed.poNumber ?? "(no PO)";
  const customer = row.qbInvoice?.customerName ?? row.shopifyOrder?.customerEmail ?? "(unknown)";
  const sendSucceeded = sendResult?.ok === true && sendResult.status === "sent";

  const emailSummary = billEmailTo.trim() || "no recipient set";
  const invoiceSummary = (() => {
    const currentTermName = terms.find((t) => t.id === selectedTermId)?.name
      ?? row.qbInvoice?.existingTermsName
      ?? "Terms";
    const date = txnDate === todayNY ? "today" : txnDate;
    return `${currentTermName} · ${date}`;
  })();

  return (
    <div className="-m-4 md:-m-6 md:hidden flex min-h-[100dvh] flex-col">
      <MobileAppBar
        title={`${po} → ${customer}`}
        subtitle={
          row.qbInvoice
            ? `${row.qbInvoice.docType === "salesreceipt" ? "Sales receipt" : "Invoice"} #${row.qbInvoice.docNumber}`
            : "No QB invoice"
        }
        back={onBack}
      />

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {dismissedRecord && (
          <div className="rounded-md border border-default bg-subtle p-3 text-sm">
            <Badge tone="neutral">
              Dismissed: {REASON_LABELS[dismissedRecord.reason]}
              {dismissedRecord.reasonNote ? ` — ${dismissedRecord.reasonNote}` : ""}
            </Badge>
            <div className="mt-3 flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => restoreMutation.mutate()}
                disabled={restoreMutation.isPending}
              >
                {restoreMutation.isPending ? "Restoring…" : "Restore"}
              </Button>
            </div>
          </div>
        )}

        {sendSucceeded && sendResult.ok && (
          <SuccessBanner result={sendResult} qboInvoiceId={row.qbInvoice?.id ?? null} />
        )}

        {sendResult && !sendResult.ok && (
          <div className="rounded-md border border-accent-danger/30 bg-accent-danger/10 p-3 text-sm text-accent-danger">
            <div className="font-medium">Send failed</div>
            <div className="mt-1 text-xs">{sendResult.error}</div>
          </div>
        )}

        {row.shopifyOrder?.note && (
          <div className="rounded-md border border-accent-info/30 bg-accent-info/5 p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-accent-info">
              Shopify note
            </div>
            <div className="mt-1 whitespace-pre-wrap text-sm">
              {row.shopifyOrder.note}
            </div>
          </div>
        )}

        {/* Shipment panel — read-only */}
        <SectionCard title="Shipment" icon={<Truck className="size-4" />}>
          <KvRow k="Tracking" v={row.parsed.trackingNumber ?? "—"} />
          <KvRow
            k="Carrier"
            v={row.parsed.carrierShort ?? row.parsed.carrierLong ?? "—"}
          />
          <KvRow k="Ship date" v={row.parsed.shipDate ?? "—"} />
          {row.parsed.transactionNumber && (
            <KvRow k="Feldart Tx#" v={row.parsed.transactionNumber} />
          )}
        </SectionCard>

        {/* Line items */}
        {row.reconcileResult && row.qbInvoice && (
          <SectionCard
            title={`Line items · ${editedActions.length}`}
            icon={<FileText className="size-4" />}
          >
            <ReconcileLines
              row={row}
              actions={editedActions}
              onLineQty={updateLineQty}
              onAddPrice={updateAddPrice}
              onAddQty={updateAddQty}
              onRemoveAdd={removeAddLine}
            />
            <MobileAddLine onPick={addQbItemLine} />
          </SectionCard>
        )}

        {/* Disclosure rows */}
        {row.qbInvoice && row.reconcileResult && (
          <>
            <DisclosureRow
              icon={<Mail className="size-4 text-muted" />}
              label="Email recipients"
              right={emailSummary}
              onClick={() => setPanel("email")}
            />
            <DisclosureRow
              icon={<FileText className="size-4 text-muted" />}
              label="Invoice details"
              right={invoiceSummary}
              onClick={() => setPanel("invoice")}
            />
          </>
        )}

        {/* QB error */}
        {row.qbInvoiceError && !row.qbInvoice && (
          <Card>
            <CardBody>
              <p className="text-xs text-accent-danger">
                QB lookup: {row.qbInvoiceError}
              </p>
            </CardBody>
          </Card>
        )}

        {/* Total */}
        {row.qbInvoice && (
          <div className="mt-2 flex items-baseline justify-between border-t border-default pt-3">
            <span className="text-sm text-secondary">Total</span>
            <span className="text-lg font-semibold tabular-nums">
              {row.qbInvoice.currency === "GBP" ? "£" : "$"}
              {row.qbInvoice.totalAmt.toFixed(2)}
            </span>
          </div>
        )}

        <StickyActionBarSpacer />
      </div>

      {/* Sticky action bar. Hide when send already succeeded — operator
          should go back, not re-send. */}
      {!dismissedRecord && !sendSucceeded && (
        <StickyActionBar>
          <Button
            variant="ghost"
            size="md"
            className="flex-1"
            onClick={() => setPanel("dismiss")}
          >
            Dismiss
          </Button>
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            disabled={
              !row.qbInvoice ||
              blockingAdds.length > 0 ||
              sendMutation.isPending
            }
            onClick={() => sendMutation.mutate()}
          >
            {sendMutation.isPending
              ? "Sending…"
              : shadowMode
                ? "Preview send"
                : "Send to QBO →"}
          </Button>
        </StickyActionBar>
      )}
      {sendSucceeded && (
        <StickyActionBar>
          <Button
            variant="primary"
            size="md"
            className="w-full"
            onClick={onBack}
          >
            Done
          </Button>
        </StickyActionBar>
      )}

      {panel === "email" && (
        <PanelSheet
          title="Email recipients"
          subtitle={row.qbInvoice ? `#${row.qbInvoice.docNumber}` : undefined}
          onClose={() => setPanel(null)}
        >
          <FormField label="To">
            <input
              type="email"
              value={billEmailTo}
              onChange={(e) => {
                setBillEmailTo(e.target.value);
                setSendResult(null);
              }}
              className={fieldInputCls}
            />
            <FormHelp>
              Default from the QBO invoice. Editing here doesn't change the
              customer's saved record.
            </FormHelp>
          </FormField>
          <FormField label="CC">
            <input
              type="text"
              value={billEmailCc}
              onChange={(e) => {
                setBillEmailCc(e.target.value);
                setSendResult(null);
              }}
              placeholder="comma-separated"
              className={fieldInputCls}
            />
          </FormField>
          <FormField label="BCC">
            <input
              type="text"
              value={billEmailBcc}
              onChange={(e) => {
                setBillEmailBcc(e.target.value);
                setSendResult(null);
              }}
              placeholder="comma-separated"
              className={fieldInputCls}
            />
          </FormField>
        </PanelSheet>
      )}

      {panel === "invoice" && (
        <PanelSheet
          title="Invoice details"
          subtitle={row.qbInvoice ? `#${row.qbInvoice.docNumber}` : undefined}
          onClose={() => setPanel(null)}
        >
          <FormField label="Terms">
            <select
              value={selectedTermId}
              onChange={(e) => {
                setSelectedTermId(e.target.value);
                setSendResult(null);
              }}
              className={fieldInputCls}
            >
              <option value="">(keep existing)</option>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.dueDays != null ? ` (${t.dueDays}d)` : ""}
                </option>
              ))}
            </select>
            {row.qbInvoice?.existingTermsName && (
              <FormHelp>Current on invoice: {row.qbInvoice.existingTermsName}</FormHelp>
            )}
          </FormField>
          <FormField label="Discount %">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={0.5}
              value={discountPercent}
              onChange={(e) => {
                const n = Number(e.target.value);
                setDiscountPercent(Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);
                setSendResult(null);
              }}
              className={fieldInputCls}
            />
          </FormField>
          <FormField label="Customer memo">
            <textarea
              value={customerMemo}
              onChange={(e) => {
                setCustomerMemo(e.target.value);
                setSendResult(null);
              }}
              rows={3}
              placeholder="Renders on invoice + statement"
              className={cn(fieldInputCls, "min-h-20 resize-y py-2")}
            />
          </FormField>
          <FormField label="DocNumber suffix">
            <input
              type="text"
              value={docNumberSuffix}
              onChange={(e) => {
                setDocNumberSuffix(e.target.value);
                setSendResult(null);
              }}
              placeholder="-SP"
              className={fieldInputCls}
            />
            <FormHelp>e.g. -SP for special offer.</FormHelp>
          </FormField>
          <FormField label="Issue date">
            <input
              type="date"
              value={txnDate}
              onChange={(e) => {
                setTxnDate(e.target.value);
                setSendResult(null);
              }}
              className={fieldInputCls}
            />
          </FormField>
          {row.qbInvoice && (
            <a
              href={`https://qbo.intuit.com/app/invoice?txnId=${row.qbInvoice.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center justify-between rounded-md border border-default bg-subtle px-3 py-3 text-sm hover:bg-elevated"
            >
              <span>Preview in QBO</span>
              <ChevronRight className="size-4 text-muted" />
            </a>
          )}
        </PanelSheet>
      )}

      {panel === "dismiss" && (
        <DismissSheet
          row={row}
          onClose={() => setPanel(null)}
          pending={dismissMutation.isPending}
          onConfirm={(reason, reasonNote) =>
            dismissMutation.mutate({ reason, reasonNote })
          }
        />
      )}
    </div>
  );
}

// ---------- Sub-components ----------

function SectionCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-default bg-subtle p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-default/60 py-2 text-sm last:border-0">
      <span className="text-secondary">{k}</span>
      <span className="text-right tabular-nums">{v}</span>
    </div>
  );
}

function DisclosureRow({
  icon,
  label,
  right,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  right?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-default bg-subtle px-3 py-3 text-left text-sm transition-colors hover:bg-elevated"
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="text-primary">{label}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1">
        {right ? (
          <span className="max-w-[160px] truncate text-xs text-muted">
            {right}
          </span>
        ) : null}
        <ChevronRight className="size-4 shrink-0 text-muted" />
      </span>
    </button>
  );
}

function ReconcileLines({
  row,
  actions,
  onLineQty,
  onAddPrice,
  onAddQty,
  onRemoveAdd,
}: {
  row: Row;
  actions: ReconcileAction[];
  onLineQty: (lineId: string, qty: number) => void;
  onAddPrice: (sku: string, price: number) => void;
  onAddQty: (sku: string, qty: number) => void;
  onRemoveAdd: (sku: string) => void;
}) {
  return (
    <div className="space-y-2">
      {actions.map((a, i) => {
        if (a.type === "set_metadata") return null;
        if (a.type === "add") {
          const needsPrice = a.unitPrice === null || a.unitPrice <= 0;
          return (
            <div
              key={`add-${a.sku}-${i}`}
              className={cn(
                "rounded-md border border-default px-2 py-2",
                needsPrice && "bg-accent-warning/5 border-accent-warning/40",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-xs">{a.sku}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAdd(a.sku)}
                  className="text-xs text-muted hover:text-accent-danger"
                  aria-label="Remove added line"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                {a.itemName ?? "Added line"}
                {needsPrice && <span className="ml-1 text-accent-warning">· price needed</span>}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-xs text-secondary">
                  <span className="mb-1 block">Qty</span>
                  <input
                    type="number"
                    value={a.qty}
                    onChange={(e) => onAddQty(a.sku, Math.max(0, Number(e.target.value) || 0))}
                    className={fieldInputClsCompact}
                  />
                </label>
                <label className="text-xs text-secondary">
                  <span className="mb-1 block">Unit price</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="£"
                    value={a.unitPrice ?? ""}
                    onChange={(e) => onAddPrice(a.sku, Number(e.target.value))}
                    className={fieldInputClsCompact}
                  />
                </label>
              </div>
            </div>
          );
        }
        // After excluding set_metadata + add above, `a` is keep | qty_change | remove,
        // all of which carry lineId + sku.
        const lineKey = a.lineId;
        const line = row.qbInvoice?.lines.find((l) => l.lineId === a.lineId);
        const sku = line?.sku ?? a.sku;
        let labelText = "";
        let qtyValue: number = 0;
        let dim = false;
        if (a.type === "keep") {
          labelText = "keep";
          qtyValue = a.qty;
        } else if (a.type === "qty_change") {
          labelText = a.reason === "price_change"
            ? `price change`
            : `qty change ${a.fromQty} → ${a.toQty}`;
          qtyValue = a.toQty;
        } else if (a.type === "remove") {
          labelText = "not shipped";
          qtyValue = 0;
          dim = true;
        }
        return (
          <div
            key={lineKey}
            className={cn(
              "flex items-center justify-between gap-2 rounded-md border border-default/60 px-2 py-2",
              dim && "opacity-60",
            )}
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{sku}</div>
              <div className="text-[11px] text-muted">{labelText}</div>
            </div>
            <input
              type="number"
              value={qtyValue}
              onChange={(e) => {
                if (!("lineId" in a)) return;
                onLineQty(a.lineId, Math.max(0, Number(e.target.value) || 0));
              }}
              className={cn(fieldInputClsCompact, "w-16 text-center")}
            />
          </div>
        );
      })}
    </div>
  );
}

function MobileAddLine({ onPick }: { onPick: (item: QbItemSearchHit) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QbItemSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/invoicing/items/search?q=${encodeURIComponent(trimmed)}`,
        );
        if (!res.ok) {
          setResults([]);
          return;
        }
        const body = (await res.json()) as { items: QbItemSearchHit[] };
        setResults(body.items);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 w-full rounded-md border border-dashed border-default px-3 py-3 text-sm text-secondary hover:bg-elevated"
      >
        + Add a line
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-default bg-base p-2">
      <input
        autoFocus
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search QB items by SKU or name…"
        className={fieldInputClsCompact}
      />
      {query.trim().length >= 2 && (
        <div className="mt-2 max-h-72 overflow-y-auto">
          {loading && <div className="px-2 py-1 text-xs text-muted">Searching…</div>}
          {!loading && results.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted">No matches.</div>
          )}
          {results.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onPick(item);
                setOpen(false);
                setQuery("");
                setResults([]);
              }}
              className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-elevated"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs">{item.sku ?? "—"}</div>
                <div className="truncate text-[11px] text-muted">{item.name}</div>
              </div>
              <div className="shrink-0 text-xs tabular-nums">
                {item.unitPrice != null ? `£${item.unitPrice.toFixed(2)}` : "—"}
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setQuery("");
            setResults([]);
          }}
        >
          Close
        </Button>
      </div>
    </div>
  );
}

// Full-screen overlay panel for the disclosure-row editors (Email,
// Invoice details, Dismiss). Slides up from the bottom — covers the
// whole detail page on mobile. Close X returns to detail without
// reverting state.
function PanelSheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-base md:hidden">
      <MobileAppBar
        title={title}
        subtitle={subtitle}
        leftSlot={
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-primary hover:bg-elevated"
          >
            <X className="size-5" />
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
      <StickyActionBar>
        <Button variant="primary" size="md" className="w-full" onClick={onClose}>
          Done
        </Button>
      </StickyActionBar>
    </div>
  );
}

function DismissSheet({
  row,
  onClose,
  pending,
  onConfirm,
}: {
  row: Row;
  onClose: () => void;
  pending: boolean;
  onConfirm: (reason: DismissReason, reasonNote?: string) => void;
}) {
  const [reason, setReason] = useState<DismissReason>("etsy_faire");
  const [note, setNote] = useState("");
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-base md:hidden">
      <MobileAppBar
        title="Dismiss shipment"
        subtitle={row.qbInvoice ? `#${row.qbInvoice.docNumber}` : undefined}
        leftSlot={
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-primary hover:bg-elevated"
          >
            <X className="size-5" />
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <p className="text-sm text-secondary">
          Hide this shipment from the active list. Restorable from the
          Dismissed tab if you change your mind.
        </p>
        <FormField label="Reason">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as DismissReason)}
            className={fieldInputCls}
          >
            <option value="b2c_paid_upfront">B2C / paid upfront</option>
            <option value="etsy_faire">Etsy / Faire</option>
            <option value="other">Other</option>
          </select>
        </FormField>
        {reason === "other" && (
          <FormField label="Reason note (optional)">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. wholesale not yet billed"
              className={fieldInputCls}
            />
          </FormField>
        )}
      </div>
      <StickyActionBar>
        <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          className="flex-1"
          disabled={pending}
          onClick={() =>
            onConfirm(reason, reason === "other" ? note.trim() || undefined : undefined)
          }
        >
          {pending ? "Dismissing…" : "Confirm dismiss"}
        </Button>
      </StickyActionBar>
    </div>
  );
}

function SuccessBanner({
  result,
  qboInvoiceId,
}: {
  result: Extract<SendResult, { ok: true }>;
  qboInvoiceId: string | null;
}) {
  return (
    <div className="rounded-md border border-accent-success/30 bg-accent-success/10 p-3 text-sm text-accent-success">
      <div className="font-medium">
        {result.status === "sent"
          ? result.email?.sentTo
            ? `Sent to ${result.email.sentTo}`
            : "Sent"
          : "Preview send OK"}
      </div>
      {result.emailError ? (
        <div className="mt-1 text-xs text-accent-warning">
          Updated, email step failed: {result.emailError.slice(0, 100)}
        </div>
      ) : (
        <div className="mt-1 text-xs text-secondary">
          {result.email?.sentAt
            ? new Date(result.email.sentAt).toLocaleTimeString()
            : "metadata + email both wrote successfully"}
        </div>
      )}
      {qboInvoiceId && (
        <a
          href={`https://qbo.intuit.com/app/invoice?txnId=${qboInvoiceId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
        >
          Open invoice in QBO →
        </a>
      )}
    </div>
  );
}

// ---------- Tiny form primitives + classnames ----------

const fieldInputCls =
  "h-11 w-full rounded-md border border-default bg-subtle px-3 text-base text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40";

const fieldInputClsCompact =
  "h-10 w-full rounded-md border border-default bg-base px-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40";

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function FormHelp({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs text-muted">{children}</p>;
}
