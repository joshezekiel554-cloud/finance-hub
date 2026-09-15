// SeasonProductsManager — per-season product list management.
// Supports QBO item search-and-add, bulk SKU paste, CSV import/export,
// and individual product removal.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload, Download, AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

type SeasonProduct = {
  id: string;
  seasonId: string;
  qbItemId: string;
  sku: string | null;
  name: string | null;
  description: string | null;
  createdAt: string;
};

type QbItemHit = {
  id: string;
  name: string;
  sku: string | null;
  unitPrice: number | null;
  type: string | null;
};

type BulkPasteResult = {
  added: number;
  skipped: number;
  errors: string[];
};

type BulkAddByIdResult = {
  added: SeasonProduct[];
  skipped: number;
  failed: { qbItemId: string; reason: string }[];
};

export default function SeasonProductsManager({ seasonId }: { seasonId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["season-products", seasonId];

  const { data, isPending, isError } = useQuery<{ products: SeasonProduct[] }>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/seasons/${seasonId}/products`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  // Add the ticked search results in one request (operator 2026-09-15:
  // adding one at a time "takes forever").
  const addMutation = useMutation<BulkAddByIdResult, Error, string[]>({
    mutationFn: async (qbItemIds) => {
      const res = await fetch(`/api/seasons/${seasonId}/products/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qbItemIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  // Remove product
  const removeMutation = useMutation<unknown, Error, string>({
    mutationFn: async (productId) => {
      const res = await fetch(`/api/seasons/${seasonId}/products/${productId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  // Bulk paste
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState<BulkPasteResult | null>(null);
  const bulkMutation = useMutation<BulkPasteResult, Error, string[]>({
    mutationFn: async (skus) => {
      const res = await fetch(`/api/seasons/${seasonId}/products/bulk-paste`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skus }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (result) => {
      setBulkResult(result);
      setBulkText("");
      queryClient.invalidateQueries({ queryKey });
    },
  });

  function handleBulkAdd() {
    const skus = bulkText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (skus.length === 0) return;
    setBulkResult(null);
    bulkMutation.mutate(skus);
  }

  // CSV import
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importMutation = useMutation<{ added: number; skipped: number }, Error, File>({
    mutationFn: async (file) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/seasons/${seasonId}/products/import-csv`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setImportError(null);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setImportError(err.message),
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    importMutation.mutate(file);
    // Reset so same file can be re-selected
    e.target.value = "";
  }

  const products = data?.products ?? [];

  return (
    <div className="space-y-5">
      {/* QBO search-and-add */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Search &amp; add items
        </h4>
        <QboProductSearch
          existingIds={new Set(products.map((p) => p.qbItemId))}
          onAdd={(ids) => addMutation.mutate(ids)}
          isAdding={addMutation.isPending}
          addError={addMutation.error?.message ?? null}
          lastResult={addMutation.data ?? null}
        />
      </div>

      {/* Bulk paste */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Bulk paste (one SKU per line)
        </h4>
        <textarea
          rows={4}
          placeholder={"SKU-001\nSKU-002\nSKU-003"}
          value={bulkText}
          onChange={(e) => { setBulkText(e.target.value); setBulkResult(null); }}
          className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm font-mono"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!bulkText.trim() || bulkMutation.isPending}
            loading={bulkMutation.isPending}
            onClick={handleBulkAdd}
          >
            Add all
          </Button>
          {bulkResult && (
            <span className="text-xs text-secondary">
              Added {bulkResult.added}, skipped {bulkResult.skipped}
              {bulkResult.errors.length > 0 && (
                <span className="ml-1 text-accent-danger">
                  ({bulkResult.errors.length} error{bulkResult.errors.length > 1 ? "s" : ""})
                </span>
              )}
            </span>
          )}
          {bulkMutation.isError && (
            <span className="text-xs text-accent-danger">{bulkMutation.error.message}</span>
          )}
        </div>
      </div>

      {/* Import / Export CSV */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={importMutation.isPending}
          loading={importMutation.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-3.5" />
          Import CSV
        </Button>
        <a
          href={`/api/seasons/${seasonId}/products/export-csv`}
          download
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-secondary",
            "bg-transparent hover:bg-elevated hover:text-primary transition-colors",
          )}
        >
          <Download className="size-3.5" />
          Export CSV
        </a>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={handleFileChange}
        />
        {importError && (
          <span className="text-xs text-accent-danger">{importError}</span>
        )}
        {importMutation.isSuccess && (
          <span className="text-xs text-secondary">
            CSV imported successfully
          </span>
        )}
      </div>

      {/* Product list */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Products in season ({products.length})
        </h4>

        {isPending && (
          <div className="text-sm text-muted">Loading…</div>
        )}
        {isError && (
          <div className="flex items-center gap-1 text-sm text-accent-danger">
            <AlertCircle className="size-4 shrink-0" />
            Failed to load products
          </div>
        )}
        {!isPending && !isError && products.length === 0 && (
          <div className="rounded-md border border-default bg-subtle px-3 py-4 text-center text-sm text-muted">
            No products added yet.
          </div>
        )}
        {products.length > 0 && (
          <div className="rounded-md border border-default divide-y divide-default overflow-hidden">
            {products.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{p.name ?? p.qbItemId}</span>
                  {p.sku && (
                    <span className="ml-2 text-xs text-muted font-mono">{p.sku}</span>
                  )}
                  {p.description && (
                    <div className="truncate text-xs text-secondary">{p.description}</div>
                  )}
                </div>
                <button
                  type="button"
                  title="Remove from season"
                  disabled={removeMutation.isPending}
                  onClick={() => removeMutation.mutate(p.id)}
                  className="shrink-0 text-muted hover:text-accent-danger disabled:opacity-40"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        {removeMutation.isError && (
          <div className="mt-1 text-xs text-accent-danger">
            {removeMutation.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- QBO product search -------------------------------------------------------

// Multi-select: tick any number of results (across several searches — the
// selection survives retyping), then "Add N selected" posts them together.
function QboProductSearch({
  existingIds,
  onAdd,
  isAdding,
  addError,
  lastResult,
}: {
  existingIds: Set<string>;
  onAdd: (qbItemIds: string[]) => void;
  isAdding: boolean;
  addError: string | null;
  lastResult: BulkAddByIdResult | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QbItemHit[]>([]);
  const [loading, setLoading] = useState(false);
  // qbItemId → hit, so the chips can show SKUs for items from earlier searches.
  const [selected, setSelected] = useState<Map<string, QbItemHit>>(new Map());

  function toggle(item: QbItemHit) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }

  function addSelected() {
    const ids = Array.from(selected.keys()).filter((id) => !existingIds.has(id));
    if (ids.length === 0) return;
    onAdd(ids);
    setSelected(new Map());
    setQuery("");
    setResults([]);
  }

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
        if (!res.ok) { setResults([]); return; }
        const body = (await res.json()) as { items: QbItemHit[] };
        setResults(body.items);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="space-y-1">
      {/* Selection tray — ABOVE the search box so the open results dropdown
          (absolute, below the input) never covers it. Persists across
          searches until added or cleared. */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-accent-primary/30 bg-accent-primary/5 px-2 py-1.5">
          {Array.from(selected.values()).map((item) => (
            <button
              key={item.id}
              type="button"
              title="Remove from selection"
              onClick={() => toggle(item)}
              className="inline-flex items-center gap-1 rounded bg-base px-1.5 py-0.5 text-xs font-mono text-primary ring-1 ring-default hover:text-accent-danger"
            >
              {item.sku ?? item.id} <span aria-hidden="true">×</span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={isAdding}
              onClick={() => setSelected(new Map())}
              className="text-xs text-muted hover:text-primary disabled:opacity-50"
            >
              Clear
            </button>
            <Button size="sm" disabled={isAdding} loading={isAdding} onClick={addSelected}>
              Add {selected.size} selected
            </Button>
          </div>
        </div>
      )}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search QB items by SKU or name…"
          className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
          onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setResults([]); } }}
        />
        {query.trim().length >= 2 && (
          <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-default bg-base shadow-lg">
            {loading && <div className="px-3 py-2 text-xs text-muted">Searching…</div>}
            {!loading && results.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted">No matches.</div>
            )}
            {!loading && results.some((r) => !existingIds.has(r.id)) && (
              <div className="flex items-center justify-between border-b border-default bg-subtle px-3 py-1.5 text-xs text-muted">
                <span>{results.length} match{results.length === 1 ? "" : "es"}</span>
                <button
                  type="button"
                  className="font-medium text-accent-primary hover:underline"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev);
                      for (const r of results) if (!existingIds.has(r.id)) next.set(r.id, r);
                      return next;
                    })
                  }
                >
                  Select all {results.filter((r) => !existingIds.has(r.id)).length}
                </button>
              </div>
            )}
            {results.map((item) => {
              const alreadyAdded = existingIds.has(item.id);
              const checked = selected.has(item.id);
              return (
                <label
                  key={item.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-elevated",
                    alreadyAdded && "cursor-default opacity-60",
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-accent-primary"
                    checked={alreadyAdded || checked}
                    disabled={alreadyAdded || isAdding}
                    onChange={() => toggle(item)}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{item.sku ?? item.id}</span>
                    <span className="ml-2 text-sm text-secondary">{item.name}</span>
                  </div>
                  {alreadyAdded && (
                    <span className="text-xs text-muted shrink-0">Added</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {lastResult && selected.size === 0 && !addError && (
        <div className="text-xs text-secondary">
          Added {lastResult.added.length}
          {lastResult.skipped > 0 && `, ${lastResult.skipped} already in season`}
          {lastResult.failed.length > 0 && (
            <span className="ml-1 text-accent-danger">
              ({lastResult.failed.length} failed: {lastResult.failed.map((f) => f.reason).join("; ")})
            </span>
          )}
        </div>
      )}
      {addError && (
        <div className="flex items-center gap-1 text-xs text-accent-danger">
          <AlertCircle className="size-3 shrink-0" />
          {addError}
        </div>
      )}
    </div>
  );
}
