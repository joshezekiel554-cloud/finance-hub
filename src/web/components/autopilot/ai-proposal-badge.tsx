import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

// Compact "AI" pill that, when clicked, opens a popover with the original
// proposal context: category, reasoning (if AI explained the draft),
// drafted preview (the action as approved), and who/when. Used anywhere
// a row carries an ai_proposal_id FK — email_log, chase_log, activities,
// statement_sends — so the operator can trace AI-originated work end to
// end without a second click out to the /autopilot page.

type ProposalDetail = {
  id: string;
  category: string;
  status: string;
  candidateSummary: Record<string, unknown>;
  draftedAction: { tool: string; args: Record<string, unknown> } | null;
  draftedPreview: string | null;
  reasoning: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  executedAt: string | null;
};

type Props = {
  proposalId: string | null | undefined;
  className?: string;
};

export function AiProposalBadge({ proposalId, className }: Props) {
  const [open, setOpen] = useState(false);

  const { data, isPending, isError } = useQuery<{ proposal: ProposalDetail }>({
    queryKey: ["autopilot", "proposal", proposalId],
    queryFn: async () => {
      const res = await fetch(
        `/api/autopilot/proposals/${encodeURIComponent(proposalId ?? "")}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open && !!proposalId,
    staleTime: 5 * 60_000,
  });

  if (!proposalId) return null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={
          className ??
          "inline-flex items-center rounded bg-accent-info/15 px-1 py-0.5 text-[10px] font-semibold text-accent-info hover:bg-accent-info/25"
        }
        title="Originated from an AI autopilot proposal — click for detail"
      >
        AI
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>AI proposal</DialogTitle>
            <DialogDescription>
              The autopilot proposal that triggered this action.
            </DialogDescription>
          </DialogHeader>
          {isPending ? (
            <div className="text-xs text-muted">Loading…</div>
          ) : isError ? (
            <div className="text-xs text-accent-danger">
              Couldn't load proposal — it may have been deleted or never
              existed.
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-muted">Category:</span>{" "}
                <span className="font-mono">
                  {data?.proposal.category.replace(/_/g, " ")}
                </span>
                <span className="text-muted ml-2">Status:</span>{" "}
                <span>{data?.proposal.status}</span>
              </div>
              {data?.proposal.executedAt && (
                <div>
                  <span className="text-muted">Executed:</span>{" "}
                  {new Date(data.proposal.executedAt).toLocaleString()}
                </div>
              )}
              {data?.proposal.decidedAt && (
                <div>
                  <span className="text-muted">Approved:</span>{" "}
                  {new Date(data.proposal.decidedAt).toLocaleString()}
                </div>
              )}
              {data?.proposal.reasoning && (
                <div>
                  <div className="text-muted text-xs mb-0.5">
                    AI reasoning:
                  </div>
                  <div className="text-xs">{data.proposal.reasoning}</div>
                </div>
              )}
              {data?.proposal.draftedPreview && (
                <div>
                  <div className="text-muted text-xs mb-0.5">
                    Drafted action as approved:
                  </div>
                  <pre className="text-xs whitespace-pre-wrap bg-subtle p-2 rounded max-h-64 overflow-y-auto">
                    {data.proposal.draftedPreview}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
