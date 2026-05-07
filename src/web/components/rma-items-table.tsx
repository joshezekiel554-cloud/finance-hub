// RmaItemsTable — items table for the RMA create form.
// Each row has a QBO item autocomplete (mirrors AddLinePicker in
// invoicing-today.tsx), quantity/price fields, and two action buttons:
// "Find original invoice" and "Lookup prices". The table is editable
// when the parent form is in draft mode.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Trash2, Search, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";
import { QboItemPicker, type QbItemHit } from "./qbo-item-picker";

export type RmaItemRow = {
  // Local key for React rendering; not the DB id until saved
  localKey: string;
  // Set after the item is persisted to the backend
  id?: string;
  qbItemId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  listUnitPrice: string | null;
  invoiceDiscountPct: string | null;
  lineTotal: string;
  originalInvoiceDocNumber: string | null;
  originalInvoiceDate: string | null;
  reason: string;
};

type LookupResult = {
  listUnitPrice: string | null;
  unitPrice: string | null;
  invoiceDiscountPct: string | null;
  originalInvoiceDocNumber: string | null;
  originalInvoiceDate: string | null;
};

export type RmaItemsTableProps = {
  rmaId: string | null; // null while the RMA hasn't been persisted yet
  qbCustomerId?: string | null; // for customer-scoped lookups before the RMA is saved
  items: RmaItemRow[];
  onChange: (items: RmaItemRow[]) => void;
  disabled?: boolean;
};

let localKeyCounter = 0;
function nextKey() {
  return `local-${++localKeyCounter}`;
}

export function makeEmptyRow(): RmaItemRow {
  return {
    localKey: nextKey(),
    qbItemId: "",
    sku: "",
    name: "",
    quantity: "1",
    unitPrice: "0.00",
    listUnitPrice: null,
    invoiceDiscountPct: null,
    lineTotal: "0.00",
    originalInvoiceDocNumber: null,
    originalInvoiceDate: null,
    reason: "",
  };
}

export default function RmaItemsTable({
  rmaId,
  qbCustomerId = null,
  items,
  onChange,
  disabled = false,
}: RmaItemsTableProps) {
  const [bulkLookupPending, setBulkLookupPending] = useState(false);
  const [bulkLookupError, setBulkLookupError] = useState<string | null>(null);
  const [bulkLookupSummary, setBulkLookupSummary] = useState<string | null>(
    null,
  );

  function updateRow(key: string, patch: Partial<RmaItemRow>) {
    onChange(
      items.map((r) => {
        if (r.localKey !== key) return r;
        const merged = { ...r, ...patch };
        // Recompute lineTotal whenever qty or price changes
        const qty = parseFloat(merged.quantity) || 0;
        const price = parseFloat(merged.unitPrice) || 0;
        merged.lineTotal = (qty * price).toFixed(2);
        return merged;
      }),
    );
  }

  function removeRow(key: string) {
    onChange(items.filter((r) => r.localKey !== key));
  }

  function addRow() {
    onChange([...items, makeEmptyRow()]);
  }

  // Resolve all rows in two phases:
  //   1. For rows missing qbItemId: search QBO for SKU/name → take top result
  //   2. For all rows with qbItemId: lookup-prices + find original invoice
  // Both phases throttled to 3 concurrent. Single button = single user action.
  async function bulkLookupAll(): Promise<void> {
    if (!rmaId && !qbCustomerId) {
      setBulkLookupError(
        "Pick a customer first — lookup needs the customer to find their invoices.",
      );
      return;
    }
    const allRows = items.filter((r) => r.sku || r.name || r.qbItemId);
    if (allRows.length === 0) {
      setBulkLookupError(
        "Add at least one item (with a SKU or name) before resolving.",
      );
      return;
    }
    setBulkLookupPending(true);
    setBulkLookupError(null);
    setBulkLookupSummary(null);

    const CONCURRENCY = 3;

    // ─── Phase 1: resolve QBO items for rows missing qbItemId ──────────────
    const unresolved = allRows.filter((r) => !r.qbItemId);
    type ResolveOutcome =
      | { localKey: string; ok: true; hit: QbItemHit }
      | { localKey: string; ok: false };
    const resolved: ResolveOutcome[] = [];

    if (unresolved.length > 0) {
      const queue1 = [...unresolved];
      async function resolveWorker(): Promise<void> {
        while (queue1.length > 0) {
          const r = queue1.shift();
          if (!r) break;
          const q = (r.sku || r.name || "").trim();
          if (!q) {
            resolved.push({ localKey: r.localKey, ok: false });
            continue;
          }
          try {
            const res = await fetch(
              `/api/invoicing/items/search?q=${encodeURIComponent(q)}`,
            );
            if (!res.ok) {
              resolved.push({ localKey: r.localKey, ok: false });
              continue;
            }
            const body = (await res.json()) as { items: QbItemHit[] };
            const top = body.items[0];
            if (top) {
              resolved.push({ localKey: r.localKey, ok: true, hit: top });
            } else {
              resolved.push({ localKey: r.localKey, ok: false });
            }
          } catch {
            resolved.push({ localKey: r.localKey, ok: false });
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, unresolved.length) }, () =>
          resolveWorker(),
        ),
      );
    }

    // Apply phase-1 results to a working copy of items
    const afterResolve: RmaItemRow[] = items.map((r) => {
      if (r.qbItemId) return r;
      const hit = resolved.find((x) => x.localKey === r.localKey);
      if (!hit?.ok) return r;
      const merged: RmaItemRow = {
        ...r,
        qbItemId: hit.hit.id,
        sku: hit.hit.sku ?? r.sku,
        name: hit.hit.name,
        unitPrice:
          hit.hit.unitPrice != null
            ? hit.hit.unitPrice.toFixed(4)
            : r.unitPrice,
        listUnitPrice:
          hit.hit.unitPrice != null
            ? hit.hit.unitPrice.toFixed(4)
            : r.listUnitPrice,
      };
      const qty = parseFloat(merged.quantity) || 0;
      const price = parseFloat(merged.unitPrice) || 0;
      merged.lineTotal = (qty * price).toFixed(2);
      return merged;
    });

    // ─── Phase 2: lookup-prices for all rows that now have qbItemId ───────
    const priceCandidates = afterResolve.filter((r) => r.qbItemId);
    const queue2 = [...priceCandidates];
    type LookupOutcome =
      | { localKey: string; ok: true; data: LookupResult }
      | { localKey: string; ok: false };
    const priced: LookupOutcome[] = [];

    async function priceWorker(): Promise<void> {
      while (queue2.length > 0) {
        const r = queue2.shift();
        if (!r) break;
        try {
          const url = rmaId
            ? `/api/rmas/${rmaId}/lookup-prices`
            : `/api/rmas/qbo-lookup-prices`;
          const body = rmaId
            ? { qbItemId: r.qbItemId }
            : { qbCustomerId, qbItemId: r.qbItemId };
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            priced.push({ localKey: r.localKey, ok: false });
          } else {
            const data = (await res.json()) as LookupResult;
            priced.push({ localKey: r.localKey, ok: true, data });
          }
        } catch {
          priced.push({ localKey: r.localKey, ok: false });
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, priceCandidates.length) },
        () => priceWorker(),
      ),
    );

    // Apply phase-2 results
    const finalRows = afterResolve.map((r) => {
      const hit = priced.find((res) => res.localKey === r.localKey);
      if (!hit?.ok || !hit.data) return r;
      const merged: RmaItemRow = {
        ...r,
        unitPrice: hit.data.unitPrice ?? r.unitPrice,
        listUnitPrice: hit.data.listUnitPrice ?? r.listUnitPrice,
        invoiceDiscountPct:
          hit.data.invoiceDiscountPct ?? r.invoiceDiscountPct,
        originalInvoiceDocNumber:
          hit.data.originalInvoiceDocNumber ?? r.originalInvoiceDocNumber,
        originalInvoiceDate:
          hit.data.originalInvoiceDate ?? r.originalInvoiceDate,
      };
      const qty = parseFloat(merged.quantity) || 0;
      const price = parseFloat(merged.unitPrice) || 0;
      merged.lineTotal = (qty * price).toFixed(2);
      return merged;
    });

    onChange(finalRows);

    const resolvedCount = resolved.filter((r) => r.ok).length;
    const pricedCount = priced.filter((r) => r.ok).length;
    const summaryParts: string[] = [];
    if (unresolved.length > 0) {
      summaryParts.push(
        `Matched ${resolvedCount}/${unresolved.length} item(s)`,
      );
    }
    if (priceCandidates.length > 0) {
      summaryParts.push(
        `pulled prices + invoices for ${pricedCount}/${priceCandidates.length}`,
      );
    }
    setBulkLookupSummary(summaryParts.join(", ") + ".");
    setBulkLookupPending(false);
  }

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="w-full text-sm">
            <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 w-20">Qty</th>
                <th className="px-3 py-2 w-28">Unit price</th>
                <th className="px-3 py-2 w-28 text-right">Total</th>
                <th className="px-3 py-2">Orig. invoice</th>
                <th className="px-3 py-2">Actions</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {/* Preserve insertion order — operator-visible UI relies on this. */}
              {items.map((row) => (
                <ItemRow
                  key={row.localKey}
                  row={row}
                  rmaId={rmaId}
                  qbCustomerId={qbCustomerId}
                  disabled={disabled}
                  onUpdate={(patch) => updateRow(row.localKey, patch)}
                  onRemove={() => removeRow(row.localKey)}
                />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-default bg-subtle">
                <td colSpan={3} className="px-3 py-2 text-xs text-muted">
                  Total
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  $
                  {items
                    .reduce((s, r) => s + (parseFloat(r.lineTotal) || 0), 0)
                    .toFixed(2)}
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addRow}
          >
            + Add item
          </Button>
          {items.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={bulkLookupPending}
              onClick={() => void bulkLookupAll()}
            >
              <RefreshCw
                className={cn("size-4", bulkLookupPending && "animate-spin")}
              />
              {bulkLookupPending
                ? "Resolving…"
                : "Find items + prices + invoices"}
            </Button>
          )}
          {bulkLookupSummary && !bulkLookupError && (
            <span className="text-xs text-muted">{bulkLookupSummary}</span>
          )}
          {bulkLookupError && (
            <span className="flex items-center gap-1 text-xs text-accent-danger">
              <AlertCircle className="size-3" />
              {bulkLookupError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Individual row --------------------------------------------------------

function ItemRow({
  row,
  rmaId,
  qbCustomerId,
  disabled,
  onUpdate,
  onRemove,
}: {
  row: RmaItemRow;
  rmaId: string | null;
  qbCustomerId: string | null;
  disabled: boolean;
  onUpdate: (patch: Partial<RmaItemRow>) => void;
  onRemove: () => void;
}) {
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Lookup prices mutation — uses customer-scoped route when no rmaId yet,
  // RMA-scoped route otherwise. Either path requires a customer for the
  // invoice search.
  const lookupMutation = useMutation<LookupResult, Error, void>({
    mutationFn: async () => {
      if (!row.qbItemId) throw new Error("Select a QB item first");
      if (!rmaId && !qbCustomerId) {
        throw new Error("Pick a customer first to look up prices");
      }
      const url = rmaId
        ? `/api/rmas/${rmaId}/lookup-prices`
        : `/api/rmas/qbo-lookup-prices`;
      const body = rmaId
        ? { qbItemId: row.qbItemId }
        : { qbCustomerId, qbItemId: row.qbItemId };
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setLookupError(null);
      onUpdate({
        unitPrice: data.unitPrice ?? row.unitPrice,
        listUnitPrice: data.listUnitPrice ?? null,
        invoiceDiscountPct: data.invoiceDiscountPct ?? null,
        originalInvoiceDocNumber: data.originalInvoiceDocNumber ?? null,
        originalInvoiceDate: data.originalInvoiceDate ?? null,
      });
    },
    onError: (err) => setLookupError(err.message),
  });

  // Find original invoice mutation — same dual-route pattern as lookupMutation.
  const findInvoiceMutation = useMutation<LookupResult, Error, void>({
    mutationFn: async () => {
      if (!row.qbItemId) throw new Error("Select a QB item first");
      if (!rmaId && !qbCustomerId) {
        throw new Error("Pick a customer first to find invoice");
      }
      const url = rmaId
        ? `/api/rmas/${rmaId}/find-original-invoice`
        : `/api/rmas/qbo-find-original-invoice`;
      const body = rmaId
        ? { qbItemId: row.qbItemId }
        : { qbCustomerId, qbItemId: row.qbItemId };
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setLookupError(null);
      onUpdate({
        originalInvoiceDocNumber: data.originalInvoiceDocNumber ?? null,
        originalInvoiceDate: data.originalInvoiceDate ?? null,
      });
    },
    onError: (err) => setLookupError(err.message),
  });

  const working =
    lookupMutation.isPending || findInvoiceMutation.isPending;
  // Per-row auto-lookup intentionally removed — operator runs the bulk
  // "Pull prices & invoices" button after items are added, which avoids
  // per-keystroke QBO traffic. Per-row buttons remain for manual re-trigger.

  return (
    <>
      <tr className={cn(disabled && "opacity-60")}>
        <td className="px-3 py-2">
          {disabled || row.qbItemId ? (
            <div>
              <div className="font-medium">{row.name || "—"}</div>
              {row.sku && (
                <div className="text-xs text-muted">{row.sku}</div>
              )}
            </div>
          ) : (
            <QboItemPicker
              initialQuery={row.sku || row.name || ""}
              parsedHint={!row.qbItemId && row.name ? row.name : undefined}
              onPick={(hit) => {
                onUpdate({
                  qbItemId: hit.id,
                  sku: hit.sku ?? "",
                  name: hit.name,
                  unitPrice: hit.unitPrice != null ? hit.unitPrice.toFixed(4) : "0.0000",
                  listUnitPrice: hit.unitPrice != null ? hit.unitPrice.toFixed(4) : null,
                });
              }}
            />
          )}
        </td>
        <td className="px-3 py-2">
          <input
            type="number"
            min="0.0001"
            step="0.0001"
            value={row.quantity}
            disabled={disabled}
            onChange={(e) => onUpdate({ quantity: e.target.value })}
            className="w-20 rounded-md border border-default bg-base px-2 py-1 text-sm disabled:opacity-60"
          />
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            <span className="text-muted">$</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={row.unitPrice}
              disabled={disabled}
              onChange={(e) => onUpdate({ unitPrice: e.target.value })}
              className="w-24 rounded-md border border-default bg-base px-2 py-1 text-sm disabled:opacity-60"
            />
          </div>
          {row.invoiceDiscountPct && (
            <div className="mt-0.5 text-[10px] text-accent-info">
              {parseFloat(row.invoiceDiscountPct)}% discount applied
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          ${parseFloat(row.lineTotal || "0").toFixed(2)}
        </td>
        <td className="px-3 py-2 text-xs">
          {row.originalInvoiceDocNumber ? (
            <div>
              <span className="font-medium">#{row.originalInvoiceDocNumber}</span>
              {row.originalInvoiceDate && (
                <span className="ml-1 text-muted">{row.originalInvoiceDate}</span>
              )}
            </div>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          {!disabled && row.qbItemId && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                title={rmaId ? "Lookup prices from most recent invoice" : "Save the RMA as a draft first"}
                disabled={working}
                onClick={() => lookupMutation.mutate()}
                className="inline-flex items-center gap-1 rounded border border-default bg-base px-1.5 py-0.5 text-[10px] text-secondary hover:bg-elevated disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3", lookupMutation.isPending && "animate-spin")} />
                Prices
              </button>
              <button
                type="button"
                title={rmaId ? "Find original invoice" : "Save the RMA as a draft first"}
                disabled={working}
                onClick={() => findInvoiceMutation.mutate()}
                className="inline-flex items-center gap-1 rounded border border-default bg-base px-1.5 py-0.5 text-[10px] text-secondary hover:bg-elevated disabled:opacity-50"
              >
                <Search className={cn("size-3", findInvoiceMutation.isPending && "animate-spin")} />
                Invoice
              </button>
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          {!disabled && (
            <button
              type="button"
              onClick={onRemove}
              className="text-muted hover:text-accent-danger"
              aria-label="Remove item"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </td>
      </tr>
      {/* Per-row error row */}
      {lookupError && (
        <tr>
          <td colSpan={7} className="px-3 pb-2">
            <div className="flex items-center gap-1 text-xs text-accent-danger">
              <AlertCircle className="size-3 shrink-0" />
              {lookupError}
            </div>
          </td>
        </tr>
      )}
      {/* Reason field row */}
      {!disabled && (
        <tr>
          <td colSpan={7} className="pb-2 pl-3 pr-3">
            <input
              type="text"
              placeholder="Damage description / reason (optional)"
              value={row.reason}
              onChange={(e) => onUpdate({ reason: e.target.value })}
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-xs text-secondary"
            />
          </td>
        </tr>
      )}
    </>
  );
}

