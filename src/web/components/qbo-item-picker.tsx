// QboItemPicker — debounced QBO item autocomplete used wherever the
// operator needs to attach a QBO Item to a row (RMA wizard items
// table, receipt-review "Add unexpected item" form, anywhere else that
// needs the same affordance).
//
// Lives here as a shared component rather than inside any single
// caller — was duplicated previously, now shared. Hits the existing
// /api/invoicing/items/search?q=... endpoint with a 250ms debounce.

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

export type QbItemHit = {
  id: string;
  name: string;
  sku: string | null;
  unitPrice: number | null;
  type: string | null;
};

export function QboItemPicker({
  onPick,
  initialQuery,
  parsedHint,
}: {
  onPick: (item: QbItemHit) => void;
  // Optional initial value for the search box — useful when the row
  // already has a parsed SKU we want to seed.
  initialQuery?: string;
  // Optional small hint shown above the input when the SKU was
  // auto-extracted from a parsed source (e.g. an Extensiv receipt).
  parsedHint?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [results, setResults] = useState<QbItemHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/invoicing/items/search?q=${encodeURIComponent(trimmed)}`,
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(body.error ?? `Search failed (${res.status})`);
          setResults([]);
          return;
        }
        const body = (await res.json()) as { items: QbItemHit[] };
        setResults(body.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="relative">
      {parsedHint && (
        <div className="mb-1 flex items-center gap-1 text-[10px] text-muted">
          <Sparkles className="size-3 shrink-0 text-accent-info" />
          <span>
            Parsed: <span className="font-medium">{parsedHint}</span> —
            confirm QBO item below.
          </span>
        </div>
      )}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search QB items (SKU or name)…"
        className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm text-primary"
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
          {!loading && error && (
            <div className="px-3 py-2 text-xs text-accent-danger">
              {error}
            </div>
          )}
          {!loading && !error && results.length === 0 && (
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
