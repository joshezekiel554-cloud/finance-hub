import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Eye, Loader2 } from "lucide-react";
import { api, type SettingsPreviewResponse, type SettingsResponse } from "./api";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { NUMBERED_PRESETS, presetLabel, type NumberedPreset } from "../../modules/hold-orders/presets";
import type { HoldsConfig, HoldsConfigPatch, HoldsSettingsSection } from "../../modules/hold-orders/holds-settings";
import {
  EXCLUSION_LABELS,
  FIELD_META,
  PRESET_NUMBER_LABELS,
  SECTION_FIELDS,
  SECTION_INTROS,
  SECTION_TITLES,
  defaultRuleBanner,
  draftFromConfig,
  draftToPatch,
  formatSettingValue,
  sectionHasChanges,
  type PresetNumberField,
  type ScalarField,
  type SettingsDraft,
} from "./lib/settings-form";
import { formatDate } from "./lib/view";
import { cn } from "../lib/cn";

export function SettingsPanel({ onOpenOrder }: { onOpenOrder: (orderId: string) => void }) {
  const q = useQuery({ queryKey: ["holds-settings"], queryFn: api.settings });
  // Lives here so the "Saved" note survives the form remount after a save.
  const [saved, setSaved] = useState<string | null>(null);
  if (q.isLoading) {
    return (
      <p className="flex items-center gap-2 py-10 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" /> Loading settings…
      </p>
    );
  }
  if (q.error || !q.data) {
    return <p className="py-10 text-sm text-accent-danger">Couldn't load settings: {(q.error as Error | null)?.message ?? ""}</p>;
  }
  return <SettingsForm key={JSON.stringify(q.data.values)} data={q.data} saved={saved} setSaved={setSaved} onOpenOrder={onOpenOrder} />;
}

function SettingsForm({
  data,
  saved,
  setSaved,
  onOpenOrder,
}: {
  data: SettingsResponse;
  saved: string | null;
  setSaved: (s: string | null) => void;
  onOpenOrder: (orderId: string) => void;
}) {
  const qc = useQueryClient();
  const canEdit = data.canEdit;
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromConfig(data.values));
  const result = useMemo(() => draftToPatch(draft, data.values), [draft, data.values]);
  const errors = result.ok ? {} : result.errors;
  const changed = result.ok ? result.changed : [];
  const [review, setReview] = useState<{ patch: HoldsConfigPatch; preview: SettingsPreviewResponse } | null>(null);

  // Any edit invalidates a shown preview.
  useEffect(() => setReview(null), [draft]);

  const preview = useMutation({
    mutationFn: (patch: HoldsConfigPatch) => api.previewSettings(patch),
    onSuccess: (p, patch) => setReview({ patch, preview: p }),
  });
  const save = useMutation({
    mutationFn: (patch: HoldsConfigPatch) => api.saveSettings(patch),
    onSuccess: (r) => {
      setSaved(`Saved ${r.changed.length} setting${r.changed.length === 1 ? "" : "s"}.`);
      setReview(null);
      void qc.invalidateQueries({ queryKey: ["holds-settings"] });
      void qc.invalidateQueries({ queryKey: ["holds-rules"] });
      void qc.invalidateQueries({ queryKey: ["holds-list"] });
    },
  });

  const setField = (f: ScalarField, v: string | boolean) => {
    setSaved(null);
    setDraft((d) => ({ ...d, fields: { ...d.fields, [f]: v } }));
  };
  const setPreset = (p: NumberedPreset, n: PresetNumberField, v: string) => {
    setSaved(null);
    setDraft((d) => ({ ...d, presets: { ...d.presets, [p]: { ...d.presets[p], [n]: v } } }));
  };
  const live: HoldsConfig = result.ok ? result.config : data.values;
  const banner = defaultRuleBanner(data.values);

  const fieldProps = { draft, setField, errors, defaults: data.defaults, values: data.values, canEdit };

  return (
    <div className="pb-24">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-primary">Settings</h2>
        {!canEdit ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-xs text-secondary">
            <Eye className="size-3.5" aria-hidden /> View only — ask Josh or Shaya to change these
          </span>
        ) : null}
      </div>

      {banner ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-sm text-primary">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-warning" aria-hidden />
          <span>
            <span className="font-semibold">{banner}.</span> b2b customers without a rule of their own are not held by invoice age.
            {canEdit ? " Run a dry run below before switching it on." : ""}
          </span>
        </div>
      ) : null}

      <Section id="standard" data={data} changed={changed}>
        <Field f="overdueThresholdGbp" {...fieldProps} />
        <Field f="noContactDays" {...fieldProps} />
        <Field f="overdueRecipients" {...fieldProps} />
        <Field f="holdAlertLookbackDays" {...fieldProps} />
        <Field f="overdueAlertLookbackDays" {...fieldProps} />
        <div className="rounded-lg border border-default bg-base p-3">
          <h4 className="mb-2 text-sm font-semibold text-primary">Default rule</h4>
          <Field f="defaultRuleEnabled" {...fieldProps} />
          <Field f="defaultRulePreset" {...fieldProps} presetTable={live.presets} />
          <Field f="defaultRuleScope" {...fieldProps} />
          <p className="mt-1 text-xs text-muted">
            Covers {data.defaultRuleScopeCount} b2b customer{data.defaultRuleScopeCount === 1 ? "" : "s"} who don't have a rule of their own today.
          </p>
          {canEdit ? <DefaultRuleDryRun draftPreset={live.defaultRulePreset} presetsPatch={live.presets} onOpenOrder={onOpenOrder} /> : null}
        </div>
      </Section>

      <Section id="presets" data={data} changed={changed}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {NUMBERED_PRESETS.map((p) => (
            <div key={p} className="rounded-lg border border-default bg-base p-3">
              <h4 className="mb-2 text-sm font-semibold text-primary">{presetLabel(p, live.presets)}</h4>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(PRESET_NUMBER_LABELS) as PresetNumberField[]).map((n) => {
                  const err = errors[`presets.${p}.${n}`];
                  return (
                    <label key={n} className="block text-xs text-secondary">
                      {PRESET_NUMBER_LABELS[n]}
                      <Input
                        inputMode="decimal"
                        value={draft.presets[p][n]}
                        disabled={!canEdit}
                        onChange={(e) => setPreset(p, n, e.target.value.replace(/[^\d.]/g, ""))}
                        className={cn("mt-1", err ? "border-accent-danger" : "")}
                        aria-invalid={Boolean(err)}
                      />
                      <span className="mt-0.5 block text-[11px] text-muted">Default {data.defaults.presets[p][n]}</span>
                      {err ? <span className="block text-[11px] text-accent-danger">{err}</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted">
          An order is held when any open invoice is older (from its invoice date) than “hold when older than” and the customer owes at least the
          min balance. Terms is informational.
        </p>
        <Field f="defaultMinBalance" {...fieldProps} />
      </Section>

      <Section id="flags" data={data} changed={changed}>
        <p className="text-xs text-secondary">
          An open order shows on At risk when a customer rule would hold it, when the customer's account is on hold / prepay unpaid, or when the
          customer owes at least the overdue review threshold ({formatSettingValue("overdueThresholdGbp", live)}) and hasn't been in contact for{" "}
          {formatSettingValue("noContactDays", live)} (both under Standard rules).
        </p>
        <Field f="ruleOrderLookbackDays" {...fieldProps} />
        <Field f="overdueWidgetLookbackDays" {...fieldProps} />
      </Section>

      <Section id="ladder" data={data} changed={changed}>
        <p className="text-xs text-secondary">Day 0: “your order is on hold” notice. Then the warning, then the cancel notice to the warehouse + team.</p>
        <Field f="warnDays" {...fieldProps} />
        <Field f="cancelDays" {...fieldProps} />
        <Field f="warehouseRecipients" {...fieldProps} />
        <Field f="teamRecipients" {...fieldProps} />
      </Section>

      <Section id="autoRelease" data={data} changed={changed}>
        <Field f="autoReleaseEmailsWarehouse" {...fieldProps} />
        <Field f="ruleHoldsRespectPromise" {...fieldProps} />
      </Section>

      <Section id="exclusions" data={data} changed={changed}>
        <Exclusions onOpenOrder={onOpenOrder} />
      </Section>

      {canEdit ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-default bg-base/95 backdrop-blur">
          <div className="mx-auto max-w-6xl px-4 py-3 md:px-6">
            {review ? (
              <ReviewPanel review={review} onOpenOrder={onOpenOrder} />
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-secondary">
                {!result.ok
                  ? "Fix the highlighted settings first."
                  : changed.length === 0
                    ? saved ?? "No changes."
                    : `${changed.length} change${changed.length === 1 ? "" : "s"} not saved yet.`}
              </span>
              <div className="ml-auto flex gap-2">
                {changed.length > 0 ? (
                  <Button variant="ghost" onClick={() => setDraft(draftFromConfig(data.values))}>
                    Undo
                  </Button>
                ) : null}
                {review ? (
                  <Button loading={save.isPending} onClick={() => save.mutate(review.patch)}>
                    Save
                  </Button>
                ) : (
                  <Button
                    loading={preview.isPending}
                    disabled={!result.ok || changed.length === 0}
                    onClick={() => result.ok && preview.mutate(result.patch)}
                  >
                    Preview changes
                  </Button>
                )}
              </div>
            </div>
            {preview.error || save.error ? (
              <p className="mt-1 text-xs text-accent-danger">{((preview.error ?? save.error) as Error).message}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({
  id,
  data,
  changed,
  children,
}: {
  id: HoldsSettingsSection;
  data: SettingsResponse;
  changed: readonly (keyof HoldsConfig)[];
  children: ReactNode;
}) {
  const last = data.lastChanged?.[id] ?? null;
  const dirty = sectionHasChanges(id, changed);
  return (
    <section aria-labelledby={`s-${id}`} className="mb-4 rounded-xl border border-default bg-subtle p-3 sm:p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h3 id={`s-${id}`} className="text-sm font-semibold text-primary">
          {SECTION_TITLES[id]}
        </h3>
        {dirty ? <span className="text-xs font-medium text-accent-warning">edited</span> : null}
      </div>
      <p className="mb-3 text-xs text-secondary">{SECTION_INTROS[id]}</p>
      <div className="space-y-3">{children}</div>
      {last && SECTION_FIELDS[id].length > 0 ? (
        <p className="mt-3 text-[11px] text-muted">
          Changed by {last.by ?? "someone"} on {formatDate(last.at)}
        </p>
      ) : null}
    </section>
  );
}

function Field({
  f,
  draft,
  setField,
  errors,
  defaults,
  values,
  canEdit,
  presetTable,
}: {
  f: ScalarField;
  draft: SettingsDraft;
  setField: (f: ScalarField, v: string | boolean) => void;
  errors: Record<string, string>;
  defaults: HoldsConfig;
  values: HoldsConfig;
  canEdit: boolean;
  presetTable?: HoldsConfig["presets"];
}) {
  const meta = FIELD_META[f];
  const err = errors[f];
  const v = draft.fields[f];
  const id = `f-${f}`;
  let control: ReactNode;
  if (meta.kind === "bool") {
    control = (
      <label className="flex items-center gap-2 text-sm text-primary">
        <input id={id} type="checkbox" checked={Boolean(v)} disabled={!canEdit} onChange={(e) => setField(f, e.target.checked)} />
        {v ? "On" : "Off"}
      </label>
    );
  } else if (meta.kind === "preset") {
    control = (
      <Select id={id} value={String(v)} disabled={!canEdit} onChange={(e) => setField(f, e.target.value)}>
        {NUMBERED_PRESETS.map((p) => (
          <option key={p} value={p}>
            {presetLabel(p, presetTable ?? values.presets)}
          </option>
        ))}
      </Select>
    );
  } else if (meta.kind === "scope") {
    control = <p className="text-sm text-primary">{formatSettingValue(f, values)}</p>;
  } else {
    control = (
      <div className="flex items-center gap-2">
        {meta.unit && meta.kind === "money" ? <span className="text-sm text-muted">{meta.unit}</span> : null}
        <Input
          id={id}
          value={String(v)}
          disabled={!canEdit}
          inputMode={meta.kind === "emails" ? "email" : meta.kind === "int" ? "numeric" : "decimal"}
          onChange={(e) => setField(f, meta.kind === "emails" ? e.target.value : e.target.value.replace(/[^\d.]/g, ""))}
          className={cn(meta.kind === "emails" ? "w-full" : "w-28", err ? "border-accent-danger" : "")}
          aria-invalid={Boolean(err)}
          aria-describedby={`${id}-help`}
        />
        {meta.unit && meta.kind === "int" ? <span className="text-sm text-muted">{meta.unit}</span> : null}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4">
      <label htmlFor={id} className="text-sm font-medium text-primary">
        {meta.label}
      </label>
      <div className="min-w-0">
        {control}
        <p id={`${id}-help`} className="mt-1 text-xs text-secondary">
          {meta.help} <span className="text-muted">Default: {formatSettingValue(f, defaults)}.</span>
        </p>
        {err ? <p className="text-xs text-accent-danger">{err}</p> : null}
      </div>
    </div>
  );
}

function OrderList({ orders, onOpenOrder }: { orders: SettingsPreviewResponse["draft"]["hold"]["orders"]; onOpenOrder: (id: string) => void }) {
  if (orders.length === 0) return null;
  return (
    <ul className="mt-1 max-h-40 space-y-1 overflow-auto text-xs">
      {orders.map((o) => (
        <li key={o.orderId}>
          <button type="button" onClick={() => onOpenOrder(o.orderId)} className="text-left hover:underline">
            <span className="font-medium tabular-nums">{o.orderNumber ?? o.orderId}</span> · {o.customerName ?? "—"}
            <span className="block text-muted">{o.reason}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReviewPanel({
  review,
  onOpenOrder,
}: {
  review: { preview: SettingsPreviewResponse };
  onOpenOrder: (id: string) => void;
}) {
  const { draft, current } = review.preview;
  return (
    <div className="mb-2 max-h-[45vh] overflow-auto rounded-lg border border-default bg-subtle p-3 text-sm">
      <p className="font-medium text-primary">With these settings, today:</p>
      <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="text-primary">
            Would hold <strong>{draft.hold.count}</strong> order{draft.hold.count === 1 ? "" : "s"}{" "}
            <span className="text-muted">(now {current.hold})</span>
          </p>
          <OrderList orders={draft.hold.orders} onOpenOrder={onOpenOrder} />
        </div>
        <div>
          <p className="text-primary">
            Would flag <strong>{draft.flag.count}</strong> order{draft.flag.count === 1 ? "" : "s"} for review{" "}
            <span className="text-muted">(now {current.flag})</span>
          </p>
          <OrderList orders={draft.flag.orders} onOpenOrder={onOpenOrder} />
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Dry run only — nothing was held or emailed. Saving applies on the next orders sync.</p>
    </div>
  );
}

function DefaultRuleDryRun({
  draftPreset,
  presetsPatch,
  onOpenOrder,
}: {
  draftPreset: NumberedPreset;
  presetsPatch: HoldsConfig["presets"];
  onOpenOrder: (id: string) => void;
}) {
  const run = useMutation({
    mutationFn: () => api.previewSettings({ defaultRuleEnabled: true, defaultRulePreset: draftPreset, presets: presetsPatch }),
  });
  const d = run.data;
  return (
    <div className="mt-2">
      <Button variant="secondary" size="sm" loading={run.isPending} onClick={() => run.mutate()}>
        Dry run: who would it hold today?
      </Button>
      {run.error ? <p className="mt-1 text-xs text-accent-danger">{(run.error as Error).message}</p> : null}
      {d ? (
        <div className="mt-2 rounded-lg border border-default bg-subtle p-2 text-sm">
          <p className="text-primary">
            With the default rule on ({presetLabel(draftPreset, presetsPatch)}): would hold <strong>{d.draft.hold.count}</strong> order
            {d.draft.hold.count === 1 ? "" : "s"} today <span className="text-muted">(now {d.current.hold})</span>.
          </p>
          <OrderList orders={d.draft.hold.orders} onOpenOrder={onOpenOrder} />
          <p className="mt-1 text-xs text-muted">Dry run only — nothing was held or emailed.</p>
        </div>
      ) : null}
    </div>
  );
}

function Exclusions({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const q = useQuery({ queryKey: ["holds-exclusions"], queryFn: api.exclusions, staleTime: 60_000 });
  if (q.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  }
  if (q.error || !q.data) return <p className="text-sm text-accent-danger">Couldn't load exclusions.</p>;
  const financeUrl = q.data.financeUrl;
  return (
    <ul className="space-y-2">
      {q.data.groups.map((g) => (
        <li key={g.kind} className="rounded-lg border border-default bg-base">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 px-3 py-2">
              <span className="text-sm font-medium text-primary">{EXCLUSION_LABELS[g.kind].title}</span>
              <span className="rounded-full bg-elevated px-1.5 text-xs tabular-nums text-secondary">{g.count}</span>
              <span className="w-full text-xs text-muted sm:w-auto">{EXCLUSION_LABELS[g.kind].help}</span>
            </summary>
            {g.items.length === 0 ? (
              <p className="px-3 pb-2 text-xs text-muted">Nobody.</p>
            ) : (
              <ul className="max-h-60 overflow-auto border-t border-default text-sm">
                {g.items.map((it) => (
                  <li key={`${it.customerId}-${it.orderId ?? ""}`} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-1.5">
                    <span className="truncate text-primary">{it.customerName ?? it.customerId}</span>
                    <span className="flex gap-3 text-xs">
                      {it.orderId ? (
                        <button type="button" onClick={() => onOpenOrder(it.orderId!)} className="text-accent-primary hover:underline">
                          {it.orderNumber ?? "Open order"}
                        </button>
                      ) : null}
                      {financeUrl && it.customerId ? (
                        <a href={`${financeUrl}/customers/${it.customerId}`} target="_blank" rel="noreferrer" className="text-accent-primary hover:underline">
                          Customer page
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
                {g.count > g.items.length ? <li className="px-3 py-1.5 text-xs text-muted">…and {g.count - g.items.length} more</li> : null}
              </ul>
            )}
          </details>
        </li>
      ))}
    </ul>
  );
}
