import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardBody } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
const NO_DRAFT_CATEGORIES = new Set(["cadence_statement", "ops_cron_fail"]);

// Tools that send an email — args have subject + body that operators can edit
// inline and that benefit from an HTML preview.
const EMAIL_TOOLS = new Set([
  "send_chase_email",
  "send_check_in_email",
  "nudge_warehouse_email",
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
  if (summary.daysOverdue != null)
    parts.push(`${summary.daysOverdue}d overdue`);
  if (summary.daysInState != null)
    parts.push(`${summary.daysInState}d in state`);
  if (summary.daysSinceLastStatement != null)
    parts.push(`${summary.daysSinceLastStatement}d since statement`);
  if (summary.daysSinceLastPayment != null)
    parts.push(`${summary.daysSinceLastPayment}d since payment`);
  if (summary.tier) parts.push(`tier ${summary.tier}`);
  return parts.join(" · ");
}

export function ProposalCard({ proposal, selected, onSelect }: Props) {
  const queryClient = useQueryClient();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [tab, setTab] = useState<"preview" | "edit">("preview");

  // Pull subject + body out of drafted_action.args for email tools so the
  // operator sees the real email shape (not a JSON dump).
  const draftedArgs = (proposal.draftedAction?.args ?? {}) as Record<
    string,
    unknown
  >;
  const toolName = proposal.draftedAction?.tool ?? "";
  const isEmailTool = EMAIL_TOOLS.has(toolName);
  const draftedSubject =
    typeof draftedArgs.subject === "string" ? draftedArgs.subject : "";
  const draftedBody =
    typeof draftedArgs.body === "string" ? draftedArgs.body : "";

  // Editable local state — seeded from the AI draft, send the edited
  // values on approve.
  const [subject, setSubject] = useState(draftedSubject);
  const [body, setBody] = useState(draftedBody);

  // Re-seed when the underlying proposal changes (e.g. after a refetch).
  useEffect(() => {
    setSubject(draftedSubject);
    setBody(draftedBody);
  }, [draftedSubject, draftedBody]);

  // Debounced preview so typing in the body doesn't repaint the iframe
  // on every keystroke.
  const [debouncedBody, setDebouncedBody] = useState(body);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedBody(body), 200);
    return () => clearTimeout(t);
  }, [body]);

  const isDraftReady = proposal.status === "drafted";
  const isDeterministic = NO_DRAFT_CATEGORIES.has(proposal.category);
  const canSelectForDraft = proposal.status === "pending" && !isDeterministic;

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: ["autopilot"] });

  const approveMutation = useMutation({
    mutationFn: async (force?: boolean) => {
      // If this is an editable email draft, send the edited args.
      const body: Record<string, unknown> = {};
      if (isEmailTool && isDraftReady) {
        body.editedArgs = { ...draftedArgs, subject, body: bodyText };
      }
      const url = force
        ? `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/approve?force=true`
        : `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/approve`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        const json = await res.json().catch(() => ({}));
        if (
          (json as { stale?: boolean }).stale &&
          window.confirm(
            "Conditions changed since this proposal was drafted. Send anyway?",
          )
        ) {
          // retry with force
          return await fetch(
            `/api/autopilot/proposals/${encodeURIComponent(proposal.id)}/approve?force=true`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          ).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
          });
        }
        throw new Error("stale");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: refetch,
  });
  // Closure capture: keep a stable reference to the latest body text used
  // by approveMutation. Without this, `body` shadows the outer scope.
  const bodyText = body;

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

  // Wrap body in a minimal HTML doc with white background so the preview
  // mimics how Gmail / typical mail clients render it. Mirrors the
  // signature-editor preview pattern.
  const previewSrcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#ffffff;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${debouncedBody}</body></html>`,
    [debouncedBody],
  );

  return (
    <Card className="border-default">
      <CardBody className="space-y-3">
        {/* Header line: checkbox + category label + summary */}
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

        {/* Drafted email — editable subject + body editor + live preview */}
        {isDraftReady && isEmailTool && (
          <div className="space-y-2 border-t border-default pt-2">
            <div className="grid gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                Subject
              </label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={998}
              />
            </div>

            <div className="flex gap-1 text-xs">
              <button
                type="button"
                className={`px-2 py-1 rounded ${tab === "preview" ? "bg-subtle text-primary" : "text-muted hover:text-primary"}`}
                onClick={() => setTab("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                className={`px-2 py-1 rounded ${tab === "edit" ? "bg-subtle text-primary" : "text-muted hover:text-primary"}`}
                onClick={() => setTab("edit")}
              >
                Edit HTML
              </button>
            </div>

            {tab === "preview" ? (
              <iframe
                title="email preview"
                sandbox=""
                className="h-72 w-full rounded border border-default bg-white"
                srcDoc={previewSrcDoc}
              />
            ) : (
              <textarea
                className="font-mono text-xs h-72 w-full rounded border border-default bg-base p-2 text-primary"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
              />
            )}

            <div className="text-[11px] text-muted">
              Signature is auto-appended on send (your default personal
              signature, or the alias signature if you have none).
            </div>
          </div>
        )}

        {/* Drafted non-email (admin notification etc.) — readable preview */}
        {isDraftReady && !isEmailTool && proposal.draftedAction && (
          <div className="space-y-1 border-t border-default pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">
              Action: {toolName}
            </div>
            <pre className="text-xs whitespace-pre-wrap bg-subtle p-2 rounded max-h-40 overflow-y-auto">
              {Object.entries(draftedArgs).map(
                ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}\n`,
              )}
            </pre>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-1">
          {(isDraftReady || isDeterministic) && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => approveMutation.mutate(undefined)}
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
