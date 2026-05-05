// EligibilityCard — live cumulative eligibility breakdown.
// Debounced: fires POST /api/rmas/:id/run-eligibility whenever rmaId,
// seasonId, or items change. Renders threshold math and, when over
// threshold, surfaces an override toggle + reason textarea.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, AlertCircle } from "lucide-react";

export type EligibilityItem = {
  classification: string;
  lineTotal: string;
};

export type EligibilityBreakdown = {
  customerSeasonalPurchases: string;
  alreadyReturnedThisSeason: string;
  proposedCurrentSeason: string;
  proposedPriorSeason: string;
  proposedNonSeasonal: string;
  proposedSubtotalCountingTowardThreshold: string;
  totalReturnsThisSeason: string;
  cumulativeReturnPct: string;
  thresholdPct: string;
  passesThreshold: boolean;
};

export type EligibilityCardProps = {
  rmaId: string | null;
  /** Required when rmaId is null — used to fall back to customer-scoped lookup. */
  customerId?: string | null;
  /** Required when rmaId is null. */
  qbCustomerId?: string | null;
  seasonId: string | null;
  items: EligibilityItem[];
  /** Called whenever override toggle/reason changes. Parent uses this. */
  onOverrideChange: (override: { enabled: boolean; reason: string }) => void;
  /**
   * When true: renders the breakdown table for record-keeping but hides the
   * threshold verdict banner and the override toggle. Used by non-seasonal
   * RMAs where eligibility is informational only — approval is never blocked.
   */
  informationalOnly?: boolean;
};

export default function EligibilityCard({
  rmaId,
  customerId = null,
  qbCustomerId = null,
  seasonId,
  items,
  onOverrideChange,
  informationalOnly = false,
}: EligibilityCardProps) {
  const [breakdown, setBreakdown] = useState<EligibilityBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Override state (local; lifted via callback)
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runEligibility = useCallback(async () => {
    if (!seasonId) return;
    if (!rmaId && (!customerId || !qbCustomerId)) return;
    const countingItems = items.filter((i) => i.classification !== "damage");
    if (countingItems.length === 0) {
      setBreakdown(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url = rmaId
        ? `/api/rmas/${rmaId}/run-eligibility`
        : `/api/rmas/qbo-run-eligibility`;
      const body = rmaId
        ? { seasonId, items: countingItems }
        : { customerId, qbCustomerId, seasonId, items: countingItems };
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Route returns { breakdown: ... }
      const wrapper = (await res.json()) as { breakdown: EligibilityBreakdown };
      const data = wrapper.breakdown;
      setBreakdown(data);
      // Reset override toggle when threshold status changes
      if (data.passesThreshold) {
        setOverrideEnabled(false);
        setOverrideReason("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [rmaId, seasonId, items]);

  // Debounce: 500ms after items/season change
  useEffect(() => {
    if (!seasonId) {
      setBreakdown(null);
      return;
    }
    if (!rmaId && (!customerId || !qbCustomerId)) {
      setBreakdown(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runEligibility();
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [rmaId, customerId, qbCustomerId, seasonId, items, runEligibility]);

  // Propagate override changes to parent
  useEffect(() => {
    onOverrideChange({ enabled: overrideEnabled, reason: overrideReason });
  }, [overrideEnabled, overrideReason, onOverrideChange]);

  if (!seasonId) return null;
  if (!rmaId && (!customerId || !qbCustomerId)) return null;

  const innerContent = (
    <div className="p-3 space-y-2">
      {error && (
        <div className="flex items-center gap-2 text-sm text-accent-danger">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {!loading && !error && !breakdown && (
        <div className="py-2 text-xs text-muted text-center">
          Add items to see eligibility breakdown.
        </div>
      )}

      {breakdown && (
        <>
          <EligibilityTable breakdown={breakdown} />

          {/* Threshold verdict — hidden for informational-only (non-seasonal) */}
          {!informationalOnly && breakdown.passesThreshold && (
            <div className="rounded-md bg-success/10 border border-success/30 px-3 py-2 text-xs text-success font-medium">
              Within threshold — approved to proceed
            </div>
          )}
          {!informationalOnly && !breakdown.passesThreshold && (
            <div className="rounded-md bg-accent-danger/10 border border-accent-danger/30 px-3 py-2 text-xs text-accent-danger font-medium">
              Over threshold ({breakdown.cumulativeReturnPct}% &gt; {breakdown.thresholdPct}%)
              — override required to approve
            </div>
          )}

          {/* Override panel — only shown when over threshold and not informational */}
          {!informationalOnly && !breakdown.passesThreshold && (
            <div className="rounded-md border border-accent-warning/30 bg-accent-warning/5 p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideEnabled}
                  onChange={(e) => {
                    setOverrideEnabled(e.target.checked);
                    if (!e.target.checked) setOverrideReason("");
                  }}
                  className="rounded"
                />
                <span className="text-sm font-medium">Override threshold with reason</span>
              </label>
              {overrideEnabled && (
                <textarea
                  rows={2}
                  placeholder="Reason for overriding the threshold…"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
                />
              )}
            </div>
          )}

          {/* Informational badge for non-seasonal */}
          {informationalOnly && (
            <div className="rounded-md bg-accent-info/10 border border-accent-info/30 px-3 py-2 text-xs text-accent-info font-medium">
              Informational only — this return is not subject to the threshold gate
            </div>
          )}

          {/* PDF preview link is rendered by the parent — see StepEligibility
              in seasonal-wizard.tsx, which has access to the full item rows
              needed for the customer-scoped PDF endpoint. */}
        </>
      )}
    </div>
  );

  // In informationalOnly mode the parent component provides the outer card
  // shell and header, so we just render the inner content with a loading
  // indicator pinned to the top-right of the content area.
  if (informationalOnly) {
    return (
      <div className="relative">
        {loading && (
          <Loader2 className="absolute right-3 top-3 size-3.5 animate-spin text-muted" />
        )}
        {innerContent}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-default overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-default bg-subtle px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          Eligibility check
        </span>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted" />}
      </div>
      {innerContent}
    </div>
  );
}

// ---- Breakdown table --------------------------------------------------------

function EligibilityTable({ breakdown }: { breakdown: EligibilityBreakdown }) {
  const purchases = parseFloat(breakdown.customerSeasonalPurchases);
  const alreadyReturned = parseFloat(breakdown.alreadyReturnedThisSeason);
  const current = parseFloat(breakdown.proposedCurrentSeason);
  const prior = parseFloat(breakdown.proposedPriorSeason);
  const nonSeasonal = parseFloat(breakdown.proposedNonSeasonal);
  const subtotal = parseFloat(breakdown.proposedSubtotalCountingTowardThreshold);
  const total = parseFloat(breakdown.totalReturnsThisSeason);
  const pct = parseFloat(breakdown.cumulativeReturnPct);
  const threshold = parseFloat(breakdown.thresholdPct);
  const over = pct > threshold;

  return (
    <table className="w-full text-xs">
      <tbody className="divide-y divide-default">
        <EligRow label="This season's seasonal purchases" value={purchases} />
        <EligRow label="Already returned this season" value={alreadyReturned} />
        <tr>
          <td colSpan={2} className="px-2 pt-2 pb-0 font-medium text-secondary">
            Returning on this RMA:
          </td>
        </tr>
        <EligRow label="Current season items" value={current} indent />
        {prior > 0 && (
          <EligRow
            label="Prior season items"
            value={prior}
            indent
            flag={<AlertTriangle className="size-3 text-accent-warning inline ml-1" />}
          />
        )}
        <EligRow
          label="Subtotal (counting toward threshold)"
          value={subtotal}
          indent
          bold
        />
        {nonSeasonal > 0 && (
          <EligRow
            label="Non-seasonal (excluded)"
            value={nonSeasonal}
            indent
            muted
          />
        )}
        <EligRow label="Total returns this season" value={total} bold />
        <tr>
          <td className="px-2 py-1.5 font-medium">Cumulative return %</td>
          <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${over ? "text-accent-danger" : "text-success"}`}>
            {pct.toFixed(1)}%
            <span className="ml-1 font-normal text-muted">(threshold {threshold}%)</span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function EligRow({
  label,
  value,
  indent,
  bold,
  muted,
  flag,
}: {
  label: string;
  value: number;
  indent?: boolean;
  bold?: boolean;
  muted?: boolean;
  flag?: React.ReactNode;
}) {
  return (
    <tr>
      <td className={`py-1 ${indent ? "pl-5 pr-2" : "px-2"} ${muted ? "text-muted" : ""} ${bold ? "font-medium" : ""}`}>
        {label}{flag}
      </td>
      <td className={`py-1 px-2 text-right tabular-nums ${muted ? "text-muted" : ""} ${bold ? "font-medium" : ""}`}>
        ${value.toFixed(2)}
      </td>
    </tr>
  );
}
