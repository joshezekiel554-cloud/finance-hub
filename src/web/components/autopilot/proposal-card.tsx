import { useMemo, useState } from "react";
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
  // Opens the full compose modal pre-filled with this proposal's draft.
  onEditAndSend: (proposal: Proposal) => void;
};

const NO_DRAFT_CATEGORIES = new Set(["cadence_statement", "ops_cron_fail"]);

// Email tools whose draft can be opened in the full composer for editing.
const EDITABLE_EMAIL_TOOLS = new Set([
  "send_chase_email",
  "send_check_in_email",
]);

const SNOOZE_OPTIONS = [
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 24 * 3 },
  { label: "1 week", hours: 24 * 7 },
  { label: "1 month", hours: 24 * 30 },
];

function categoryLabel(c: string): string {
  return c.replace(/_/g, " ");
}

function summaryLine(summary: Record<string, unknown>): string {
  const parts: string[] = [];
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
  return parts.join(" · ");
}

export function ProposalCard({
  proposal,
  selected,
  onSelect,
  onEditAndSend,
}: Props) {
  const queryClient = useQueryClient();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const draftedArgs = (proposal.draftedAction?.args ?? {}) as Record<
    string,
    unknown
  >;
  const toolName = proposal.draftedAction?.tool ?? "";
  const isEmailTool =
    typeof draftedArgs.subject === "string" &&
    typeof draftedArgs.body === "string";
  const subject = typeof draftedArgs.subject === "string" ? draftedArgs.subject : "";
  const bodyHtml = typeof draftedArgs.body === "string" ? draftedArgs.body : "";

  const isDraftReady = proposal.status === "drafted";
  const isDeterministic = NO_DRAFT_CATEGORIES.has(proposal.category);
  const canSelectForDraft = proposal.status === "pending" && !isDeterministic;
  const canEditInComposer = isDraftReady && EDITABLE_EMAIL_TOOLS.has(toolName);

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: ["autopilot"] });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/approve`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
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
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
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

  const previewSrcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#ffffff;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${bodyHtml}</body></html>`,
    [bodyHtml],
  );

  return (
    <Card className="border-default">
      <CardBody className="space-y-3">
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
              {summaryLine(proposal.candidateSummary) || ""}
            </div>
          </div>
        </div>

        {/* Drafted email — read-only preview (edit happens in the composer) */}
        {isDraftReady && isEmailTool && (
          <div className="space-y-1 border-t border-default pt-2">
            <div className="text-xs">
              <span className="text-muted">Subject:</span>{" "}
              <span className="text-primary">{subject}</span>
            </div>
            <iframe
              title="email preview"
              sandbox=""
              className="h-56 w-full rounded border border-default bg-white"
              srcDoc={previewSrcDoc}
            />
            <div className="text-[11px] text-muted">
              Signature is auto-appended on send.
            </div>
          </div>
        )}

        {/* Drafted non-email action — readable key/value preview */}
        {isDraftReady && !isEmailTool && proposal.draftedAction && (
          <div className="space-y-1 border-t border-default pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">
              Action: {toolName}
            </div>
            <pre className="text-xs whitespace-pre-wrap bg-subtle p-2 rounded max-h-40 overflow-y-auto">
              {Object.entries(draftedArgs)
                .map(
                  ([k, v]) =>
                    `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
                )
                .join("\n")}
            </pre>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1">
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
          {canEditInComposer && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onEditAndSend(proposal)}
            >
              Edit &amp; Send…
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
