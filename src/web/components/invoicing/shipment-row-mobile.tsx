// Compact tap-target row for the Today page on mobile. Renders one
// shipment as PO → customer + total + status pill + carrier/inv# meta.
// Tapping navigates to /invoicing/$gmailId where the full editing
// surface lives. Desktop continues to render the inline ShipmentCard.

import { Link } from "@tanstack/react-router";
import { Truck } from "lucide-react";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/cn";

type ReconcileSummary = { addsNeedingPrice: string[] };

type ShipmentRowMobileProps = {
  gmailId: string;
  poNumber: string | null;
  customerName: string;
  // Invoice metadata when matched; null when the row has no QBO invoice
  // (rare but possible — e.g. dismissed-with-no-match rows).
  qbInvoice: {
    docType: "invoice" | "salesreceipt";
    docNumber: string;
    totalAmt: number;
    currency: string | null;
    emailStatus: string | null;
  } | null;
  // Operator's carrier label, for the row's secondary line.
  carrier: string | null;
  reconcileSummary: ReconcileSummary | null;
  // When true, dims the row and renders a Dismissed pill. Operator can
  // still tap to open the detail page (Restore is in there).
  dismissed?: boolean;
};

function formatMoney(amount: number, currency: string | null): string {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ShipmentRowMobile(props: ShipmentRowMobileProps) {
  const { gmailId, poNumber, customerName, qbInvoice, carrier, reconcileSummary, dismissed } = props;
  const needsPriceCount = reconcileSummary?.addsNeedingPrice.length ?? 0;
  const isSalesReceipt = qbInvoice?.docType === "salesreceipt";
  const sent = qbInvoice?.emailStatus === "EmailSent";

  // Status pill priority: dismissed > no-invoice > needs-price > sent >
  // sales receipt > ready.
  let statusPill: React.ReactNode;
  if (dismissed) {
    statusPill = <Badge tone="neutral">Dismissed</Badge>;
  } else if (!qbInvoice) {
    statusPill = <Badge tone="critical">No QB invoice</Badge>;
  } else if (needsPriceCount > 0) {
    statusPill = (
      <Badge tone="high">
        {needsPriceCount} need{needsPriceCount === 1 ? "s" : ""} price
      </Badge>
    );
  } else if (sent) {
    statusPill = <Badge tone="success">Sent</Badge>;
  } else if (isSalesReceipt) {
    statusPill = <Badge tone="info">Sales Receipt</Badge>;
  } else {
    statusPill = <Badge tone="info">Ready</Badge>;
  }

  const meta = [
    qbInvoice ? `#${qbInvoice.docNumber}` : null,
    carrier,
  ]
    .filter((v): v is string => Boolean(v))
    .join(" · ");

  return (
    <Link
      to="/invoicing/$gmailId"
      params={{ gmailId }}
      className={cn(
        "block rounded-md border border-default bg-subtle p-3 transition-colors",
        "hover:border-strong hover:bg-elevated",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40",
        dismissed && "opacity-60",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <Truck className="size-3.5 shrink-0 text-muted" />
          <span className="truncate text-sm font-semibold text-primary">
            {poNumber ?? "(no PO)"} → {customerName}
          </span>
        </div>
        {qbInvoice ? (
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {formatMoney(qbInvoice.totalAmt, qbInvoice.currency)}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {statusPill}
        {meta ? <span className="truncate">{meta}</span> : null}
      </div>
    </Link>
  );
}
