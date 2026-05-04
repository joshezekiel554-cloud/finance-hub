// RmaItemsTable — items table for the RMA create form.
// Each row has a QBO item autocomplete (mirrors AddLinePicker in
// invoicing-today.tsx), quantity/price fields, and two action buttons:
// "Find original invoice" and "Lookup prices". The table is editable
// when the parent form is in draft mode.

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Trash2, Search, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

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

type QbItemHit = {
  id: string;
  name: string;
  sku: string | null;
  unitPrice: number | null;
  type: string | null;
};

type LookupResult = {
  list_unit_price: string | null;
  unit_price: string | null;
  invoice_discount_pct: string | null;
  original_invoice_doc_number: string | null;
  original_invoice_date: string | null;
};

export type RmaItemsTableProps = {
  rmaId: string | null; // null while the RMA hasn't been persisted yet
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
  items,
  onChange,
  disabled = false,
}: RmaItemsTableProps) {
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
              {items.map((row) => (
                <ItemRow
                  key={row.localKey}
                  row={row}
                  rmaId={rmaId}
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
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addRow}
        >
          + Add item
        </Button>
      )}
    </div>
  );
}

// ---- Individual row --------------------------------------------------------

function ItemRow({
  row,
  rmaId,
  disabled,
  onUpdate,
  onRemove,
}: {
  row: RmaItemRow;
  rmaId: string | null;
  disabled: boolean;
  onUpdate: (patch: Partial<RmaItemRow>) => void;
  onRemove: () => void;
}) {
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Lookup prices mutation
  const lookupMutation = useMutation<LookupResult, Error, void>({
    mutationFn: async () => {
      if (!rmaId) throw new Error("Save the RMA first before looking up prices");
      if (!row.qbItemId) throw new Error("Select a QB item first");
      const res = await fetch(`/api/rmas/${rmaId}/lookup-prices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qbItemId: row.qbItemId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setLookupError(null);
      onUpdate({
        unitPrice: data.unit_price ?? row.unitPrice,
        listUnitPrice: data.list_unit_price ?? null,
        invoiceDiscountPct: data.invoice_discount_pct ?? null,
        originalInvoiceDocNumber: data.original_invoice_doc_number ?? null,
        originalInvoiceDate: data.original_invoice_date ?? null,
      });
    },
    onError: (err) => setLookupError(err.message),
  });

  // Find original invoice mutation
  const findInvoiceMutation = useMutation<LookupResult, Error, void>({
    mutationFn: async () => {
      if (!rmaId) throw new Error("Save the RMA first");
      if (!row.qbItemId) throw new Error("Select a QB item first");
      const res = await fetch(`/api/rmas/${rmaId}/find-original-invoice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qbItemId: row.qbItemId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setLookupError(null);
      onUpdate({
        originalInvoiceDocNumber: data.original_invoice_doc_number ?? null,
        originalInvoiceDate: data.original_invoice_date ?? null,
      });
    },
    onError: (err) => setLookupError(err.message),
  });

  const working =
    lookupMutation.isPending || findInvoiceMutation.isPending;

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
                title="Lookup prices from most recent invoice"
                disabled={working || !rmaId}
                onClick={() => lookupMutation.mutate()}
                className="inline-flex items-center gap-1 rounded border border-default bg-base px-1.5 py-0.5 text-[10px] text-secondary hover:bg-elevated disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3", lookupMutation.isPending && "animate-spin")} />
                Prices
              </button>
              <button
                type="button"
                title="Find original invoice"
                disabled={working || !rmaId}
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

// ---- QBO item picker (inline autocomplete) ---------------------------------

function QboItemPicker({
  onPick,
}: {
  onPick: (item: QbItemHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QbItemHit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
        const body = (await res.json()) as { items: QbItemHit[] };
        setResults(body.items);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search QB items (SKU or name)…"
        className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            setResults([]);
          }
        }}
      />
      {query.trim().length >= 2 && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-default bg-base shadow-lg">
          {loading && (
            <div className="px-3 py-2 text-xs text-muted">Searching…</div>
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
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-elevated"
            >
              <span className="font-medium">{item.sku ?? item.id}</span>
              <span className="ml-2 text-secondary">{item.name}</span>
              {item.unitPrice != null && (
                <span className="ml-2 text-xs text-muted">
                  ${item.unitPrice.toFixed(2)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
