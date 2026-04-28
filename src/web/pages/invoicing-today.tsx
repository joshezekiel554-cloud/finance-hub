import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Package, Truck } from "lucide-react";
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
      reason: "shipped_less" | "shipped_more" | "not_shipped" | "split_zero";
    }
  | {
      type: "add";
      sku: string;
      qty: number;
      unitPrice: number | null;
      priceSource: "shopify_b2b" | "fallback";
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
  } | null;
  shopifyOrderError: string | null;
  reconcileResult: {
    actions: ReconcileAction[];
    summary: { keep: number; qty_change: number; add: number; addsNeedingPrice: string[] };
  } | null;
};

type ApiResponse = { rows: Row[]; shadowMode: boolean };

export default function InvoicingTodayPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useQuery<ApiResponse>({
    queryKey: ["invoicing", "today"],
    queryFn: async () => {
      const res = await fetch("/api/invoicing/today");
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

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
          {data?.shadowMode ? (
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

      {data && data.rows.length > 0 && (
        <Summary rows={data.rows} />
      )}

      {data?.rows.map((row) => <ShipmentCard key={row.gmailId} row={row} />)}
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
            <div className="text-xs text-secondary">no QB invoice match</div>
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

function ShipmentCard({ row }: { row: Row }) {
  // Skip the truly garbage emails so the page stays focused on actual shipments.
  if (row.parseConfidence < 0.5) return null;

  const po = row.parsed.poNumber ?? "(no PO)";
  const customer = row.qbInvoice?.customerName ?? row.shopifyOrder?.customerEmail ?? "(unknown)";
  const blocked = row.qbInvoice === null;

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
            </div>
          ) : (
            <Badge tone="critical">No QB invoice</Badge>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {row.qbInvoiceError && !row.qbInvoice && (
          <p className="text-xs text-accent-danger">QB lookup: {row.qbInvoiceError}</p>
        )}
        {row.shopifyOrderError && !row.shopifyOrder && (
          <p className="text-xs text-accent-warning">Shopify lookup: {row.shopifyOrderError}</p>
        )}

        {row.reconcileResult && (
          <ReconcileTable row={row} />
        )}

        {!blocked && row.reconcileResult && (
          <div className="flex items-center justify-between border-t border-default pt-3">
            <div className="text-xs text-secondary">
              {row.reconcileResult.summary.keep} keep ·{" "}
              {row.reconcileResult.summary.qty_change} qty change ·{" "}
              {row.reconcileResult.summary.add} add
              {row.reconcileResult.summary.addsNeedingPrice.length > 0 && (
                <>
                  {" "}
                  · <span className="text-accent-warning">
                    {row.reconcileResult.summary.addsNeedingPrice.length} need price
                  </span>
                </>
              )}
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={row.reconcileResult.summary.addsNeedingPrice.length > 0}
            >
              Send to QBO
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ReconcileTable({ row }: { row: Row }) {
  if (!row.qbInvoice || !row.reconcileResult) return null;

  // Build a unified row map keyed by SKU. Each row shows: SKU, current invoice
  // qty, shipped qty, action.
  type DisplayRow = {
    sku: string;
    itemName: string | null;
    currentQty: number | null;
    shippedQty: number | null;
    unitPrice: number | null;
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
        action: null,
      });
    }
  }
  for (const action of row.reconcileResult.actions) {
    if (action.type === "set_metadata") continue;
    const sku = action.type === "add" ? action.sku.toUpperCase() : action.sku.toUpperCase();
    const r = map.get(sku);
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
            <th className="px-3 py-2 text-right">Unit price</th>
            <th className="px-3 py-2 text-left">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sku} className="border-t border-default">
              <td className="px-3 py-2">
                <div className="font-mono text-xs font-medium">{r.sku}</div>
                {r.itemName && (
                  <div className="text-xs text-muted">{r.itemName}</div>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.currentQty ?? "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.shippedQty ?? "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.unitPrice !== null ? `$${r.unitPrice.toFixed(2)}` : "—"}
              </td>
              <td className="px-3 py-2">
                <ActionBadge action={r.action} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-default bg-elevated/30 px-3 py-2 text-xs text-secondary">
        <span className="font-medium">Header update:</span>{" "}
        Tracking{" "}
        <span className="font-mono">{row.parsed.trackingNumber}</span>
        {", "}
        ship via{" "}
        <span className="font-mono">{row.parsed.carrierShort}</span>
        {", "}
        ship date{" "}
        <span className="font-mono">{row.parsed.shipDate}</span>
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
    return (
      <Badge tone={tone}>
        qty {action.fromQty} → {action.toQty}
        <span
          className={cn("ml-1 text-[10px] font-normal opacity-70")}
        >
          ({action.reason})
        </span>
      </Badge>
    );
  }
  if (action.type === "add") {
    if (action.priceSource === "fallback") {
      return <Badge tone="high">add (needs price)</Badge>;
    }
    return <Badge tone="info">add @ ${action.unitPrice?.toFixed(2)}</Badge>;
  }
  return null;
}
