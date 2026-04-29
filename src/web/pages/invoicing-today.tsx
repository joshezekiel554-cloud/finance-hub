import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, MessageSquare, Package, Truck } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";

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
    id: string;
    docNumber: string;
    syncToken: string;
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
    lineItems: Array<{ sku: string; retailPrice: number }>;
  } | null;
  shopifyOrderError: string | null;
  reconcileResult: {
    actions: ReconcileAction[];
    summary: { keep: number; qty_change: number; add: number; addsNeedingPrice: string[] };
  } | null;
};

type ApiResponse = { rows: Row[]; shadowMode: boolean };
type Term = { id: string; name: string; dueDays: number | null };
type TermsResponse = { terms: Term[] };

export default function InvoicingTodayPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useQuery<ApiResponse>({
    queryKey: ["invoicing", "today"],
    queryFn: async () => {
      const res = await fetch("/api/invoicing/today");
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      return res.json();
    },
    // Manual refresh only — saves Gmail+QB+Shopify quota.
    refetchOnWindowFocus: false,
  });

  // QBO term list — small (<10 entries usually), cached for the session.
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

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoicing — Today</h1>
          <p className="mt-1 text-sm text-secondary">
            Feldart shipment notifications from the last 7 days, matched to QuickBooks invoices and Shopify orders.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data === undefined ? (
            <Badge tone="neutral">…</Badge>
          ) : data.shadowMode ? (
            <Badge tone="info">Shadow mode — no QBO writes</Badge>
          ) : (
            <Badge tone="critical">LIVE — writes to QBO enabled</Badge>
          )}
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {isPending && (
        <Card>
          <CardBody>
            <p className="text-sm text-secondary">Loading shipments…</p>
          </CardBody>
        </Card>
      )}

      {isError && (
        <Card>
          <CardBody>
            <p className="text-sm text-accent-danger">Error: {(error as Error).message}</p>
          </CardBody>
        </Card>
      )}

      {data && data.rows.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-sm text-secondary">No shipment notifications found in the last 7 days.</p>
          </CardBody>
        </Card>
      )}

      {data && data.rows.length > 0 && <Summary rows={data.rows} />}

      {data?.rows.map((row) => (
        <ShipmentCard
          key={row.gmailId}
          row={row}
          shadowMode={data.shadowMode}
          terms={terms}
        />
      ))}
    </div>
  );
}

function Summary({ rows }: { rows: Row[] }) {
  const ready = rows.filter((r) => r.reconcileResult !== null);
  const lowConfidence = rows.filter((r) => r.parseConfidence < 0.5);
  const missingInvoice = rows.filter(
    (r) => r.parseConfidence >= 0.5 && r.qbInvoice === null,
  );
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card>
        <CardBody className="flex items-center gap-3">
          <CheckCircle2 className="size-5 text-accent-success" />
          <div>
            <div className="text-2xl font-semibold">{ready.length}</div>
            <div className="text-xs text-secondary">ready to reconcile</div>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="flex items-center gap-3">
          <AlertCircle className="size-5 text-accent-warning" />
          <div>
            <div className="text-2xl font-semibold">{missingInvoice.length}</div>
            <div className="text-xs text-secondary">no QB invoice match (likely sales receipts)</div>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="flex items-center gap-3">
          <Package className="size-5 text-muted" />
          <div>
            <div className="text-2xl font-semibold">{lowConfidence.length}</div>
            <div className="text-xs text-secondary">unparseable / not a shipment email</div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

type SendResult =
  | {
      ok: true;
      status: "shadow" | "sent";
      payload?: unknown;
      response?: unknown;
      email?: { sentTo: string | null; sentAt: string } | null;
      emailError?: string | null;
    }
  | { ok: false; error: string };

function ShipmentCard({
  row,
  shadowMode,
  terms,
}: {
  row: Row;
  shadowMode: boolean;
  terms: Term[];
}) {
  if (row.parseConfidence < 0.5) return null;

  // Local editable state. Initialised from the reconciler output and from
  // the parsed shipment, both treated as defaults the user can override.
  const [editedActions, setEditedActions] = useState<ReconcileAction[]>(
    row.reconcileResult?.actions ?? [],
  );
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  // Terms dropdown defaults to the invoice's existing terms; "" means no
  // override (omits SalesTermRef from the payload, leaving QB as-is).
  const [selectedTermId, setSelectedTermId] = useState<string>(
    row.qbInvoice?.existingTermsId ?? "",
  );
  const [customerMemo, setCustomerMemo] = useState<string>("");
  const [docNumberSuffix, setDocNumberSuffix] = useState<string>("");
  const [sendResult, setSendResult] = useState<SendResult | null>(null);

  const queryClient = useQueryClient();
  const sendMutation = useMutation({
    mutationFn: async (): Promise<SendResult> => {
      if (!row.qbInvoice) return { ok: false, error: "no qb invoice" };
      // Only send a SalesTermRef override when the dropdown value differs
      // from what the invoice already had. Avoids unnecessary churn.
      const termsChanged =
        selectedTermId !== "" && selectedTermId !== row.qbInvoice.existingTermsId;
      const selectedTerm = termsChanged
        ? terms.find((t) => t.id === selectedTermId)
        : undefined;
      const res = await fetch("/api/invoicing/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceId: row.qbInvoice.id,
          expectedSyncToken: row.qbInvoice.syncToken,
          actions: editedActions,
          discountPercent: discountPercent > 0 ? discountPercent : undefined,
          salesTermId: selectedTerm?.id,
          salesTermName: selectedTerm?.name,
          customerMemo: customerMemo.trim() || undefined,
          docNumberSuffix: docNumberSuffix.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: body.error ?? `HTTP ${res.status}` };
      }
      return {
        ok: true,
        status: body.outcome?.status ?? "shadow",
        payload: body.outcome?.payload,
        response: body.outcome?.response,
        email: body.outcome?.email ?? null,
        emailError: body.outcome?.emailError ?? null,
      };
    },
    onSuccess: (result) => {
      setSendResult(result);
      if (result.ok && result.status === "sent") {
        // Live send succeeded — refresh the list so this row picks up the
        // new SyncToken (or vanishes if its email is now flagged "sent" by
        // some downstream tracking). Shadow mode doesn't change anything,
        // so skip the refetch.
        queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      }
    },
  });

  const po = row.parsed.poNumber ?? "(no PO)";
  const customer = row.qbInvoice?.customerName ?? row.shopifyOrder?.customerEmail ?? "(unknown)";

  // Flag any add action with no resolved unitPrice — Send is blocked until
  // the user types one in.
  const blockingAdds = useMemo(
    () =>
      editedActions.filter(
        (a) => a.type === "add" && (a.unitPrice === null || a.unitPrice <= 0),
      ),
    [editedActions],
  );

  // Edit the final qty for an existing invoice line. Handles all three
  // transitions automatically:
  //   keep        → keep         (newQty matches the original)
  //   keep        → qty_change   (newQty differs; reason = user_override)
  //   qty_change  → qty_change   (just updates toQty)
  //   qty_change  → keep         (newQty matches the original fromQty)
  function updateLineQty(lineId: string, newQty: number) {
    setEditedActions((prev) =>
      prev.map((a) => {
        if (a.type === "keep" && a.lineId === lineId) {
          if (newQty === a.qty) return a;
          return {
            type: "qty_change",
            lineId: a.lineId,
            sku: a.sku,
            fromQty: a.qty,
            toQty: newQty,
            reason: "user_override",
          };
        }
        if (a.type === "qty_change" && a.lineId === lineId) {
          if (newQty === a.fromQty) {
            return {
              type: "keep",
              lineId: a.lineId,
              sku: a.sku,
              qty: a.fromQty,
            };
          }
          return { ...a, toQty: newQty };
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
          ? {
              ...a,
              unitPrice: Number.isFinite(newPrice) ? newPrice : null,
              // Once user edits the price, treat it as confident regardless
              // of the original priceSource.
              priceSource: "shopify_b2b" as const,
            }
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

  function addQbItemLine(item: QbItemSearchHit) {
    const existing = editedActions.find(
      (a) => a.type === "add" && a.itemId === item.id,
    );
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

  function removeAddLine(sku: string) {
    setEditedActions((prev) =>
      prev.filter((a) => !(a.type === "add" && a.sku === sku)),
    );
    setSendResult(null);
  }

  // Edit the QB unit price for an existing invoice line. Promotes a `keep`
  // to `qty_change` (with reason="price_change", qty unchanged) so the
  // sender's unitPriceOverride path engages. If the user types the
  // original price back in, demotes the action back to `keep`.
  function updateLinePrice(
    lineId: string,
    originalPrice: number,
    newPrice: number,
  ) {
    setEditedActions((prev) =>
      prev.map((a) => {
        if (a.type === "keep" && a.lineId === lineId) {
          if (newPrice === originalPrice) return a;
          return {
            type: "qty_change",
            lineId: a.lineId,
            sku: a.sku,
            fromQty: a.qty,
            toQty: a.qty,
            unitPriceOverride: newPrice,
            reason: "price_change",
          };
        }
        if (a.type === "qty_change" && a.lineId === lineId) {
          // If price reverts AND qty reverts, demote back to keep.
          const qtyMatches = a.toQty === a.fromQty;
          const priceMatches = newPrice === originalPrice;
          if (qtyMatches && priceMatches) {
            return { type: "keep", lineId: a.lineId, sku: a.sku, qty: a.fromQty };
          }
          return { ...a, unitPriceOverride: newPrice };
        }
        return a;
      }),
    );
    setSendResult(null);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Truck className="size-4 text-muted" />
            <div>
              <div className="text-sm font-semibold">
                {po} → {customer}
              </div>
              <div className="text-xs text-secondary">
                Feldart Tx #{row.parsed.transactionNumber} · {row.parsed.carrierShort} ·{" "}
                {row.parsed.trackingNumber} · ship date {row.parsed.shipDate}
              </div>
            </div>
          </div>
          {row.qbInvoice ? (
            <div className="text-right">
              <div className="text-xs text-secondary">QB invoice</div>
              <div className="text-sm font-medium">
                {row.qbInvoice.docNumber} · ${row.qbInvoice.totalAmt.toFixed(2)}{" "}
                {row.qbInvoice.currency}
              </div>
              <div className="mt-1 flex justify-end">
                <SendHistoryPill
                  status={row.qbInvoice.emailStatus}
                  sentAt={row.qbInvoice.lastSentAt}
                  to={row.qbInvoice.billEmail}
                />
              </div>
              {row.qbInvoice.existingTrackingNum && (
                <div className="mt-1 text-[11px] text-muted">
                  current tracking:{" "}
                  <span className="font-mono">{row.qbInvoice.existingTrackingNum}</span>
                </div>
              )}
            </div>
          ) : (
            <Badge tone="critical">No QB invoice</Badge>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {row.shopifyOrder?.note && (
          <div className="flex items-start gap-2 rounded-md border border-accent-info/30 bg-accent-info/5 px-3 py-2 text-sm text-secondary">
            <MessageSquare className="mt-0.5 size-4 shrink-0 text-accent-info" />
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-accent-info">
                Shopify note
              </div>
              <div className="mt-0.5 whitespace-pre-wrap">{row.shopifyOrder.note}</div>
            </div>
          </div>
        )}

        {row.qbInvoiceError && !row.qbInvoice && (
          <p className="text-xs text-accent-danger">QB lookup: {row.qbInvoiceError}</p>
        )}
        {row.shopifyOrderError && !row.shopifyOrder && (
          <p className="text-xs text-accent-warning">Shopify lookup: {row.shopifyOrderError}</p>
        )}

        {row.reconcileResult && (
          <>
            <ReconcileTable
              row={row}
              editedActions={editedActions}
              onLineQtyChange={updateLineQty}
              onLinePriceChange={updateLinePrice}
              onAddPriceChange={updateAddPrice}
              onAddQtyChange={updateAddQty}
              onRemoveAddLine={removeAddLine}
            />
            <AddLinePicker onPick={addQbItemLine} />
          </>
        )}

        {row.qbInvoice && row.reconcileResult && (
          <div className="space-y-3 border-t border-default pt-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block text-xs text-secondary">
                <span className="mb-1 block font-medium">
                  Customer note (renders on invoice + statement)
                </span>
                <textarea
                  rows={2}
                  value={customerMemo}
                  onChange={(e) => {
                    setCustomerMemo(e.target.value);
                    setSendResult(null);
                  }}
                  placeholder="Leave blank to clear the auto-sync memo"
                  className="w-full resize-y rounded-md border border-default bg-base px-2 py-1 text-sm"
                />
              </label>
              <div className="flex items-end gap-3">
                <label className="flex-1 text-xs text-secondary">
                  <span className="mb-1 block font-medium">DocNumber suffix</span>
                  <input
                    type="text"
                    value={docNumberSuffix}
                    onChange={(e) => {
                      setDocNumberSuffix(e.target.value);
                      setSendResult(null);
                    }}
                    placeholder="-SP for special offer"
                    className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                  />
                </label>
                <a
                  href={`https://qbo.intuit.com/app/invoice?txnId=${row.qbInvoice.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center gap-1 whitespace-nowrap rounded-md border border-default bg-base px-3 text-xs font-medium text-secondary hover:bg-elevated hover:text-primary"
                >
                  Preview in QBO ↗
                </a>
              </div>
            </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-secondary">
                <span className="font-medium">Terms</span>
                <select
                  value={selectedTermId}
                  onChange={(e) => {
                    setSelectedTermId(e.target.value);
                    setSendResult(null);
                  }}
                  className="rounded-md border border-default bg-base px-2 py-1 text-sm"
                >
                  <option value="">(keep existing)</option>
                  {terms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.dueDays !== null && t.dueDays !== undefined
                        ? ` (${t.dueDays}d)`
                        : ""}
                    </option>
                  ))}
                </select>
                {row.qbInvoice?.existingTermsName && (
                  <span className="text-[11px] text-muted">
                    current: {row.qbInvoice.existingTermsName}
                  </span>
                )}
              </label>
              <label className="flex items-center gap-2 text-xs text-secondary">
                <span className="font-medium">Discount %</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={discountPercent}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setDiscountPercent(Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);
                    setSendResult(null);
                  }}
                  className="w-20 rounded-md border border-default bg-base px-2 py-1 text-right text-sm tabular-nums"
                />
              </label>
              <div className="text-xs text-secondary">
                {summarize(editedActions)}
                {blockingAdds.length > 0 && (
                  <>
                    {" "}
                    · <span className="text-accent-warning">
                      {blockingAdds.length} add{blockingAdds.length > 1 ? "s" : ""} need price
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {sendResult && <SendResultPill result={sendResult} shadowMode={shadowMode} />}
              <Button
                variant="primary"
                size="sm"
                disabled={blockingAdds.length > 0 || sendMutation.isPending}
                onClick={() => sendMutation.mutate()}
              >
                {sendMutation.isPending
                  ? "Sending…"
                  : shadowMode
                    ? "Preview send"
                    : "Send to QBO"}
              </Button>
            </div>
          </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function summarize(actions: ReconcileAction[]): string {
  let keep = 0,
    qty = 0,
    add = 0;
  for (const a of actions) {
    if (a.type === "keep") keep++;
    else if (a.type === "qty_change") qty++;
    else if (a.type === "add") add++;
  }
  return `${keep} keep · ${qty} qty change · ${add} add`;
}

function SendResultPill({
  result,
  shadowMode,
}: {
  result: SendResult;
  shadowMode: boolean;
}) {
  if (!result.ok) return <Badge tone="critical">Failed: {result.error}</Badge>;
  if (result.status === "shadow") {
    return (
      <Badge tone="info">
        Shadow OK — payload prepared{shadowMode ? "" : ", but server reported shadow"}
      </Badge>
    );
  }
  // Live send. Compose label from the email step result.
  if (result.emailError) {
    return (
      <Badge tone="high">
        Updated, email failed: {result.emailError.slice(0, 60)}
      </Badge>
    );
  }
  if (result.email && result.email.sentTo) {
    return (
      <Badge tone="success">
        Sent to {result.email.sentTo} · {formatTime(result.email.sentAt)}
      </Badge>
    );
  }
  if (result.email) {
    return (
      <Badge tone="success">
        Updated + emailed · {formatTime(result.email.sentAt)}
      </Badge>
    );
  }
  return <Badge tone="success">Updated (no email)</Badge>;
}

// Search input with debounced QB Item lookup. Pick a row → fires onPick →
// caller appends an `add` action to the card's editedActions.
function AddLinePicker({ onPick }: { onPick: (item: QbItemSearchHit) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QbItemSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Debounced fetch — 250ms after the last keystroke.
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

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-default bg-base px-3 py-1.5 text-xs font-medium text-secondary hover:bg-elevated hover:text-primary"
        >
          + Add line
        </button>
        {open && (
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search QB items by SKU or name (min 2 chars)…"
            className="flex-1 rounded-md border border-default bg-base px-2 py-1.5 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                setQuery("");
                setResults([]);
              }
            }}
          />
        )}
      </div>
      {open && query.trim().length >= 2 && (
        <div className="absolute left-0 top-full z-10 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-default bg-base shadow-lg">
          {loading && (
            <div className="px-3 py-2 text-xs text-muted">Searching QB items…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">No matches.</div>
          )}
          {results.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onPick(item);
                setQuery("");
                setResults([]);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 border-b border-default px-3 py-2 text-left text-sm last:border-b-0 hover:bg-elevated"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{item.name}</div>
                {item.sku && (
                  <div className="font-mono text-xs text-muted">{item.sku}</div>
                )}
              </div>
              <div className="shrink-0 tabular-nums text-secondary">
                {item.unitPrice !== null ? `$${item.unitPrice.toFixed(2)}` : "—"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// $-prefixed price input. Displays "$" inside the field; submits/sends a
// pure number. Uses a controlled <input type="text"> so we can render the
// glyph without losing keystroke control.
function PriceInput({
  value,
  onChange,
  warning,
}: {
  value: number | null | undefined;
  onChange: (n: number) => void;
  warning?: boolean;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center overflow-hidden rounded-md border bg-base text-sm",
        warning ? "border-accent-warning" : "border-default",
      )}
    >
      <span className="border-r border-default bg-elevated px-2 py-1 text-xs text-muted">
        $
      </span>
      <input
        type="number"
        min={0}
        step={0.01}
        value={value ?? ""}
        placeholder="0.00"
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 bg-transparent px-2 py-1 text-right tabular-nums focus:outline-none"
      />
    </div>
  );
}

function SendHistoryPill({
  status,
  sentAt,
  to,
}: {
  status: string | null;
  sentAt: string | null;
  to: string | null;
}) {
  // QBO's EmailStatus is "EmailSent" once an email has gone out (any path —
  // 2.0 send, 1.0 send, manual click in QBO web admin). DeliveryInfo.DeliveryTime
  // is the UTC timestamp of the most recent send.
  if (status === "EmailSent" && sentAt) {
    return (
      <Badge tone="success">
        Last sent {formatTime(sentAt)}
        {to ? ` · ${to}` : ""}
      </Badge>
    );
  }
  if (status === "EmailSent") {
    return <Badge tone="success">Sent (timestamp unknown)</Badge>;
  }
  return <Badge tone="neutral">Not sent yet</Badge>;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function ReconcileTable({
  row,
  editedActions,
  onLineQtyChange,
  onLinePriceChange,
  onAddPriceChange,
  onAddQtyChange,
  onRemoveAddLine,
}: {
  row: Row;
  editedActions: ReconcileAction[];
  onLineQtyChange: (lineId: string, newQty: number) => void;
  onLinePriceChange: (lineId: string, originalPrice: number, newPrice: number) => void;
  onAddPriceChange: (sku: string, newPrice: number) => void;
  onAddQtyChange: (sku: string, newQty: number) => void;
  onRemoveAddLine: (sku: string) => void;
}) {
  if (!row.qbInvoice || !row.reconcileResult) return null;

  // Build SKU → Shopify retail price map for the read-only "Shopify price"
  // column. Falls back to undefined when the order isn't matched.
  const shopifyPriceBySku = new Map<string, number>();
  for (const li of row.shopifyOrder?.lineItems ?? []) {
    shopifyPriceBySku.set(li.sku.toUpperCase(), li.retailPrice);
  }

  type DisplayRow = {
    sku: string;
    itemName: string | null;
    currentQty: number | null;
    shippedQty: number | null;
    unitPrice: number | null;
    shopifyPrice: number | undefined;
    action: ReconcileAction | null;
  };
  const map = new Map<string, DisplayRow>();
  for (const line of row.qbInvoice.lines) {
    const key = (line.sku ?? "").toUpperCase();
    map.set(key, {
      sku: line.sku ?? "(no SKU)",
      itemName: line.itemName,
      currentQty: line.qty,
      shippedQty: null,
      unitPrice: line.unitPrice,
      shopifyPrice: shopifyPriceBySku.get(key),
      action: null,
    });
  }
  for (const item of row.parsed.lineItems) {
    const key = item.sku.toUpperCase();
    const qty = Number(item.quantity);
    const existing = map.get(key);
    if (existing) {
      existing.shippedQty = qty;
    } else {
      map.set(key, {
        sku: item.sku,
        itemName: null,
        currentQty: null,
        shippedQty: qty,
        unitPrice: null,
        shopifyPrice: shopifyPriceBySku.get(key),
        action: null,
      });
    }
  }
  for (const action of editedActions) {
    if (action.type === "set_metadata" || action.type === "keep") continue;
    const sku = action.type === "add" ? action.sku.toUpperCase() : action.sku.toUpperCase();
    const r = map.get(sku);
    if (r) {
      r.action = action;
    } else if (action.type === "add") {
      // QB-picker add: doesn't correspond to any invoice or shipment line.
      // Inject it so the user can see + edit it in the table.
      map.set(sku, {
        sku: action.sku,
        itemName: action.itemName ?? null,
        currentQty: null,
        shippedQty: null,
        unitPrice: action.unitPrice,
        shopifyPrice: shopifyPriceBySku.get(sku),
        action,
      });
    }
  }
  // keep actions inject themselves too (so badge renders)
  for (const action of editedActions) {
    if (action.type !== "keep") continue;
    const r = map.get(action.sku.toUpperCase());
    if (r) r.action = action;
  }

  const rows = Array.from(map.values());

  return (
    <div className="overflow-hidden rounded-md border border-default">
      <table className="w-full text-sm">
        <thead className="bg-elevated text-xs uppercase tracking-wide text-secondary">
          <tr>
            <th className="px-3 py-2 text-left">SKU</th>
            <th className="px-3 py-2 text-right">Invoice qty</th>
            <th className="px-3 py-2 text-right">Shipped qty</th>
            <th className="px-3 py-2 text-right">Final qty</th>
            <th className="px-3 py-2 text-right">Shopify price</th>
            <th className="px-3 py-2 text-right">QB price</th>
            <th className="px-3 py-2 text-left">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const action = r.action;
            const isQtyChange = action?.type === "qty_change";
            const isAdd = action?.type === "add";
            const isKeep = action?.type === "keep";
            const finalQty = isQtyChange
              ? action.toQty
              : isAdd
                ? action.qty
                : isKeep
                  ? action.qty
                  : (r.currentQty ?? 0);
            // QB price for display: add → action.unitPrice; qty_change with
            // override → that override; otherwise the original line price.
            const finalQbPrice = isAdd
              ? action.unitPrice
              : isQtyChange && action.unitPriceOverride !== undefined
                ? action.unitPriceOverride
                : r.unitPrice;
            const lineId = (action as { lineId?: string } | null)?.lineId;

            return (
              <tr key={r.sku} className="border-t border-default">
                <td className="px-3 py-2">
                  <div className="font-mono text-xs font-medium">{r.sku}</div>
                  {r.itemName && <div className="text-xs text-muted">{r.itemName}</div>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.currentQty ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.shippedQty ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {isAdd ? (
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={finalQty}
                      onChange={(e) => onAddQtyChange(action.sku, Number(e.target.value))}
                      className="w-20 rounded-md border border-default bg-base px-2 py-1 text-right text-sm tabular-nums"
                    />
                  ) : (isKeep || isQtyChange) && lineId ? (
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={finalQty}
                      onChange={(e) => onLineQtyChange(lineId, Number(e.target.value))}
                      className="w-20 rounded-md border border-default bg-base px-2 py-1 text-right text-sm tabular-nums"
                    />
                  ) : (
                    finalQty
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">
                  {r.shopifyPrice !== undefined
                    ? `$${r.shopifyPrice.toFixed(2)}`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {isAdd ? (
                    <PriceInput
                      value={finalQbPrice}
                      onChange={(n) => onAddPriceChange(action.sku, n)}
                      warning={finalQbPrice === null || finalQbPrice <= 0}
                    />
                  ) : (isKeep || isQtyChange) && lineId && r.unitPrice !== null ? (
                    <PriceInput
                      value={finalQbPrice}
                      onChange={(n) =>
                        onLinePriceChange(lineId, r.unitPrice as number, n)
                      }
                    />
                  ) : finalQbPrice !== null && finalQbPrice !== undefined ? (
                    `$${finalQbPrice.toFixed(2)}`
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <ActionBadge action={action} />
                    {isAdd && (
                      <button
                        type="button"
                        onClick={() => onRemoveAddLine(action.sku)}
                        title="Remove this added line"
                        className="rounded-md p-1 text-muted hover:bg-elevated hover:text-accent-danger"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="border-t border-default bg-elevated/30 px-3 py-2 text-xs text-secondary">
        <span className="font-medium">Header update:</span>{" "}
        Tracking <span className="font-mono">{row.parsed.trackingNumber}</span>
        {", "}
        ship via <span className="font-mono">{row.parsed.carrierShort}</span>
        {", "}
        ship date <span className="font-mono">{row.parsed.shipDate}</span>
        {row.qbInvoice.existingTrackingNum && (
          <span className="ml-2 text-accent-warning">
            (overwrites existing: {row.qbInvoice.existingTrackingNum})
          </span>
        )}
      </div>
    </div>
  );
}

function ActionBadge({ action }: { action: ReconcileAction | null }) {
  if (!action) return <span className="text-xs text-muted">—</span>;
  if (action.type === "keep") return <Badge tone="success">keep</Badge>;
  if (action.type === "qty_change") {
    const tone =
      action.reason === "not_shipped"
        ? "critical"
        : action.reason === "split_zero"
          ? "high"
          : action.reason === "shipped_less"
            ? "medium"
            : "info";
    // When only the price changed (qty unchanged), surface that distinctly
    // rather than showing "qty 5 → 5".
    if (
      action.reason === "price_change" &&
      action.fromQty === action.toQty &&
      action.unitPriceOverride !== undefined
    ) {
      return (
        <Badge tone="info">
          price → ${action.unitPriceOverride.toFixed(2)}
        </Badge>
      );
    }
    return (
      <Badge tone={tone}>
        qty {action.fromQty} → {action.toQty}
        {action.unitPriceOverride !== undefined && (
          <> · ${action.unitPriceOverride.toFixed(2)}</>
        )}
        <span className="ml-1 text-[10px] font-normal opacity-70">({action.reason})</span>
      </Badge>
    );
  }
  if (action.type === "add") {
    if (action.unitPrice === null || action.unitPrice <= 0) {
      return <Badge tone="high">add (needs price)</Badge>;
    }
    return <Badge tone="info">add @ ${action.unitPrice.toFixed(2)}</Badge>;
  }
  return null;
}
