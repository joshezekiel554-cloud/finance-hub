import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import { api, type CustomerHit, type StoredRule } from "./api";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { HOLD_RULE_PRESETS, PRESET_NUMBERS, describeRule, presetLabel, type PresetTable } from "../../modules/hold-orders/presets";
import { BulkPicker } from "./BulkPicker";
import { defaultRuleBanner } from "./lib/settings-form";
import { NEW_RULE_DRAFT, displayNumbers, draftFromRule, draftToBody, type RuleDraft } from "./lib/rule-form";
import { formatDate, formatMoney } from "./lib/view";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Picked = { id: string; name: string };

export function RulesPanel({
  canEdit,
  onOpenOrder,
  onOpenSettings,
}: {
  canEdit: boolean;
  onOpenOrder: (orderId: string) => void;
  onOpenSettings: () => void;
}) {
  const rules = useQuery({ queryKey: ["holds-rules"], queryFn: api.rules });
  const settings = useQuery({ queryKey: ["holds-settings"], queryFn: api.settings, staleTime: 60_000 });
  const presets = settings.data?.values.presets ?? PRESET_NUMBERS;
  const defaultOn = settings.data?.values.defaultRuleEnabled ?? false;
  const banner = settings.data ? defaultRuleBanner(settings.data.values) : null;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [bulk, setBulk] = useState(false);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section aria-label="Customers with a rule">
        <h2 className="mb-1 text-sm font-semibold text-primary">Customers with their own rule</h2>
        <p className="mb-3 text-xs text-secondary">
          {defaultOn
            ? `Every other b2b customer runs on the default rule (${presetLabel(settings.data!.values.defaultRulePreset, presets)}); everyone else follows the standard hold checks.`
            : "Everyone else follows the standard hold checks. A rule only applies to the customer it's set on."}
        </p>
        {banner ? (
          <p className="mb-3 flex flex-wrap items-center gap-x-2 rounded-lg border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-xs text-primary">
            <AlertTriangle className="size-3.5 text-accent-warning" aria-hidden />
            <span className="font-medium">{banner}</span>
            <span className="text-secondary">— b2b customers without a rule of their own are not held by invoice age.</span>
            <button type="button" onClick={onOpenSettings} className="font-medium text-accent-primary hover:underline">
              Settings
            </button>
          </p>
        ) : null}
        {canEdit ? (
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="min-w-0 flex-1">
              <CustomerSearch onPick={setPicked} />
            </div>
            {!bulk ? (
              <Button variant="secondary" onClick={() => setBulk(true)}>
                Select customers
              </Button>
            ) : null}
          </div>
        ) : null}
        {canEdit && bulk ? (
          <BulkPicker presets={presets} defaultRuleOn={defaultOn} onClose={() => setBulk(false)} onOpenOrder={onOpenOrder} />
        ) : null}
        {rules.isLoading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : (rules.data?.rules.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-dashed border-default py-8 text-center text-sm text-muted">No customer rules yet.</p>
        ) : (
          <ul className="divide-y divide-default overflow-hidden rounded-xl border border-default">
            {rules.data!.rules.map((r) => (
              <RuleRow key={r.customerId} rule={r} active={picked?.id === r.customerId} onClick={() => setPicked({ id: r.customerId, name: r.customerName ?? r.customerId })} />
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Rule editor">
        {picked ? (
          <RuleEditor key={picked.id} customer={picked} presets={presets} canEdit={canEdit} onOpenOrder={onOpenOrder} onClose={() => setPicked(null)} />
        ) : (
          <p className="rounded-xl border border-dashed border-default p-6 text-sm text-muted">
            {canEdit ? "Search for a customer, or pick one from the list, to set their rule." : "Pick a customer to see their rule. Only admins can change rules."}
          </p>
        )}
      </section>
    </div>
  );
}

function RuleRow({ rule, active, onClick }: { rule: StoredRule; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className={`w-full px-4 py-2.5 text-left hover:bg-subtle ${active ? "bg-subtle" : ""}`}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-primary">{rule.customerName ?? rule.customerId}</span>
          <Badge tone={rule.preset === "never" ? "neutral" : "info"}>{describeRule(rule)}</Badge>
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {[
            rule.notifyWarehouse ? "emails warehouse" : "warehouse not emailed",
            rule.autoStartLadder ? "chases customer" : "no customer emails",
            rule.autoReleaseOnPayment ? "auto-releases on payment" : "manual release only",
          ].join(" · ")}{" "}
          · set {formatDate(rule.setAt)}
        </div>
      </button>
    </li>
  );
}

function CustomerSearch({ onPick }: { onPick: (c: Picked) => void }) {
  const [value, setValue] = useState("");
  const q = useDebounced(value.trim(), 250);
  const res = useQuery({ queryKey: ["holds-customers", q], queryFn: () => api.customers(q), enabled: q.length >= 2 });
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Find a customer to set a rule" className="pl-8" aria-label="Find a customer" />
      {q.length >= 2 && res.data ? (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-default bg-base shadow-lg">
          {res.data.customers.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted">No customer matches.</li>
          ) : (
            res.data.customers.map((c: CustomerHit) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-subtle"
                  onClick={() => {
                    setValue("");
                    onPick({ id: c.id, name: c.name });
                  }}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {c.paymentTerms ?? "—"} · {formatMoney(c.overdueBalance)} overdue
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

function RuleEditor({
  customer,
  presets,
  canEdit,
  onOpenOrder,
  onClose,
}: {
  customer: Picked;
  presets: PresetTable;
  canEdit: boolean;
  onOpenOrder: (id: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ["holds-rule", customer.id], queryFn: () => api.rule(customer.id) });
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  useEffect(() => {
    if (existing.data && draft === null) {
      setDraft(existing.data.rule ? draftFromRule(existing.data.rule) : NEW_RULE_DRAFT);
    }
  }, [existing.data, draft]);

  const body = useMemo(() => (draft ? draftToBody(draft) : null), [draft]);
  const debouncedBody = useDebounced(body, 400);
  const preview = useQuery({
    queryKey: ["holds-rule-preview", customer.id, debouncedBody && debouncedBody.ok ? debouncedBody.body : null],
    queryFn: () => api.previewRule(customer.id, (debouncedBody as { ok: true; body: Record<string, unknown> }).body),
    enabled: canEdit && Boolean(debouncedBody?.ok),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["holds-rules"] });
    void qc.invalidateQueries({ queryKey: ["holds-rule", customer.id] });
    void qc.invalidateQueries({ queryKey: ["holds-list"] });
  };
  const save = useMutation({
    mutationFn: () => api.saveRule(customer.id, (body as { ok: true; body: Record<string, unknown> }).body),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: () => api.deleteRule(customer.id), onSuccess: () => { invalidate(); onClose(); } });

  if (!draft) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" /> Loading rule…
      </p>
    );
  }
  const nums = displayNumbers(draft, presets);
  const set = (patch: Partial<RuleDraft>) => setDraft({ ...draft, ...patch });
  const disabled = !canEdit;

  return (
    <div className="rounded-xl border border-default bg-subtle p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="truncate text-base font-semibold text-primary">{customer.name}</h2>
        <button type="button" onClick={onClose} className="text-xs text-muted hover:text-primary">
          Close
        </button>
      </div>
      {existing.data?.rule ? null : <p className="mb-3 text-xs text-secondary">No rule yet — this customer follows the standard checks.</p>}

      <fieldset disabled={disabled} className="space-y-3">
        <label className="block text-xs text-secondary">
          Rule
          <Select value={draft.preset} onChange={(e) => set({ preset: e.target.value as RuleDraft["preset"] })} className="mt-1">
            {HOLD_RULE_PRESETS.map((p) => (
              <option key={p} value={p}>
                {presetLabel(p, presets)}
              </option>
            ))}
          </Select>
        </label>

        {draft.preset === "custom" ? (
          <div className="grid grid-cols-3 gap-2">
            <NumField label="Terms (days)" value={draft.termsDays} onChange={(v) => set({ termsDays: v })} />
            <NumField label="Hold when older than (days)" value={draft.holdWhenInvoiceDaysOver} onChange={(v) => set({ holdWhenInvoiceDaysOver: v })} />
            <NumField label="Min balance ($)" value={draft.minBalance} onChange={(v) => set({ minBalance: v })} />
          </div>
        ) : nums ? (
          <p className="text-xs text-secondary">
            Terms {nums.termsDays} days. Holds new orders when any open invoice is more than {nums.holdWhenInvoiceDaysOver} days old
            (from the invoice date){nums.minBalance > 0 ? ` and they owe at least ${formatMoney(nums.minBalance)}` : ""}.
          </p>
        ) : (
          <p className="text-xs text-secondary">
            Never held automatically by invoice age, and left out of the overdue-review check. Manual holds and account holds still apply.
          </p>
        )}

        {draft.preset !== "never" ? (
          <div className="space-y-1.5">
            <Toggle checked={draft.notifyWarehouse} onChange={(v) => set({ notifyWarehouse: v })} label="Email the warehouse when it holds an order" />
            <Toggle checked={draft.autoStartLadder} onChange={(v) => set({ autoStartLadder: v })} label="Chase the customer by email (Day-0 / 7 / 10)" />
            <Toggle
              checked={draft.autoReleaseOnPayment}
              onChange={(v) => set({ autoReleaseOnPayment: v })}
              label="Release automatically once QBO shows it's paid"
            />
          </div>
        ) : null}

        <label className="block text-xs text-secondary">
          Note
          <Input value={draft.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} className="mt-1" placeholder="Why this customer is different" />
        </label>
      </fieldset>

      {body && !body.ok ? <p className="mt-3 text-xs text-accent-danger">{body.error}</p> : null}

      {canEdit && body?.ok ? (
        <div className="mt-4 rounded-lg border border-default bg-base p-3 text-sm">
          {preview.isFetching && !preview.data ? (
            <span className="flex items-center gap-2 text-xs text-muted">
              <Loader2 className="size-3.5 animate-spin" /> Checking today's orders…
            </span>
          ) : preview.data ? (
            <>
              <p className="font-medium text-primary">
                {preview.data.orders.length === 0
                  ? "Would hold no orders today."
                  : `Would hold ${preview.data.orders.length} order${preview.data.orders.length === 1 ? "" : "s"} today`}
              </p>
              {preview.data.evaluation.why ? <p className="mt-0.5 text-xs text-secondary">{preview.data.evaluation.why}</p> : null}
              <p className="mt-0.5 text-xs text-muted">Open balance {formatMoney(preview.data.evaluation.openBalance)}</p>
              {preview.data.orders.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {preview.data.orders.map((o) => (
                    <li key={o.orderId}>
                      <button type="button" onClick={() => onOpenOrder(o.orderId)} className="rounded-md bg-elevated px-2 py-0.5 text-xs tabular-nums hover:bg-subtle">
                        {o.orderNumber ?? o.orderId} · {formatMoney(o.total)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 text-xs text-muted">Saving applies on the next orders sync (about every 15 minutes).</p>
            </>
          ) : null}
        </div>
      ) : null}

      {canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button loading={save.isPending} disabled={!body?.ok} onClick={() => save.mutate()}>
            Save rule
          </Button>
          {existing.data?.rule ? (
            <Button variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove rule (back to standard)
            </Button>
          ) : null}
          {save.isSuccess ? <span className="self-center text-xs text-accent-success">Saved.</span> : null}
          {save.error || remove.error ? (
            <span className="self-center text-xs text-accent-danger">{((save.error ?? remove.error) as Error).message}</span>
          ) : null}
        </div>
      ) : null}
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-start gap-2 text-sm text-primary">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
