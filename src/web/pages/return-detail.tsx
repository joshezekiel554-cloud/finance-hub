// /returns/:id — RMA detail page with state-driven action panel.
// Header: RMA number, type pill, status pill, customer link, timestamps.
// Body: read-only items table, notes, photos (Drive URLs).
// Right rail: RmaActionPanel with state-driven buttons.

import { useParams, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle, ExternalLink } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import RmaActionPanel from "../components/rma-action-panel";
import type { RmaStatus, RmaReturnType } from "../components/rma-action-panel";
import { PhotoUploadZone } from "../components/photo-upload-zone";

// ---- Types ------------------------------------------------------------------

type RmaItem = {
  id: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  invoiceDiscountPct: string | null;
  originalInvoiceDocNumber: string | null;
  originalInvoiceDate: string | null;
  reason: string | null;
  receivedQuantity: string | null;
};

type RmaDetail = {
  id: string;
  rmaNumber: string | null;
  customerId: string;
  qbCustomerId: string | null;
  returnType: RmaReturnType;
  status: RmaStatus;
  totalValue: string;
  thresholdOverridden: boolean;
  overrideReason: string | null;
  denialReason: string | null;
  qboCreditMemoId: string | null;
  creditMemoDocNumber: string | null;
  shippingDeductionAmount: string | null;
  restockingFeeAmount: string | null;
  notes: string | null;
  resolutionType: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  createdAt: string;
  updatedAt: string;
  items: RmaItem[];
};

// ---- Constants --------------------------------------------------------------

const STATUS_LABELS: Record<RmaStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting warehouse #",
  sent_to_warehouse: "Awaiting return",
  received: "Received",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
};

type BadgeTone =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "neutral"
  | "info"
  | "success";

const STATUS_TONES: Record<RmaStatus, BadgeTone> = {
  draft: "neutral",
  approved: "success",
  awaiting_warehouse_number: "high",
  sent_to_warehouse: "info",
  received: "info",
  completed: "success",
  denied: "critical",
  cancelled: "neutral",
};

const TYPE_LABELS: Record<RmaReturnType, string> = {
  damage: "Damage",
  seasonal: "Seasonal",
  non_seasonal: "Non-seasonal",
};

const TYPE_TONES: Record<RmaReturnType, BadgeTone> = {
  damage: "high",
  seasonal: "info",
  non_seasonal: "medium",
};

// ---- Page -------------------------------------------------------------------

export default function ReturnDetailPage() {
  const { rmaId } = useParams({ from: "/returns/$rmaId" });
  const queryClient = useQueryClient();

  const { data: rma, isPending, isError, error, refetch } = useQuery<RmaDetail>({
    queryKey: ["rma", rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 15_000,
  });

  function handleRefresh() {
    void queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
    void refetch();
  }

  if (isPending) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="py-12 text-center text-sm text-muted">Loading RMA…</div>
      </div>
    );
  }

  if (isError || !rma) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="flex items-center gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger">
          <AlertCircle className="size-4 shrink-0" />
          {(error as Error)?.message ?? "RMA not found"}
        </div>
      </div>
    );
  }

  const displayNumber = rma.rmaNumber ?? `Draft ${rma.id.slice(0, 6)}…`;

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <div className="flex items-center gap-3">
        <Link
          to="/returns"
          className="inline-flex items-center gap-1 text-sm text-secondary hover:text-primary"
        >
          <ArrowLeft className="size-4" />
          Returns
        </Link>
        <span className="text-muted">/</span>
        <span className="font-mono text-sm">{displayNumber}</span>
      </div>

      {/* Main layout: body (left) + action rail (right) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        {/* ---- Left: main content ---- */}
        <div className="space-y-6">
          {/* Header card */}
          <Card>
            <CardBody>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="font-mono text-xl font-semibold tracking-tight">
                      {displayNumber}
                    </h1>
                    <Badge tone={TYPE_TONES[rma.returnType]}>
                      {TYPE_LABELS[rma.returnType]}
                    </Badge>
                    <Badge tone={STATUS_TONES[rma.status]}>
                      {STATUS_LABELS[rma.status]}
                    </Badge>
                    {rma.thresholdOverridden && (
                      <Badge tone="high">Override approved</Badge>
                    )}
                    {rma.resolutionType && (
                      <Badge tone="neutral">
                        {rma.resolutionType === "credit"
                          ? "Credit"
                          : "Replacement"}
                      </Badge>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
                    <span>
                      Customer:{" "}
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: rma.customerId }}
                        className="text-accent-primary underline underline-offset-2 hover:text-accent-primary/80"
                      >
                        {rma.customerId}
                      </Link>
                    </span>
                    <span>
                      Created:{" "}
                      {new Date(rma.createdAt).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                    <span>
                      Updated:{" "}
                      {new Date(rma.updatedAt).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                    <span className="tabular-nums">
                      Total: ${Number(rma.totalValue).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Resume-in-wizard CTA — drafts that belong in the multi-step
                  wizard (seasonal / non-seasonal). Damage drafts edit in place
                  on this page via the items table, so they don't need this. */}
              {rma.status === "draft" &&
                (rma.returnType === "seasonal" ||
                  rma.returnType === "non_seasonal") && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-info/30 bg-accent-info/10 px-3 py-2 text-xs text-secondary">
                    <span>
                      This RMA is a draft. Continue through the wizard to add
                      items, run eligibility, approve, and email the customer.
                    </span>
                    <Link
                      to="/returns/new"
                      search={{ rmaId: rma.id } as never}
                      className="inline-flex items-center gap-1 rounded-md bg-accent-info px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-info/90"
                    >
                      Continue editing in wizard
                    </Link>
                  </div>
                )}

              {/* Override reason */}
              {rma.thresholdOverridden && rma.overrideReason && (
                <div className="mt-3 rounded-md border border-accent-warning/30 bg-accent-warning/10 px-3 py-2 text-xs text-secondary">
                  <span className="font-medium text-accent-warning">
                    Override reason:
                  </span>{" "}
                  {rma.overrideReason}
                </div>
              )}

              {/* Denial reason */}
              {rma.status === "denied" && rma.denialReason && (
                <div className="mt-3 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-xs text-secondary">
                  <span className="font-medium text-accent-danger">
                    Denial reason:
                  </span>{" "}
                  {rma.denialReason}
                </div>
              )}

              {/* Credit memo info when completed */}
              {rma.status === "completed" && rma.creditMemoDocNumber && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
                  Credit memo{" "}
                  <span className="font-mono font-medium">
                    {rma.creditMemoDocNumber}
                  </span>
                  {rma.shippingDeductionAmount &&
                    parseFloat(rma.shippingDeductionAmount) > 0 && (
                      <span className="text-muted">
                        · Shipping deducted: $
                        {parseFloat(rma.shippingDeductionAmount).toFixed(2)}
                      </span>
                    )}
                  {rma.restockingFeeAmount &&
                    parseFloat(rma.restockingFeeAmount) > 0 && (
                      <span className="text-muted">
                        · Restocking: $
                        {parseFloat(rma.restockingFeeAmount).toFixed(2)}
                      </span>
                    )}
                  {rma.qboCreditMemoId && (
                    <a
                      href={`https://app.qbo.intuit.com/app/creditmemo?txnId=${rma.qboCreditMemoId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2"
                    >
                      <ExternalLink className="size-3" />
                      QBO
                    </a>
                  )}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Items table */}
          <Card>
            <CardHeader>
              <h2 className="text-sm font-medium">
                Items ({rma.items.length})
              </h2>
            </CardHeader>
            <CardBody className="p-0">
              {rma.items.length === 0 ? (
                <div className="p-4 text-sm text-muted">No items recorded.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Unit price</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2">Orig. invoice</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-default">
                    {rma.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-3 py-2">
                          <div className="font-medium">{item.name}</div>
                          <div className="text-xs text-muted">{item.sku}</div>
                          {item.reason && (
                            <div className="mt-0.5 text-xs text-secondary italic">
                              {item.reason}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {parseFloat(item.quantity).toFixed(0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          ${parseFloat(item.unitPrice).toFixed(2)}
                          {item.invoiceDiscountPct && (
                            <div className="text-[10px] text-accent-info">
                              {parseFloat(item.invoiceDiscountPct)}% disc.
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          ${parseFloat(item.lineTotal).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-xs text-secondary">
                          {item.originalInvoiceDocNumber ? (
                            <>
                              #{item.originalInvoiceDocNumber}
                              {item.originalInvoiceDate && (
                                <span className="ml-1 text-muted">
                                  {item.originalInvoiceDate}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-default bg-subtle">
                      <td
                        colSpan={3}
                        className="px-3 py-2 text-xs text-muted"
                      >
                        Total
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        ${Number(rma.totalValue).toFixed(2)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              )}
            </CardBody>
          </Card>

          {/* Notes */}
          {rma.notes && (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-medium">Notes</h2>
              </CardHeader>
              <CardBody>
                <p className="whitespace-pre-wrap text-sm text-secondary">
                  {rma.notes}
                </p>
              </CardBody>
            </Card>
          )}

          {/* Photos — damage RMAs only */}
          {rma.returnType === "damage" && (
            <PhotoUploadZone rmaId={rma.id} />
          )}
        </div>

        {/* ---- Right: action panel ---- */}
        <div>
          <Card>
            <CardBody>
              <RmaActionPanel
                rmaId={rma.id}
                rmaNumber={rma.rmaNumber}
                status={rma.status}
                returnType={rma.returnType}
                customerId={rma.customerId}
                qboCreditMemoId={rma.qboCreditMemoId}
                creditMemoDocNumber={rma.creditMemoDocNumber}
                trackingNumber={rma.trackingNumber}
                trackingCarrier={rma.trackingCarrier}
                onRefresh={handleRefresh}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---- Back link --------------------------------------------------------------

function BackLink() {
  return (
    <Link
      to="/returns"
      className="inline-flex items-center gap-1 text-sm text-secondary hover:text-primary"
    >
      <ArrowLeft className="size-4" />
      Returns
    </Link>
  );
}
