import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardBody } from "../ui/card";
import { Button } from "../ui/button";

export type Proposal = {
  id: string;
  category: string;
  entityType: string;
  entityId: string;
  status: string;
  candidateSummary: Record<string, unknown>;
  draftedPreview: string | null;
  draftedAction: { tool: string; args: Record<string, unknown> } | null;
  reasoning: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
};

type Props = {
  proposal: Proposal;
  selected: boolean;
  onSelect: (yes: boolean) => void;
};

// Categories that don't need an AI draft — Approve & Execute fires directly.
const NO_DRAFT_CATEGORIES = new Set([
  "cadence_statement",
  "ops_cron_fail",
]);

function categoryLabel(c: string): string {
  return c.replace(/_/g, " ");
}

function summaryLine(summary: Record<string, unknown>): string {
  // Generic best-effort renderer; categories with richer summaries can read
  // specific fields. Currently shows whichever common keys are present.
  const parts: string[] = [];
  if (summary.customerName) parts.push(String(summary.customerName));
  if (summary.rmaNumber) parts.push(`RMA ${summary.rmaNumber}`);
  if (summary.jobKind) parts.push(`job ${summary.jobKind}`);
  if (summary.overdueBalance != null)
    parts.push(`overdue $${Number(summary.overdueBalance).toLocaleString()}`);
  if (summary.totalOpenBalance != null)
    parts.push(`open $${Number(summary.totalOpenBalance).toLocaleString()}`);
  if (summary.daysOverdue != null) parts.push(`${summary.daysOverdue}d overdue`);
  if (summary.daysInState != null) parts.push(`${summary.daysInState}d in state`);
  if (summary.daysSinceLastStatement != null)
    parts.push(`${summary.daysSinceLastStatement}d since statement`);
  if (summary.daysSinceLastPayment != null)
    parts.push(`${summary.daysSinceLastPayment}d since payment`);
  if (summary.tier) parts.push(`tier ${summary.tier}`);
  return parts.join(" · ") || JSON.stringify(summary).slice(0, 200);
}

const SNOOZE_OPTIONS = [
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 24 * 3 },
  { label: "1 week", hours: 24 * 7 },
  { label: "1 month", hours: 24 * 30 },
];

export function ProposalCard({ proposal, selected, onSelect }: Props) {
  const queryClient = useQueryClient();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const isDraftReady = proposal.status === "drafted";
  const isDeterministic = NO_DRAFT_CATEGORIES.has(proposal.category);
  const canSelectForDraft = proposal.status === "pending" && !isDeterministic;

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey: ["autopilot"] });
  };

  const approveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/approve`,
        { method: "POST" },
      );
      if (res.status === 409) {
        const json = await res.json().catch(() => ({}));
        if (
          (json as { stale?: boolean }).stale &&
          window.confirm(
            "Conditions changed since this proposal was drafted. Send anyway?",
          )
        ) {
          const force = await fetch(
            `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/approve?force=true`,
            { method: "POST" },
          );
          if (!force.ok) throw new Error(`HTTP ${force.status}`);
          return;
        }
        throw new Error("stale");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: refetch,
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: refetch,
  });

  const snoozeMutation = useMutation({
    mutationFn: async (hours: number) => {
      const res = await fetch(
        `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/snooze`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hours }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      setSnoozeOpen(false);
      refetch();
    },
  });

  return (
    <Card className="border-default">
      <CardBody className="space-y-2">
        <div className="flex items-start gap-2">
          {canSelectForDraft && (
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onSelect(e.target.checked)}
              className="mt-1"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">
              {categoryLabel(proposal.category)} ·{" "}
              <span className="text-accent-info">{proposal.status}</span>
            </div>
            <div className="text-sm text-primary">
              {summaryLine(proposal.candidateSummary)}
            </div>
          </div>
        </div>

        {isDraftReady && proposal.draftedPreview && (
          <pre className="text-xs whitespace-pre-wrap bg-subtle p-2 rounded max-h-40 overflow-y-auto">
            {proposal.draftedPreview}
          </pre>
        )}

        <div className="flex flex-wrap gap-1">
          {(isDraftReady || isDeterministic) && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending}
            >
              {isDeterministic ? "Approve & Execute" : "Approve & Send"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dismissMutation.mutate()}
            disabled={dismissMutation.isPending}
          >
            Dismiss
          </Button>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSnoozeOpen((v) => !v)}
            >
              Snooze…
            </Button>
            {snoozeOpen && (
              <div className="absolute z-10 top-full mt-1 right-0 rounded border border-default bg-base shadow p-1">
                {SNOOZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.hours}
                    type="button"
                    className="block w-full text-left px-3 py-1 text-xs hover:bg-subtle whitespace-nowrap"
                    onClick={() => snoozeMutation.mutate(opt.hours)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
