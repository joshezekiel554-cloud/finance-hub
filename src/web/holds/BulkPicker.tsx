import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, X } from "lucide-react";
import { api, ApiError, type BulkPreviewResponse } from "./api";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { HOLD_RULE_PRESETS, presetLabel, type HoldRulePreset, type PresetTable } from "../../modules/hold-orders/presets";
import { NEW_RULE_DRAFT, displayNumbers, draftToBody, type RuleDraft } from "./lib/rule-form";
import {
  BULK_PICK_MAX,
  allVisibleTicked,
  applySummary,
  currentRuleLabel,
  filterRows,
  skippedCount,
  toggleAllVisible,
  toggleId,
} from "./lib/bulk-picker";
import { CANDIDATE_SOURCE_LABELS, type CandidateSource } from "./lib/settings-form";
import { formatDateTime, formatMoney } from "./lib/view";

const SOURCES: CandidateSource[] = ["shopify_b2b", "finance_b2b", "no_rule", "preset"];

export function BulkPicker({
  presets,
  defaultRuleOn,
  onClose,
  onOpenOrder,
}: {
  presets: PresetTable;
  defaultRuleOn: boolean;
  onClose: () => void;
  onOpenOrder: (orderId: string) => void;
}) {
  const qc = useQueryClient();
  const [source, setSource] = useState<CandidateSource>("finance_b2b");
  const [sourcePreset, setSourcePreset] = useState<HoldRulePreset>("standard_30_45");
  const [search, setSearch] = useState("");
  // "Has no rule yet": b2b only unless this is ticked.
  const [allTypes, setAllTypes] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<RuleDraft>(NEW_RULE_DRAFT);
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<{ key: string; data: BulkPreviewResponse } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: ["holds-candidates", source, source === "preset" ? sourcePreset : null, source === "no_rule" && allTypes],
    queryFn: () => api.candidates(source, source === "preset" ? sourcePreset : undefined, source === "no_rule" && allTypes),
    staleTime: source === "shopify_b2b" ? 0 : 60_000,
    retry: false,
  });
  const rows = candidates.data?.rows ?? [];
  const visible = useMemo(() => filterRows(rows, search), [rows, search]);
  const body = draftToBody(draft);
  const ids = [...selected];
  const requestKey = JSON.stringify({ ids: ids.sort(), body: body.ok ? body.body : null, overwrite });
  const freshPreview = preview && preview.key === requestKey ? preview.data : null;

  const runPreview = useMutation({
    mutationFn: () => {
      if (!body.ok) throw new Error(body.error);
      return api.bulkPreview({ customerIds: ids, rule: body.body, overwrite });
    },
    onSuccess: (data) => setPreview({ key: requestKey, data }),
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!body.ok) throw new Error(body.error);
      return api.bulkApply({ customerIds: ids, rule: body.body, overwrite });
    },
    onSuccess: (r) => {
      setDone(applySummary(r));
      setSelected(new Set());
      setPreview(null);
      void qc.invalidateQueries({ queryKey: ["holds-rules"] });
      void qc.invalidateQueries({ queryKey: ["holds-candidates"] });
      void qc.invalidateQueries({ queryKey: ["holds-list"] });
    },
  });

  const set = (patch: Partial<RuleDraft>) => setDraft({ ...draft, ...patch });
  const nums = displayNumbers(draft, presets);
  const skipped = skippedCount(rows, selected, overwrite);
  const tooMany = selected.size > BULK_PICK_MAX;
  const candError = candidates.error instanceof ApiError ? candidates.error.message : candidates.error ? "Couldn't load customers." : null;

  return (
    <div className="mb-4 rounded-xl border border-default bg-subtle p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-primary">Set a rule on many customers</h3>
        <button type="button" onClick={onClose} className="text-muted hover:text-primary" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="block flex-1 text-xs text-secondary">
          Customers from
          <Select
            value={source}
            onChange={(e) => {
              setSource(e.target.value as CandidateSource);
              setSelected(new Set());
            }}
            className="mt-1"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {CANDIDATE_SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
        </label>
        {source === "preset" ? (
          <label className="block flex-1 text-xs text-secondary">
            Preset
            <Select
              value={sourcePreset}
              onChange={(e) => {
                setSourcePreset(e.target.value as HoldRulePreset);
                setSelected(new Set());
              }}
              className="mt-1"
            >
              {HOLD_RULE_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {presetLabel(p, presets)}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>

      {source === "no_rule" ? (
        <label className="mt-2 flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            checked={allTypes}
            onChange={(e) => {
              setAllTypes(e.target.checked);
              setSelected(new Set());
            }}
          />
          Include all customer types (default: b2b only)
        </label>
      ) : null}

      {source === "shopify_b2b" && candidates.data?.fetchedAt ? (
        <p className="mt-2 text-xs text-muted">
          Fetched from Shopify just now ({formatDateTime(candidates.data.fetchedAt)}) · {candidates.data.fetched ?? 0} tagged b2b ·{" "}
          {rows.length} in finance
        </p>
      ) : null}

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" className="pl-8" aria-label="Search customers" />
      </div>

      {candidates.isLoading ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {source === "shopify_b2b" ? "Fetching from Shopify…" : "Loading…"}
        </p>
      ) : candError ? (
        <p className="py-4 text-sm text-accent-danger">{candError}</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-secondary">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allVisibleTicked(selected, visible)}
                onChange={() => setSelected(toggleAllVisible(selected, visible))}
              />
              Tick all {search ? "shown" : ""} ({visible.length})
            </label>
            <span>
              {selected.size} ticked{tooMany ? ` — max ${BULK_PICK_MAX} at once` : ""}
            </span>
          </div>
          <ul className="mt-1 max-h-80 divide-y divide-default overflow-auto rounded-lg border border-default bg-base">
            {visible.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted">No customers here.</li>
            ) : (
              visible.map((r) => (
                <li key={r.id}>
                  <label className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-subtle">
                    <input type="checkbox" className="mt-1" checked={selected.has(r.id)} onChange={() => setSelected(toggleId(selected, r.id))} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-primary">{r.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {r.email ?? "no email"}
                        {r.overdueBalance && Number(r.overdueBalance) > 0 ? ` · ${formatMoney(r.overdueBalance)} overdue` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-secondary">{currentRuleLabel(r, defaultRuleOn)}</span>
                  </label>
                </li>
              ))
            )}
          </ul>
          {source === "shopify_b2b" && (candidates.data?.unmatched.length ?? 0) > 0 ? (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted">
                {candidates.data?.unmatchedCount ?? candidates.data?.unmatched.length} Shopify b2b customers aren't in finance/QBO (by email)
              </summary>
              <ul className="mt-1 max-h-48 overflow-auto rounded-lg border border-default bg-base">
                {candidates.data!.unmatched.map((u) => (
                  <li key={u.shopifyId} className="flex justify-between gap-2 px-3 py-1.5 text-muted opacity-70" aria-disabled>
                    <span className="truncate">{u.name}</span>
                    <span className="shrink-0">{u.email ?? "no email"} · not in finance/QBO</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      <fieldset className="mt-4 space-y-3 border-t border-default pt-3">
        <legend className="sr-only">Rule to apply</legend>
        <label className="block text-xs text-secondary">
          Rule to apply
          <Select value={draft.preset} onChange={(e) => set({ preset: e.target.value as RuleDraft["preset"] })} className="mt-1">
            {HOLD_RULE_PRESETS.map((p) => (
              <option key={p} value={p}>
                {presetLabel(p, presets)}
              </option>
            ))}
          </Select>
        </label>
        {draft.preset === "custom" ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <NumField label="Terms (days)" value={draft.termsDays} onChange={(v) => set({ termsDays: v })} />
            <NumField label="Hold when older than (days)" value={draft.holdWhenInvoiceDaysOver} onChange={(v) => set({ holdWhenInvoiceDaysOver: v })} />
            <NumField label="Min balance ($)" value={draft.minBalance} onChange={(v) => set({ minBalance: v })} />
          </div>
        ) : nums ? (
          <p className="text-xs text-secondary">
            Holds new orders when any open invoice is more than {nums.holdWhenInvoiceDaysOver} days old
            {nums.minBalance > 0 ? ` and they owe at least ${formatMoney(nums.minBalance)}` : ""}.
          </p>
        ) : null}
        {draft.preset !== "never" ? (
          <div className="space-y-1.5">
            <Check checked={draft.notifyWarehouse} onChange={(v) => set({ notifyWarehouse: v })} label="Email the warehouse when it holds an order" />
            <Check checked={draft.autoStartLadder} onChange={(v) => set({ autoStartLadder: v })} label="Chase the customer by email (Day-0 / warning / cancel)" />
            <Check checked={draft.autoReleaseOnPayment} onChange={(v) => set({ autoReleaseOnPayment: v })} label="Release automatically once QBO shows it's paid" />
          </div>
        ) : null}
        <Check checked={overwrite} onChange={setOverwrite} label="Overwrite customers who already have a rule" />
        {skipped > 0 ? <p className="text-xs text-accent-warning">{skipped} ticked customer{skipped === 1 ? "" : "s"} already have a rule and will be skipped.</p> : null}
        {!body.ok ? <p className="text-xs text-accent-danger">{body.error}</p> : null}
      </fieldset>

      {freshPreview ? (
        <div className="mt-3 rounded-lg border border-default bg-base p-3 text-sm">
          <p className="font-medium text-primary">
            {freshPreview.orderCount === 0
              ? "Would hold no orders today."
              : `Would hold ${freshPreview.orderCount} order${freshPreview.orderCount === 1 ? "" : "s"} today (${freshPreview.customersHit} customer${freshPreview.customersHit === 1 ? "" : "s"})`}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Rule goes on {freshPreview.targets} customer{freshPreview.targets === 1 ? "" : "s"}
            {freshPreview.skippedExisting ? ` · ${freshPreview.skippedExisting} skipped (already have a rule)` : ""}. Nothing is emailed now; holds and
            emails happen on the next orders sync.
          </p>
          {freshPreview.orders.length > 0 ? (
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-xs">
              {freshPreview.orders.map((o) => (
                <li key={o.orderId}>
                  <button type="button" onClick={() => onOpenOrder(o.orderId)} className="text-left hover:underline">
                    <span className="font-medium tabular-nums">{o.orderNumber ?? o.orderId}</span> · {o.customerName ?? "—"} · {formatMoney(o.total)}
                    <span className="block text-muted">{o.why}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          loading={runPreview.isPending}
          disabled={selected.size === 0 || tooMany || !body.ok}
          onClick={() => runPreview.mutate()}
        >
          Preview
        </Button>
        <Button loading={apply.isPending} disabled={!freshPreview || freshPreview.targets === 0 || tooMany} onClick={() => apply.mutate()}>
          Apply to {freshPreview?.targets ?? 0}
        </Button>
        {!freshPreview && selected.size > 0 ? <span className="text-xs text-muted">Preview first to see what it would hold.</span> : null}
        {runPreview.error || apply.error ? (
          <span className="text-xs text-accent-danger">{((runPreview.error ?? apply.error) as Error).message}</span>
        ) : null}
        {done ? <span className="text-xs text-accent-success">{done}</span> : null}
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-xs text-secondary">
      {label}
      <Input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} className="mt-1" />
    </label>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-start gap-2 text-sm text-primary">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
