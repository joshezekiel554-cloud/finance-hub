import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, Mail, MessageSquare, Package, Truck } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import ReturnReceiptReviewDialog, {
  type ReceiptRow,
} from "../components/return-receipt-review-dialog";
import RmaCreditMemoDialog from "../components/rma-credit-memo-dialog";

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
      // Drop the line entirely — default for "SKU on invoice but not
      // in shipment". Operator can switch this to qty_change → 0 on
      // the form for split-shipment audit (see "keep at qty 0" toggle).
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
  receiptRows?: ReceiptRow[];
  dismissed: Record<string, DismissedRecord>;
  shadowMode: boolean;
};
type Term = { id: string; name: string; dueDays: number | null };
type TermsResponse = { terms: Term[] };

const REASON_LABELS: Record<DismissReason, string> = {
  b2c_paid_upfront: "B2C / paid upfront",
  etsy_faire: "Etsy / Faire",
  other: "Other",
};

type Tab = "open" | "unparseable" | "sent" | "dismissed";

// Single source of truth for which tab a row belongs in. Priority order:
//   1. Dismissed wins (a dismissed row stays under Dismissed regardless).
//   2. Already-sent rows live in Sent (matches QBO EmailStatus).
//   3. Low-confidence parses go to Unparseable so the Open tab is just
//      actionable shipment emails.
//   4. Everything else is Open.
function classifyRow(
  row: Row,
  dismissed: Record<string, DismissedRecord>,
): Tab {
  if (dismissed[row.gmailId]) return "dismissed";
  if (row.qbInvoice?.emailStatus === "EmailSent") return "sent";
  if (row.parseConfidence < 0.5) return "unparseable";
  return "open";
}

export default function InvoicingTodayPage() {
  const [tab, setTab] = useState<Tab>("open");
  const queryClient = useQueryClient();
  const [reviewReceipt, setReviewReceipt] = useState<ReceiptRow | null>(null);
  // After the operator clicks "Continue to credit memo" in the receipt
  // dialog, the receipt closes and we open the shared RmaCreditMemoDialog
  // for the matched RMA. Stored as { rmaId, customerId } so the dialog has
  // what it needs without an extra fetch.
  const [creditMemoTarget, setCreditMemoTarget] = useState<{
    rmaId: string;
    customerId: string;
  } | null>(null);

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
          <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
          <p className="mt-1 text-sm text-secondary">
            Feldart's pending workload — orders to ship out and returns
            received from the warehouse, last 7 days.
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

      {/* ──────────────── Orders section ────────────────────────────── */}
      {data && (
        <section className="space-y-3">
          <SectionHeader
            title="Orders"
            subtitle="Shipment notifications matched to QBO invoices + Shopify orders. Reconcile and send the invoice email."
            count={
              data.rows.filter((r) => classifyRow(r, data.dismissed) === "open")
                .length
            }
          />
          <Summary rows={data.rows} dismissed={data.dismissed} />
          <div className="flex items-center justify-between">
            <TabToggle
              tab={tab}
              onChange={setTab}
              counts={{
                open: data.rows.filter(
                  (r) => classifyRow(r, data.dismissed) === "open",
                ).length,
                unparseable: data.rows.filter(
                  (r) => classifyRow(r, data.dismissed) === "unparseable",
                ).length,
                sent: data.rows.filter(
                  (r) => classifyRow(r, data.dismissed) === "sent",
                ).length,
                dismissed: data.rows.filter(
                  (r) => classifyRow(r, data.dismissed) === "dismissed",
                ).length,
              }}
            />
            {tab === "unparseable" && (
              <BulkDismissButton
                candidateGmailIds={data.rows
                  .filter(
                    (r) => classifyRow(r, data.dismissed) === "unparseable",
                  )
                  .map((r) => r.gmailId)}
              />
            )}
          </div>
          {data.rows.length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-sm text-secondary">
                  No shipment notifications in the last 7 days.
                </p>
              </CardBody>
            </Card>
          ) : (
            data.rows
              .filter((r) => classifyRow(r, data.dismissed) === tab)
              .map((row) =>
                tab === "unparseable" ? (
                  <UnparseableCard key={row.gmailId} row={row} />
                ) : (
                  <ShipmentCard
                    key={row.gmailId}
                    row={row}
                    shadowMode={data.shadowMode}
                    terms={terms}
                    dismissedRecord={data.dismissed[row.gmailId] ?? null}
                  />
                ),
              )
          )}
        </section>
      )}

      {/* ──────────────── Returns section ───────────────────────────── */}
      {data && (
        <section className="space-y-3 border-t border-default pt-6">
          <SectionHeader
            title="Returns received"
            subtitle="Bluechip warehouse-receipt notifications waiting for you to review and (when matched) issue the credit memo."
            count={(data.receiptRows ?? []).length}
          />
          {(data.receiptRows ?? []).length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-sm text-secondary">
                  No pending return receipts. Confirmed receipts are visible
                  on the matched RMA via{" "}
                  <Link
                    to="/returns"
                    className="text-accent-primary underline-offset-2 hover:underline"
                  >
                    /returns
                  </Link>
                  .
                </p>
              </CardBody>
            </Card>
          ) : (
            (data.receiptRows ?? []).map((receipt) => (
              <ReceiptRowCard
                key={receipt.receiptId}
                receipt={receipt}
                onReview={() => setReviewReceipt(receipt)}
              />
            ))
          )}
        </section>
      )}

      {/* Receipt review dialog */}
      {reviewReceipt && (
        <ReturnReceiptReviewDialog
          open={reviewReceipt !== null}
          onOpenChange={(next) => {
            if (!next) setReviewReceipt(null);
          }}
          receipt={reviewReceipt}
          onDone={() => {
            setReviewReceipt(null);
            void queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
          }}
          onContinueToCreditMemo={(target) => {
            setReviewReceipt(null);
            setCreditMemoTarget(target);
          }}
        />
      )}

      {/* Credit memo dialog — opened after the receipt review hands off.
          Uses the same shared dialog the wizard does, so sales tax checkbox
          and QBO PDF auto-attach are available here too. */}
      {creditMemoTarget && (
        <RmaCreditMemoDialog
          open={creditMemoTarget !== null}
          onOpenChange={(next) => {
            if (!next) setCreditMemoTarget(null);
          }}
          rmaId={creditMemoTarget.rmaId}
          customerId={creditMemoTarget.customerId}
          onIssued={() => {
            setCreditMemoTarget(null);
            void queryClient.invalidateQueries({
              queryKey: ["invoicing", "today"],
            });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReceiptRowCard — compact card for a return_receipt row on /today
// ---------------------------------------------------------------------------

function ReceiptRowCard({
  receipt,
  onReview,
}: {
  receipt: ReceiptRow;
  onReview: () => void;
}) {
  const matchBadgeTone =
    receipt.matchKind === "exact_tx_number" || receipt.matchKind === "exact_ref_string"
      ? ("success" as const)
      : receipt.matchKind === "fuzzy_customer_sku"
        ? ("high" as const)
        : ("neutral" as const);

  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">
                {receipt.rma?.customerName ?? receipt.inferredCustomerName ?? "Unmatched receipt"}
              </span>
              <Badge tone={matchBadgeTone} className="text-xs">
                {receipt.matchKind === "no_match"
                  ? "Unmatched"
                  : receipt.rma?.rmaNumber ?? "Matched"}
              </Badge>
            </div>
            <div className="text-xs text-secondary space-x-2">
              {receipt.txNumber && <span>TX# {receipt.txNumber}</span>}
              {receipt.refString && <span>Ref: {receipt.refString}</span>}
              <span>{receipt.parsedItems.length} item(s)</span>
              <span>
                Received {new Date(receipt.classifiedAt).toLocaleDateString()}
              </span>
            </div>
            {receipt.parsedItems.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {receipt.parsedItems.slice(0, 5).map((p) => (
                  <span
                    key={p.sku}
                    className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs font-mono"
                  >
                    {p.sku} ×{p.quantity}
                  </span>
                ))}
                {receipt.parsedItems.length > 5 && (
                  <span className="text-xs text-secondary">
                    +{receipt.parsedItems.length - 5} more
                  </span>
                )}
              </div>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={onReview}>
            Review
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function BulkDismissButton({
  candidateGmailIds,
}: {
  candidateGmailIds: string[];
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/invoicing/dismiss-bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gmailIds: candidateGmailIds,
          reason: "etsy_faire",
          reasonNote: "bulk-dismissed unparseable WMS noise",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["invoicing", "today"] });
      const prev = queryClient.getQueryData<ApiResponse>(["invoicing", "today"]);
      if (prev) {
        const next = { ...prev.dismissed };
        const now = new Date().toISOString();
        for (const id of candidateGmailIds) {
          next[id] = {
            reason: "etsy_faire",
            reasonNote: "bulk-dismissed unparseable WMS noise",
            dismissedAt: now,
          };
        }
        queryClient.setQueryData<ApiResponse>(["invoicing", "today"], {
          ...prev,
          dismissed: next,
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev)
        queryClient.setQueryData(["invoicing", "today"], ctx.prev);
    },
    onSettled: () => setConfirmOpen(false),
  });

  if (candidateGmailIds.length === 0) return null;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmOpen((v) => !v)}
      >
        Bulk dismiss unparseable ({candidateGmailIds.length})
      </Button>
      {confirmOpen && (
        <div className="absolute right-0 top-full z-10 mt-1 w-72 rounded-md border border-default bg-base p-3 text-xs shadow-lg">
          <p className="text-secondary">
            Dismiss <strong>{candidateGmailIds.length}</strong> shipments that
            don't parse as Feldart shipment notifications? They'll move to the
            Dismissed tab with reason "Etsy / Faire (unparseable)".
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={bulkMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => bulkMutation.mutate()}
              disabled={bulkMutation.isPending}
            >
              {bulkMutation.isPending ? "Dismissing…" : "Confirm"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  count,
}: {
  title: string;
  subtitle?: string;
  count?: number;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          {title}
          {typeof count === "number" && (
            <span className="ml-2 text-sm font-normal text-muted">
              ({count})
            </span>
          )}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-xs text-secondary">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

function TabToggle({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: Record<Tab, number>;
}) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "unparseable", label: "Unparseable" },
    { key: "sent", label: "Sent" },
    { key: "dismissed", label: "Dismissed" },
  ];
  return (
    <div className="inline-flex rounded-md border border-default bg-subtle p-0.5 text-sm">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cn(
            "rounded px-3 py-1 transition-colors",
            tab === t.key
              ? "bg-base font-medium text-primary shadow-sm"
              : "text-secondary hover:text-primary",
          )}
        >
          {t.label} ({counts[t.key]})
        </button>
      ))}
    </div>
  );
}

function Summary({
  rows,
  dismissed,
}: {
  rows: Row[];
  dismissed: Record<string, DismissedRecord>;
}) {
  const visible = rows.filter((r) => !dismissed[r.gmailId]);
  const ready = visible.filter((r) => r.reconcileResult !== null);
  const lowConfidence = visible.filter((r) => r.parseConfidence < 0.5);
  const missingInvoice = visible.filter(
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

// UnparseableCard — shown on the "Unparseable" tab. Email couldn't be
// parsed as a Feldart shipment notification (low confidence) so we don't
// have shipment / invoice / Shopify fields to render. Surfaces what we
// know — gmail id, received-at, missing fields — and offers a Gmail link
// + Dismiss action so the operator can clear the row from the queue.
function UnparseableCard({ row }: { row: Row }) {
  const queryClient = useQueryClient();
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss(): Promise<void> {
    setDismissing(true);
    setError(null);
    try {
      const res = await fetch("/api/invoicing/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gmailId: row.gmailId,
          reason: "other",
          reasonNote: "unparseable / not a shipment email",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void queryClient.invalidateQueries({
        queryKey: ["invoicing", "today"],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dismiss failed");
    } finally {
      setDismissing(false);
    }
  }

  const receivedLabel = row.receivedAt
    ? new Date(row.receivedAt).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "(no received date)";

  const [showFullBody, setShowFullBody] = useState(false);
  const bodyTruncated = row.emailBody.length > 800;
  const visibleBody = showFullBody
    ? row.emailBody
    : row.emailBody.slice(0, 800);

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-0.5 min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="neutral">Unparseable</Badge>
              <span className="text-secondary">{receivedLabel}</span>
              <span className="text-muted text-xs">
                confidence {(row.parseConfidence * 100).toFixed(0)}%
              </span>
            </div>
            {row.emailSubject && (
              <div className="text-sm font-medium truncate">
                {row.emailSubject}
              </div>
            )}
            {row.emailFrom && (
              <div className="text-xs text-secondary truncate">
                From: {row.emailFrom}
              </div>
            )}
            {row.parseMissingFields.length > 0 && (
              <div className="text-xs text-muted">
                Missing: {row.parseMissingFields.join(", ")}
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <a
              href={`https://mail.google.com/mail/u/0/#all/${row.gmailId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-default bg-base px-2 py-1 text-xs text-secondary hover:bg-elevated"
            >
              <Mail className="size-3" />
              Open in Gmail
            </a>
            <Button
              variant="secondary"
              size="sm"
              disabled={dismissing}
              loading={dismissing}
              onClick={() => void dismiss()}
            >
              Dismiss
            </Button>
          </div>
        </div>
        {/* Body preview — operator can read enough to decide without
            jumping to Gmail. Truncated at 800 chars with show-more. */}
        {row.emailBody && (
          <div className="rounded-md border border-default bg-subtle/40 px-3 py-2">
            <pre className="whitespace-pre-wrap break-words text-xs text-secondary font-sans leading-relaxed">
              {visibleBody}
              {!showFullBody && bodyTruncated ? "…" : ""}
            </pre>
            {bodyTruncated && (
              <button
                type="button"
                onClick={() => setShowFullBody((v) => !v)}
                className="mt-1 text-xs text-accent-primary hover:underline"
              >
                {showFullBody ? "Show less" : "Show full email"}
              </button>
            )}
          </div>
        )}
        {!row.emailBody && (
          <p className="text-xs text-muted italic">
            No plain-text body captured. Open in Gmail to read.
          </p>
        )}
        {error && (
          <div className="text-xs text-accent-danger">{error}</div>
        )}
      </CardBody>
    </Card>
  );
}

function ShipmentCard({
  row,
  shadowMode,
  terms,
  dismissedRecord,
}: {
  row: Row;
  shadowMode: boolean;
  terms: Term[];
  dismissedRecord: DismissedRecord | null;
}) {
  // Low-confidence rows still render in the dismissed tab if they were
  // dismissed manually. Hide from the active tab as before.
  if (row.parseConfidence < 0.5 && !dismissedRecord) return null;

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
  // Email override state. Defaults to the QBO invoice's existing values so
  // editing starts from the truth and the user only changes what they need.
  const [billEmailTo, setBillEmailTo] = useState<string>(
    row.qbInvoice?.billEmail ?? "",
  );
  const [billEmailCc, setBillEmailCc] = useState<string>(
    row.qbInvoice?.billEmailCc ?? "",
  );
  const [billEmailBcc, setBillEmailBcc] = useState<string>(
    row.qbInvoice?.billEmailBcc ?? "",
  );
  const [emailExpanded, setEmailExpanded] = useState<boolean>(false);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);

  const queryClient = useQueryClient();

  const [showDismissForm, setShowDismissForm] = useState(false);
  const [dismissReason, setDismissReason] = useState<DismissReason>("etsy_faire");
  const [dismissNote, setDismissNote] = useState("");

  const dismissMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/invoicing/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gmailId: row.gmailId,
          reason: dismissReason,
          reasonNote: dismissReason === "other" ? dismissNote.trim() || undefined : undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // Optimistic: write the dismissal into the cached query immediately so
    // the card vanishes from the active tab without a full refetch. On
    // error, the snapshot is restored.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["invoicing", "today"] });
      const prev = queryClient.getQueryData<ApiResponse>(["invoicing", "today"]);
      if (prev) {
        queryClient.setQueryData<ApiResponse>(["invoicing", "today"], {
          ...prev,
          dismissed: {
            ...prev.dismissed,
            [row.gmailId]: {
              reason: dismissReason,
              reasonNote:
                dismissReason === "other" ? dismissNote.trim() || null : null,
              dismissedAt: new Date().toISOString(),
            },
          },
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev)
        queryClient.setQueryData(["invoicing", "today"], ctx.prev);
    },
    onSuccess: () => {
      setShowDismissForm(false);
      setDismissNote("");
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
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["invoicing", "today"] });
      const prev = queryClient.getQueryData<ApiResponse>(["invoicing", "today"]);
      if (prev) {
        const next = { ...prev.dismissed };
        delete next[row.gmailId];
        queryClient.setQueryData<ApiResponse>(["invoicing", "today"], {
          ...prev,
          dismissed: next,
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev)
        queryClient.setQueryData(["invoicing", "today"], ctx.prev);
    },
  });

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
          docType: row.qbInvoice.docType,
          expectedSyncToken: row.qbInvoice.syncToken,
          actions: editedActions,
          discountPercent: discountPercent > 0 ? discountPercent : undefined,
          salesTermId: selectedTerm?.id,
          salesTermName: selectedTerm?.name,
          customerMemo: customerMemo.trim() || undefined,
          docNumberSuffix: docNumberSuffix.trim() || undefined,
          // Only send overrides when the user changed them from the QBO
          // values; otherwise leave the invoice alone.
          billEmailTo:
            billEmailTo.trim() &&
            billEmailTo.trim() !== (row.qbInvoice?.billEmail ?? "")
              ? billEmailTo.trim()
              : undefined,
          billEmailCc:
            billEmailCc.trim() &&
            billEmailCc.trim() !== (row.qbInvoice?.billEmailCc ?? "")
              ? billEmailCc.trim()
              : undefined,
          billEmailBcc:
            billEmailBcc.trim() &&
            billEmailBcc.trim() !== (row.qbInvoice?.billEmailBcc ?? "")
              ? billEmailBcc.trim()
              : undefined,
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

  // Edit the final qty for an existing invoice line. Handles every
  // transition between keep / qty_change / remove based on what the
  // operator types:
  //   keep        + same qty            → keep
  //   keep        + new qty             → qty_change (user_override)
  //   qty_change  + matches original    → keep
  //   qty_change  + new qty             → qty_change (toQty updated)
  //   remove      + matches original    → keep (operator overruled the remove)
  //   remove      + 0                   → qty_change → 0 (preserve at 0,
  //                                       e.g. split-shipment audit)
  //   remove      + any other qty       → qty_change to that qty
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
        if (a.type === "remove" && a.lineId === lineId) {
          if (newQty === a.qty) {
            return {
              type: "keep",
              lineId: a.lineId,
              sku: a.sku,
              qty: a.qty,
            };
          }
          return {
            type: "qty_change",
            lineId: a.lineId,
            sku: a.sku,
            fromQty: a.qty,
            toQty: newQty,
            reason: "user_override",
          };
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
    <Card className={cn(dismissedRecord && "opacity-60")}>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Truck className="size-4 text-muted" />
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                <span>
                  {po} → {customer}
                </span>
                {row.qbInvoice ? (
                  <CustomerReassignControl row={row} />
                ) : null}
              </div>
              <div className="text-xs text-secondary">
                Feldart Tx #{row.parsed.transactionNumber} · {row.parsed.carrierShort} ·{" "}
                {row.parsed.trackingNumber} · ship date {row.parsed.shipDate}
              </div>
              {dismissedRecord && (
                <div className="mt-1 text-xs">
                  <Badge tone="neutral">
                    Dismissed: {REASON_LABELS[dismissedRecord.reason]}
                    {dismissedRecord.reasonNote ? ` — ${dismissedRecord.reasonNote}` : ""}
                  </Badge>
                </div>
              )}
            </div>
          </div>
          {row.qbInvoice ? (
            <div className="text-right">
              <div className="flex items-center justify-end gap-2 text-xs text-secondary">
                {row.qbInvoice.docType === "salesreceipt" ? (
                  <Badge tone="info">Sales Receipt</Badge>
                ) : null}
                <span>
                  QB{" "}
                  {row.qbInvoice.docType === "salesreceipt"
                    ? "receipt"
                    : "invoice"}
                </span>
              </div>
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
              {row.qbInvoice.docType === "salesreceipt" &&
              row.reconcileResult &&
              hasRefundShortage(row.reconcileResult.actions) ? (
                <div className="mt-2 space-y-1">
                  <div className="rounded-md border border-accent-danger/30 bg-accent-danger/10 px-2 py-1 text-left text-[11px] text-accent-danger">
                    Refund needed — customer paid for items not shipped.
                    Refund via Shopify.
                  </div>
                  <RefundTaskButton row={row} />
                </div>
              ) : null}
            </div>
          ) : (
            <Badge tone="critical">No QB invoice</Badge>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {dismissedRecord ? (
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs text-secondary">
              Dismissed{" "}
              {formatTime(dismissedRecord.dismissedAt)}. This shipment is hidden
              from the active list.
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => restoreMutation.mutate()}
              disabled={restoreMutation.isPending}
            >
              {restoreMutation.isPending ? "Restoring…" : "Restore"}
            </Button>
          </div>
        ) : showDismissForm ? (
          <DismissForm
            reason={dismissReason}
            note={dismissNote}
            onChangeReason={setDismissReason}
            onChangeNote={setDismissNote}
            onCancel={() => setShowDismissForm(false)}
            onConfirm={() => dismissMutation.mutate()}
            pending={dismissMutation.isPending}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* B2C-paid-upfront sales receipts are filtered server-side
                (their row has no qbInvoice but qbInvoiceError flags
                them). 99% of those want a one-click "B2C dismiss" —
                surface the quick button so the operator doesn't have
                to open the form + pick the reason every time. */}
            {isHiddenSalesReceipt(row.qbInvoiceError) ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={dismissMutation.isPending}
                loading={dismissMutation.isPending}
                onClick={() => {
                  setDismissReason("b2c_paid_upfront");
                  setDismissNote("");
                  // Use rAF so the state update lands before mutate
                  // reads dismissReason via closure.
                  requestAnimationFrame(() => dismissMutation.mutate());
                }}
                title="Dismiss as B2C / paid upfront on Shopify"
              >
                Dismiss (B2C paid upfront)
              </Button>
            ) : null}
            <button
              type="button"
              onClick={() => setShowDismissForm(true)}
              className="text-xs text-secondary hover:text-accent-danger underline-offset-2 hover:underline"
            >
              Dismiss this shipment
            </button>
          </div>
        )}

        {!dismissedRecord && (
          <>
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
            <EmailRecipients
              defaultTo={row.qbInvoice?.billEmail ?? ""}
              defaultCc={row.qbInvoice?.billEmailCc ?? ""}
              defaultBcc={row.qbInvoice?.billEmailBcc ?? ""}
              billEmailTo={billEmailTo}
              billEmailCc={billEmailCc}
              billEmailBcc={billEmailBcc}
              expanded={emailExpanded}
              onToggle={() => setEmailExpanded((v) => !v)}
              onChangeTo={(v) => {
                setBillEmailTo(v);
                setSendResult(null);
              }}
              onChangeCc={(v) => {
                setBillEmailCc(v);
                setSendResult(null);
              }}
              onChangeBcc={(v) => {
                setBillEmailBcc(v);
                setSendResult(null);
              }}
            />
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
          </>
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

function DismissForm({
  reason,
  note,
  onChangeReason,
  onChangeNote,
  onCancel,
  onConfirm,
  pending,
}: {
  reason: DismissReason;
  note: string;
  onChangeReason: (r: DismissReason) => void;
  onChangeNote: (n: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <div className="rounded-md border border-accent-warning/40 bg-accent-warning/5 px-3 py-3">
      <div className="text-xs font-medium text-accent-warning">
        Dismiss this shipment from the active list?
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        <label className="text-xs text-secondary">
          <span className="mb-1 block font-medium">Reason</span>
          <select
            value={reason}
            onChange={(e) => onChangeReason(e.target.value as DismissReason)}
            className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
          >
            <option value="b2c_paid_upfront">B2C / paid upfront</option>
            <option value="etsy_faire">Etsy / Faire</option>
            <option value="other">Other</option>
          </select>
        </label>
        {reason === "other" && (
          <label className="text-xs text-secondary">
            <span className="mb-1 block font-medium">Reason note (optional)</span>
            <input
              type="text"
              value={note}
              onChange={(e) => onChangeNote(e.target.value)}
              placeholder="e.g. wholesale not yet billed"
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? "Dismissing…" : "Confirm dismiss"}
        </Button>
      </div>
    </div>
  );
}

// Email recipient block — shows the current BillEmail in collapsed form
// with optional expansion to add CC, BCC, or override the To. Tracks
// whether each value differs from the QBO default so the parent can
// only send overrides when something actually changed.
function EmailRecipients({
  defaultTo,
  defaultCc,
  defaultBcc,
  billEmailTo,
  billEmailCc,
  billEmailBcc,
  expanded,
  onToggle,
  onChangeTo,
  onChangeCc,
  onChangeBcc,
}: {
  defaultTo: string;
  defaultCc: string;
  defaultBcc: string;
  billEmailTo: string;
  billEmailCc: string;
  billEmailBcc: string;
  expanded: boolean;
  onToggle: () => void;
  onChangeTo: (v: string) => void;
  onChangeCc: (v: string) => void;
  onChangeBcc: (v: string) => void;
}) {
  const toChanged = billEmailTo.trim() !== defaultTo.trim();
  const ccChanged = billEmailCc.trim() !== defaultCc.trim();
  const bccChanged = billEmailBcc.trim() !== defaultBcc.trim();
  const anyChanged = toChanged || ccChanged || bccChanged;

  return (
    <div className="rounded-md border border-default px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs text-secondary">
          <span className="font-medium">Sending to:</span>{" "}
          {billEmailTo ? (
            <span className="font-mono">{billEmailTo}</span>
          ) : (
            <span className="text-accent-warning">no BillEmail set</span>
          )}
          {billEmailCc && (
            <>
              {" · "}
              <span className="font-medium">CC:</span>{" "}
              <span className="font-mono">{billEmailCc}</span>
            </>
          )}
          {billEmailBcc && (
            <>
              {" · "}
              <span className="font-medium">BCC:</span>{" "}
              <span className="font-mono">{billEmailBcc}</span>
            </>
          )}
          {anyChanged && (
            <span className="ml-2 text-accent-warning">(modified)</span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="text-xs text-secondary hover:text-primary underline-offset-2 hover:underline"
        >
          {expanded ? "Done" : "Edit recipients"}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
          <label className="text-xs text-secondary">
            <span className="mb-1 block font-medium">To</span>
            <input
              type="email"
              value={billEmailTo}
              onChange={(e) => onChangeTo(e.target.value)}
              placeholder={defaultTo || "buyer@example.com"}
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-secondary">
            <span className="mb-1 block font-medium">CC</span>
            <input
              type="text"
              value={billEmailCc}
              onChange={(e) => onChangeCc(e.target.value)}
              placeholder="comma-separated"
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-secondary">
            <span className="mb-1 block font-medium">BCC</span>
            <input
              type="text"
              value={billEmailBcc}
              onChange={(e) => onChangeBcc(e.target.value)}
              placeholder="comma-separated"
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>
        </div>
      )}
    </div>
  );
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

  // SalesReceipts are settled — customer paid for these lines, we
  // can't change qty or unit price retroactively. The reconciler's
  // shortage actions are advisory only (drive the "Refund needed"
  // pill + a refund task), and the server ignores them on send. So
  // the table renders read-only on receipts: numbers shown as plain
  // text, not editable inputs.
  const isReadOnly = row.qbInvoice.docType === "salesreceipt";

  // Build SKU → Shopify per-unit paid price map for the read-only
  // "Shopify price" column (= the price the customer actually pays
  // on this order, after line-level discounts, pre-tax).
  const shopifyPriceBySku = new Map<string, number>();
  for (const li of row.shopifyOrder?.lineItems ?? []) {
    shopifyPriceBySku.set(li.sku.toUpperCase(), li.paidPrice);
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
            const isRemove = action?.type === "remove";
            const finalQty = isQtyChange
              ? action.toQty
              : isAdd
                ? action.qty
                : isKeep
                  ? action.qty
                  : isRemove
                    ? 0
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
                  {isReadOnly ? (
                    <span className="tabular-nums text-muted">{finalQty}</span>
                  ) : isAdd ? (
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={finalQty}
                      onChange={(e) => onAddQtyChange(action.sku, Number(e.target.value))}
                      className="w-20 rounded-md border border-default bg-base px-2 py-1 text-right text-sm tabular-nums"
                    />
                  ) : (isKeep || isQtyChange || isRemove) && lineId ? (
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
                  {isReadOnly ? (
                    finalQbPrice !== null && finalQbPrice !== undefined ? (
                      <span className="tabular-nums text-muted">
                        ${finalQbPrice.toFixed(2)}
                      </span>
                    ) : (
                      "—"
                    )
                  ) : isAdd ? (
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
  if (action.type === "remove") {
    return (
      <Badge tone="critical">
        remove (was qty {action.qty})
      </Badge>
    );
  }
  return null;
}

// Detect the "matched a SalesReceipt but the customer is B2C, so we
// hid the doc" case from the qbInvoiceError string. Server-side
// resolveLookups on /api/invoicing/today emits this exact phrase
// when filtering — see src/server/routes/invoicing.ts. Stringly-
// typed but stable; if the phrasing ever changes, both ends update
// together via this helper.
function isHiddenSalesReceipt(err: string | null): boolean {
  return err !== null && /paid upfront sales receipt/i.test(err);
}

// True when the actions include any "shortage" — line removed or qty
// reduced. Used on SalesReceipt rows to decide whether to surface
// the "Refund needed" pill (customer paid for items they didn't get).
function hasRefundShortage(actions: ReconcileAction[]): boolean {
  return actions.some(
    (a) =>
      a.type === "remove" ||
      (a.type === "qty_change" && a.toQty < a.fromQty),
  );
}

// One-click "create a refund task" affordance for SalesReceipt rows
// flagged as needing a refund. Opens a task in the operator's queue
// with the customer linked, the receipt referenced, and a body
// summarising what was paid vs shipped — so somebody actually
// actions the Shopify refund instead of the warning pill being
// noticed-then-forgotten.
function RefundTaskButton({ row }: { row: Row }) {
  const [created, setCreated] = useState<{ id: string } | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation<{ task: { id: string } }, Error>({
    mutationFn: async () => {
      if (!row.qbInvoice) throw new Error("no qb doc on row");
      if (!row.qbInvoice.customerId) {
        throw new Error("customer not linked in finance-hub");
      }
      const body = buildRefundTaskBody(row);
      const title = buildRefundTaskTitle(row);
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: row.qbInvoice.customerId,
          title,
          body,
          priority: "high",
          tags: ["refund"],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setCreated({ id: data.task.id });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  if (created) {
    return (
      <div className="text-[11px] text-accent-success">
        Refund task created.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="secondary"
        onClick={() => mutation.mutate()}
        disabled={
          mutation.isPending || !row.qbInvoice?.customerId
        }
        loading={mutation.isPending}
        title={
          row.qbInvoice?.customerId
            ? "Create a high-priority task to track the refund"
            : "Customer not linked in finance-hub — sync first"
        }
      >
        Create refund task
      </Button>
      {mutation.isError ? (
        <div className="text-[11px] text-accent-danger">
          {(mutation.error as Error).message}
        </div>
      ) : null}
    </div>
  );
}

function buildRefundTaskTitle(row: Row): string {
  const docNumber = row.qbInvoice?.docNumber ?? "(no doc#)";
  const customer =
    row.qbInvoice?.customerName ??
    row.shopifyOrder?.customerEmail ??
    "(unknown customer)";
  return `Refund ${customer} — SR ${docNumber}`;
}

function buildRefundTaskBody(row: Row): string {
  const lines: string[] = [];
  lines.push(
    "Customer paid upfront on Shopify but warehouse shipment was short.",
  );
  if (row.qbInvoice?.docNumber) {
    lines.push(`QBO Sales Receipt: ${row.qbInvoice.docNumber}`);
  }
  if (row.shopifyOrder?.name) {
    lines.push(`Shopify order: ${row.shopifyOrder.name}`);
  }
  if (row.parsed.trackingNumber) {
    lines.push(`Warehouse tracking: ${row.parsed.trackingNumber}`);
  }
  lines.push("");
  lines.push("Short / missing items:");
  const actions = row.reconcileResult?.actions ?? [];
  for (const a of actions) {
    if (a.type === "remove") {
      lines.push(`  • ${a.sku} — ordered+paid ${a.qty}, shipped 0`);
    } else if (a.type === "qty_change" && a.toQty < a.fromQty) {
      lines.push(
        `  • ${a.sku} — ordered+paid ${a.fromQty}, shipped ${a.toQty} (short ${a.fromQty - a.toQty})`,
      );
    }
  }
  lines.push("");
  lines.push("Action: issue refund via Shopify for the short items.");
  return lines.join("\n");
}

// "Change customer" affordance for the row header. The Shopify→QBO
// auto-create occasionally lands an order on a duplicate / OLD2 /
// renamed customer in QBO, and the operator's old fix was to edit
// in QBO directly. This control PATCHes Customer.Ref on the QBO
// doc and invalidates /api/invoicing/today so the row re-renders
// with the new customer's data — including the per-channel email
// pre-fill from the new customer's invoice_to_emails / cc / bcc.
function CustomerReassignControl({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const queryClient = useQueryClient();

  // Debounce the typed query so we don't hammer /api/customers on every
  // keystroke. 200 ms is the GA standard for type-ahead.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(id);
  }, [query]);

  type CustomerHit = {
    id: string;
    qbCustomerId: string | null;
    displayName: string;
    customerType: "b2b" | "b2c" | null;
  };
  type CustomersResponse = { rows: CustomerHit[] };

  const search = useQuery<CustomersResponse>({
    enabled: open && debounced.trim().length >= 2,
    queryKey: ["customers-search", debounced],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers?q=${encodeURIComponent(debounced.trim())}&customerType=all&limit=20`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const reassign = useMutation<
    { docType: string; id: string; newSyncToken: string },
    Error,
    CustomerHit
  >({
    mutationFn: async (hit) => {
      if (!row.qbInvoice) throw new Error("no qb doc on row");
      if (!hit.qbCustomerId) {
        throw new Error("picked customer has no qbCustomerId");
      }
      const res = await fetch("/api/invoicing/reassign-customer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceId: row.qbInvoice.id,
          docType: row.qbInvoice.docType,
          expectedSyncToken: row.qbInvoice.syncToken,
          newQbCustomerId: hit.qbCustomerId,
          newCustomerName: hit.displayName,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let body: { error?: string } | null = null;
        try {
          body = JSON.parse(text) as { error?: string };
        } catch {
          /* not json */
        }
        throw new Error(body?.error ?? text ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      // Refetch the whole today list — this row plus everything else
      // (the new customer's data needs to flow into the recipient
      // pre-fill, etc.). Cheap; cache stale time keeps it brief.
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      setOpen(false);
      setQuery("");
    },
  });

  const currentName = row.qbInvoice?.customerName ?? "";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-default bg-base px-1.5 py-0.5 text-[10px] font-medium text-secondary hover:bg-elevated hover:text-primary"
        title="Reassign this doc to a different customer in QuickBooks"
      >
        change
      </button>
    );
  }

  const rows = search.data?.rows ?? [];

  return (
    <div className="relative inline-flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`search… (currently: ${currentName.slice(0, 30)})`}
          className="w-72 rounded-md border border-default bg-base px-2 py-1 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setQuery("");
            }
          }}
        />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setQuery("");
          }}
          className="rounded-md border border-default bg-base px-1.5 py-0.5 text-[10px] text-muted hover:bg-elevated hover:text-primary"
        >
          cancel
        </button>
      </div>
      {open && debounced.trim().length >= 2 ? (
        <div className="absolute left-0 top-full z-10 mt-1 max-h-72 w-96 overflow-y-auto rounded-md border border-default bg-base shadow-lg">
          {search.isPending ? (
            <div className="px-3 py-2 text-xs text-muted">Searching…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">No matches.</div>
          ) : (
            <ul className="divide-y divide-default">
              {rows.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    disabled={reassign.isPending || !hit.qbCustomerId}
                    onClick={() => reassign.mutate(hit)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-elevated disabled:opacity-50"
                  >
                    <span className="truncate">{hit.displayName}</span>
                    <span className="ml-2 shrink-0 text-[10px] text-muted">
                      {hit.customerType ?? "?"}
                      {!hit.qbCustomerId ? " · no QB id" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {reassign.isError ? (
            <div className="border-t border-default px-3 py-2 text-[11px] text-accent-danger">
              {(reassign.error as Error).message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
