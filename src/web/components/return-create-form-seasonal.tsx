// ReturnCreateFormSeasonal — seasonal / non-seasonal RMA creation form.
// Handles season picker, per-item classification dropdown, eligibility card,
// override toggle/reason, photos URL, and notes.
// Damage RMAs continue to use return-create-form-damage.tsx.

import { useCallback, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Select } from "./ui/select";
import RmaItemsTable, {
  type RmaItemRow,
  makeEmptyRow,
} from "./rma-items-table";
import EligibilityCard from "./eligibility-card";
import ParseEmailSection, { type ParsedItem } from "./parse-email-section";

// ---- Types ------------------------------------------------------------------

export type SeasonalFormState = {
  items: RmaItemRow[];
  itemClassifications: Record<string, string>; // localKey → classification
  seasonId: string | null;
  photosUrl: string;
  notes: string;
  overrideThreshold: boolean;
  overrideReason: string;
};

export type SeasonalFormProps = {
  rmaId: string | null;
  qbCustomerId?: string | null;
  returnType: "seasonal" | "non_seasonal";
  value: SeasonalFormState;
  onChange: (next: SeasonalFormState) => void;
  onApprove: (override: { enabled: boolean; reason: string }) => void;
  onDeny: () => void;
  disabled?: boolean;
  isSaving?: boolean;
  saveError?: string | null;
};

type Season = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
};

// Classification choices per return type
const CLASSIFICATION_OPTIONS_SEASONAL = [
  { value: "seasonal_current", label: "Current season" },
  { value: "seasonal_prior", label: "Prior season" },
  { value: "non_seasonal", label: "Non-seasonal (tag-along)" },
];

const CLASSIFICATION_OPTIONS_NON_SEASONAL = [
  { value: "non_seasonal", label: "Non-seasonal" },
];

// ---- Component --------------------------------------------------------------

export default function ReturnCreateFormSeasonal({
  rmaId,
  qbCustomerId = null,
  returnType,
  value,
  onChange,
  onApprove,
  onDeny,
  disabled = false,
  isSaving = false,
  saveError = null,
}: SeasonalFormProps) {
  const [overrideState, setOverrideState] = useState({ enabled: false, reason: "" });

  // Stable callback for eligibility card
  const handleOverrideChange = useCallback(
    (next: { enabled: boolean; reason: string }) => {
      setOverrideState(next);
    },
    [],
  );

  function patch(partial: Partial<SeasonalFormState>) {
    onChange({ ...value, ...partial });
  }

  function setClassification(localKey: string, classification: string) {
    patch({
      itemClassifications: { ...value.itemClassifications, [localKey]: classification },
    });
  }

  // Load active seasons for the picker
  const seasonsQuery = useQuery<{ seasons: Season[] }>({
    queryKey: ["seasons", "active"],
    queryFn: async () => {
      const res = await fetch("/api/seasons?active=true");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  // Build items with their current classification injected (for eligibility card)
  const itemsWithClassification = value.items.map((item) => ({
    classification:
      value.itemClassifications[item.localKey] ??
      defaultClassification(returnType),
    lineTotal: item.lineTotal,
  }));

  const hasItems = value.items.length > 0;
  const hasValidItems = value.items.every(
    (i) => i.qbItemId && parseFloat(i.quantity) > 0,
  );
  const canAction = !!rmaId && hasItems && hasValidItems && !isSaving && !disabled;

  // For seasonal: a season must be selected; for non_seasonal, optional
  const seasonRequired = returnType === "seasonal";
  const seasonMissing = seasonRequired && !value.seasonId;

  const classificationOptions =
    returnType === "seasonal"
      ? CLASSIFICATION_OPTIONS_SEASONAL
      : CLASSIFICATION_OPTIONS_NON_SEASONAL;

  function appendParsedItems(parsed: ParsedItem[]): void {
    const newRows: RmaItemRow[] = parsed.map((p) => ({
      ...makeEmptyRow(),
      qbItemId: "",
      sku: p.sku ?? "",
      name: p.name ?? "",
      quantity: p.quantity > 0 ? String(p.quantity) : "1",
      reason: p.reason ?? "",
    }));
    const newClassifications = { ...value.itemClassifications };
    for (const row of newRows) {
      newClassifications[row.localKey] = "seasonal_current";
    }
    patch({
      items: [...value.items, ...newRows],
      itemClassifications: newClassifications,
    });
  }

  return (
    <div className="space-y-6">
      {/* Parse customer email (optional) */}
      <ParseEmailSection
        onItemsParsed={appendParsedItems}
        disabled={disabled}
      />

      {/* Season picker — required for seasonal, optional for non-seasonal */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Season</h3>
          <p className="mt-0.5 text-xs text-secondary">
            {returnType === "seasonal"
              ? "Required for threshold eligibility checks."
              : "Optional — associate a season to see informational cumulative return totals."}
          </p>
        </CardHeader>
        <CardBody>
          {seasonsQuery.isPending ? (
            <div className="text-sm text-muted">Loading seasons…</div>
          ) : seasonsQuery.isError ? (
            <div className="flex items-center gap-1 text-sm text-accent-danger">
              <AlertCircle className="size-4 shrink-0" />
              Failed to load seasons
            </div>
          ) : (
            <Select
              value={value.seasonId ?? ""}
              onChange={(e) => patch({ seasonId: e.target.value || null })}
              disabled={disabled}
            >
              <option value="">
                {returnType === "seasonal" ? "— Select a season —" : "— None (optional) —"}
              </option>
              {(seasonsQuery.data?.seasons ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({formatDate(s.startDate)} – {formatDate(s.endDate)})
                </option>
              ))}
            </Select>
          )}
          {seasonMissing && (
            <p className="mt-1 text-xs text-accent-warning">
              A season is required for seasonal RMAs.
            </p>
          )}
        </CardBody>
      </Card>

      {/* Items with classification */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Items being returned</h3>
          <p className="mt-0.5 text-xs text-secondary">
            Use the Prices/Invoice buttons to auto-fill from the customer's most
            recent matching invoice. Set the classification per row.
          </p>
        </CardHeader>
        <CardBody>
          <RmaItemsTable
            rmaId={rmaId}
            qbCustomerId={qbCustomerId}
            items={value.items}
            disabled={disabled}
            onChange={(items) => {
              // Seed default classification for any newly added rows
              const newClassifications = { ...value.itemClassifications };
              for (const item of items) {
                if (!(item.localKey in newClassifications)) {
                  newClassifications[item.localKey] = defaultClassification(returnType);
                }
              }
              patch({ items, itemClassifications: newClassifications });
            }}
          />

          {/* Per-item classification overrides */}
          {!disabled && value.items.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                Item classifications
              </div>
              {value.items.map((item) => {
                const classification =
                  value.itemClassifications[item.localKey] ??
                  defaultClassification(returnType);
                return (
                  <div key={item.localKey} className="flex items-center gap-3">
                    <span className="text-xs text-secondary w-40 truncate">
                      {item.name || item.sku || "New item"}
                    </span>
                    <select
                      value={classification}
                      onChange={(e) => setClassification(item.localKey, e.target.value)}
                      className="h-7 rounded-md border border-default bg-base px-2 text-xs"
                    >
                      {classificationOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    {classification === "seasonal_prior" && (
                      <Badge tone="high">Prior — counts toward threshold</Badge>
                    )}
                    {classification === "non_seasonal" && returnType === "seasonal" && (
                      <Badge tone="neutral">Tag-along — excluded</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Eligibility card — threshold-gated for seasonal, informational-only for non-seasonal */}
      {returnType === "seasonal" && (
        <EligibilityCard
          rmaId={rmaId}
          seasonId={value.seasonId}
          items={itemsWithClassification}
          onOverrideChange={handleOverrideChange}
        />
      )}
      {returnType === "non_seasonal" && (
        <div className="rounded-md border border-default overflow-hidden">
          <div className="flex items-center gap-2 border-b border-default bg-subtle px-3 py-2">
            <Info className="size-3.5 text-muted" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              Eligibility (informational — no threshold gate)
            </span>
          </div>
          <div className="p-3 text-xs text-secondary">
            Non-seasonal returns are not subject to the 50% threshold gate.
            Eligibility runs for record-keeping only — approval is never blocked.
            {value.seasonId
              ? " The breakdown below shows cumulative totals for reference."
              : " Associate a season to see cumulative return totals."}
          </div>
          {value.seasonId && rmaId && (
            <div className="border-t border-default">
              <EligibilityCard
                rmaId={rmaId}
                seasonId={value.seasonId}
                items={itemsWithClassification}
                onOverrideChange={handleOverrideChange}
                informationalOnly
              />
            </div>
          )}
        </div>
      )}

      {/* Photos (Drive URL) */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Photos</h3>
        </CardHeader>
        <CardBody>
          <label className="block">
            <span className="mb-1 block text-xs text-secondary">
              Google Drive folder URL (paste link from Drive)
            </span>
            <input
              type="url"
              value={value.photosUrl}
              disabled={disabled}
              onChange={(e) => patch({ photosUrl: e.target.value })}
              placeholder="https://drive.google.com/drive/folders/..."
              className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm disabled:opacity-60"
            />
          </label>
        </CardBody>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Notes</h3>
        </CardHeader>
        <CardBody>
          <textarea
            value={value.notes}
            disabled={disabled}
            onChange={(e) => patch({ notes: e.target.value })}
            placeholder="Internal notes about this return…"
            rows={4}
            className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm disabled:opacity-60"
          />
        </CardBody>
      </Card>

      {/* Save error */}
      {saveError && (
        <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {saveError}
        </div>
      )}

      {/* Action footer */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-default bg-subtle px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-secondary">
          {rmaId ? (
            <>
              <CheckCircle2 className="size-4 text-accent-success" />
              <span>
                Draft saved{" "}
                <span className="font-mono text-muted">{rmaId.slice(0, 8)}…</span>
              </span>
            </>
          ) : (
            <span className="text-muted">Not yet saved</span>
          )}
          {!hasItems && (
            <Badge tone="neutral">Add at least one item to approve or deny</Badge>
          )}
          {seasonMissing && (
            <Badge tone="high">Select a season first</Badge>
          )}
          {overrideState.enabled && !overrideState.reason.trim() && (
            <Badge tone="high">Override reason required</Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={!canAction}
            onClick={onDeny}
          >
            Deny
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={
              !canAction ||
              seasonMissing ||
              (overrideState.enabled && !overrideState.reason.trim())
            }
            onClick={() => onApprove(overrideState)}
          >
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Helpers -----------------------------------------------------------------

function defaultClassification(returnType: "seasonal" | "non_seasonal"): string {
  return returnType === "seasonal" ? "seasonal_current" : "non_seasonal";
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// Suppress unused import — Select used in JSX above
void Select;
