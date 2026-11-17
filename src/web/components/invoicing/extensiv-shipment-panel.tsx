// What Extensiv says it shipped, for Today rows that have no reconcile table
// (no Shopify order / no matched QBO invoice). Without this the card showed
// only lookup errors and the operator had to open the email to see anything.

import { Package } from "lucide-react";
import {
  formatRetail,
  retailTooltip,
  uniqueSkus,
  type ExtensivRowShape,
} from "./extensiv-shipment";
import { useShopifyRetailPrices } from "../../lib/use-shopify-retail";

type PanelRow = ExtensivRowShape & {
  parsed: ExtensivRowShape["parsed"] & {
    endCustomerName: string | null;
    carrierShort: string | null;
    carrierLong: string | null;
    trackingNumber: string | null;
    shipDate: string | null;
  };
};

export function ExtensivShipmentPanel({ row }: { row: PanelRow }) {
  const items = row.parsed.lineItems;
  const { prices, isLoading, isError } = useShopifyRetailPrices(
    uniqueSkus(items.map((i) => i.sku)),
  );
  const totalUnits = items.reduce((n, i) => n + (Number(i.quantity) || 0), 0);

  return (
    <div className="rounded-md border border-default">
      <div className="flex items-center gap-2 border-b border-default bg-elevated px-3 py-2 text-xs font-medium uppercase tracking-wide text-secondary">
        <Package className="size-3.5" />
        Extensiv shipment
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted">Transaction #</dt>
          <dd className="font-mono">{row.parsed.transactionNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted">Reference</dt>
          <dd className="font-mono break-all">{row.parsed.poNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted">Ship to</dt>
          <dd>{row.parsed.endCustomerName || "—"}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted">Shipped</dt>
          <dd>
            {row.parsed.shipDate ?? "—"}
            {row.parsed.carrierShort ? ` · ${row.parsed.carrierShort}` : ""}
          </dd>
        </div>
      </dl>
      <table className="w-full border-t border-default text-sm">
        <thead className="bg-elevated/50 text-xs uppercase tracking-wide text-secondary">
          <tr>
            <th className="px-3 py-1.5 text-left">SKU</th>
            <th className="px-3 py-1.5 text-right">Qty shipped</th>
            <th className="px-3 py-1.5 text-right">Shopify retail</th>
          </tr>
        </thead>
        <tbody>
          {items.map((li, idx) => {
            const hit = prices.get(li.sku.trim().toUpperCase());
            return (
              <tr key={`${li.sku}-${idx}`} className="border-t border-default">
                <td className="px-3 py-1.5">
                  <div className="font-mono text-xs font-medium">{li.sku}</div>
                  {hit && (
                    <div className="text-xs text-muted">
                      {hit.variantTitle
                        ? `${hit.productTitle} – ${hit.variantTitle}`
                        : hit.productTitle}
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {Number(li.quantity) || li.quantity}
                </td>
                <td
                  className="px-3 py-1.5 text-right tabular-nums text-muted"
                  title={isLoading ? undefined : retailTooltip(hit)}
                >
                  {isLoading ? "…" : formatRetail(hit)}
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr className="border-t border-default">
              <td colSpan={3} className="px-3 py-2 text-xs text-muted">
                No items could be read from the email.
              </td>
            </tr>
          )}
        </tbody>
        {items.length > 0 && (
          <tfoot>
            <tr className="border-t border-default bg-elevated/30 text-xs text-secondary">
              <td className="px-3 py-1.5">
                {items.length} SKU{items.length === 1 ? "" : "s"}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{totalUnits} units</td>
              <td className="px-3 py-1.5 text-right">
                {isError ? (
                  <span className="text-accent-warning">Shopify prices unavailable</span>
                ) : null}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
