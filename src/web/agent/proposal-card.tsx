// In-chat proposal cards (spec §4): a write the agent proposed, awaiting
// the operator. Approve/edit/dismiss go through the SAME autopilot
// endpoints as the /autopilot queue (one lifecycle); status is read live
// so a reloaded conversation shows the truth, not stale buttons.
// Dangerous actions (QBO void) demand typed confirmation.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  X,
} from "lucide-react";
import { cn } from "../lib/cn.js";

type ProposalStatus =
  | "drafted"
  | "approved"
  | "executed"
  | "execution_failed"
  | "dismissed"
  | "expired"
  | string;

type ProposalDetail = {
  id: string;
  status: ProposalStatus;
  draftedAction: { tool: string; args: Record<string, unknown> } | null;
  executionError: string | null;
};

// String args the operator may edit before approving (everything else is
// shown read-only — ids and enums shouldn't be hand-tweaked in chat).
const EDITABLE_KEYS = new Set([
  "subject",
  "body",
  "title",
  "append",
  "summary",
  "note",
  "terms",
  "coverNote",
]);

export function proposalKey(id: string) {
  return ["agent", "proposal", id] as const;
}

export function ChatProposalCard({
  proposalId,
  tool,
  summary,
  dangerous,
}: {
  proposalId: string;
  tool: string;
  summary: string;
  dangerous: boolean;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirmText, setConfirmText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: proposalKey(proposalId),
    queryFn: async (): Promise<ProposalDetail> => {
      const res = await fetch(`/api/autopilot/proposals/${proposalId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { proposal: ProposalDetail };
      return body.proposal;
    },
    staleTime: 15_000,
  });

  const status: ProposalStatus = data?.status ?? "drafted";
  const args = data?.draftedAction?.args ?? {};
  const pending = status === "drafted" || status === "pending";

  const decideMutation = useMutation({
    mutationFn: async (kind: "approve" | "dismiss") => {
      const editedEntries = Object.entries(edits).filter(
        ([k, v]) => String(args[k] ?? "") !== v,
      );
      const body =
        kind === "approve" && editedEntries.length > 0
          ? { editedArgs: { ...args, ...Object.fromEntries(editedEntries) } }
          : {};
      const res = await fetch(
        `/api/autopilot/proposals/${proposalId}/${kind}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const eb = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(eb?.error ?? `HTTP ${res.status}`);
      }
    },
    onMutate: () => setActionError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: proposalKey(proposalId) });
      void queryClient.invalidateQueries({ queryKey: ["autopilot"] });
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "action failed"),
  });

  const confirmRequired = dangerous && pending;
  const confirmOk = !confirmRequired || confirmText.trim().toUpperCase() === "VOID";

  const statusChip = useMemo(() => {
    switch (status) {
      case "approved":
        return { label: "approved — executing…", tone: "text-accent-info" };
      case "executed":
        return { label: "done", tone: "text-accent-success" };
      case "execution_failed":
        return { label: "failed", tone: "text-accent-danger" };
      case "dismissed":
        return { label: "dismissed", tone: "text-muted" };
      case "expired":
        return { label: "expired", tone: "text-muted" };
      default:
        return null;
    }
  }, [status]);

  return (
    <div
      className={cn(
        "my-1 rounded-lg border bg-base p-3",
        dangerous
          ? "border-accent-danger/40"
          : "border-accent-primary/35",
      )}
    >
      <div className="flex items-center gap-2">
        {dangerous && (
          <AlertTriangle
            className="h-4 w-4 shrink-0 text-accent-danger"
            aria-hidden
          />
        )}
        <span className="text-sm font-semibold">
          {tool.replace(/_/g, " ")}
        </span>
        <span className="truncate text-xs text-muted" title={summary}>
          {summary}
        </span>
        {statusChip && (
          <span className={cn("ml-auto text-xs font-medium", statusChip.tone)}>
            {statusChip.label}
          </span>
        )}
      </div>

      {status === "execution_failed" && data?.executionError && (
        <p className="mt-1 text-xs text-accent-danger">{data.executionError}</p>
      )}

      {pending && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 flex items-center gap-1 text-xs text-secondary hover:text-primary"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden />
            )}
            {expanded ? "Hide details" : "Review details"}
          </button>

          {expanded && (
            <div className="mt-2 space-y-2">
              {Object.entries(args).map(([key, value]) =>
                EDITABLE_KEYS.has(key) && typeof value === "string" ? (
                  <label key={key} className="block text-xs">
                    <span className="mb-0.5 block font-medium text-secondary">
                      {key} <span className="text-muted">(editable)</span>
                    </span>
                    <textarea
                      value={edits[key] ?? value}
                      onChange={(e) =>
                        setEdits((m) => ({ ...m, [key]: e.target.value }))
                      }
                      rows={key === "body" ? 6 : 1}
                      className="w-full resize-y rounded-md border border-strong bg-base px-2 py-1 text-xs outline-none focus:border-accent-primary"
                    />
                  </label>
                ) : (
                  <div key={key} className="text-xs">
                    <span className="font-medium text-secondary">{key}:</span>{" "}
                    <span className="text-primary">{String(value)}</span>
                  </div>
                ),
              )}
            </div>
          )}

          {confirmRequired && (
            <label className="mt-2 block text-xs">
              <span className="mb-0.5 block font-medium text-accent-danger">
                This voids the invoice in QuickBooks and cannot be undone.
                Type VOID to enable approval.
              </span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="VOID"
                className="w-32 rounded-md border border-accent-danger/50 bg-base px-2 py-1 text-xs outline-none focus:border-accent-danger"
                aria-label="Type VOID to confirm"
              />
            </label>
          )}

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={decideMutation.isPending || !confirmOk}
              onClick={() => decideMutation.mutate("approve")}
              className="inline-flex items-center gap-1 rounded-md bg-accent-primary px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {decideMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Check className="h-3 w-3" aria-hidden />
              )}
              Approve{Object.keys(edits).length > 0 ? " with edits" : ""}
            </button>
            <button
              type="button"
              disabled={decideMutation.isPending}
              onClick={() => decideMutation.mutate("dismiss")}
              className="inline-flex items-center gap-1 rounded-md border border-strong px-2.5 py-1 text-xs font-medium hover:bg-subtle disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden />
              Dismiss
            </button>
          </div>
          {actionError && (
            <p className="mt-1 text-xs text-accent-danger">{actionError}</p>
          )}
        </>
      )}
    </div>
  );
}
