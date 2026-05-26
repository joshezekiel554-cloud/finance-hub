// AI summary + action plan card for the customer detail page. Single
// LLM-synthesised view over the autopilot candidate finders scoped to one
// customer + customer state + voice context. 24h cache TTL with a manual
// Regenerate button.
//
// Action buttons fire via an `onAction` prop so the parent page can decide
// what each kind does (opens compose, opens statement dialog, navigates,
// etc.) — keeps this component free of routing + modal state.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";

export type CardActionKind =
  | "send_chase_email"
  | "send_statement"
  | "send_check_in_email"
  | "view_rma"
  | "view_cron_failure";

export type CardAction = {
  kind: CardActionKind;
  label: string;
  args: Record<string, unknown>;
};

type CardResponse = {
  summary: string;
  actions: CardAction[];
  generatedAt: string;
  isStale: boolean;
};

type Props = {
  customerId: string;
  onAction: (action: CardAction) => void;
};

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60 * 1000) return "just now";
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / (60 * 1000))}m ago`;
  if (ms < 24 * 60 * 60 * 1000)
    return `${Math.floor(ms / (60 * 60 * 1000))}h ago`;
  return `${Math.floor(ms / (24 * 60 * 60 * 1000))}d ago`;
}

export default function CustomerAiCard({ customerId, onAction }: Props) {
  const qc = useQueryClient();
  const queryKey = ["customer-ai-card", customerId] as const;

  const card = useQuery<CardResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}/ai-card`);
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as CardResponse;
    },
    // Once we have a row, treat it as fresh enough for 5 min on the client
    // — the server's 24h staleness still drives the visible flag.
    staleTime: 5 * 60 * 1000,
    // The first fetch may trigger a fresh LLM synth on the server; retrying
    // would multiply cost. Don't retry.
    retry: false,
  });

  const regen = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/customers/${customerId}/ai-card/regenerate`,
        { method: "POST" },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as CardResponse;
    },
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data);
    },
  });

  if (card.isPending) {
    return (
      <div className="rounded-lg border border-default bg-subtle p-4 text-sm text-secondary">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent-primary" />
          AI summary &amp; action plan
        </div>
        <div className="mt-2">Loading…</div>
      </div>
    );
  }
  if (card.isError) {
    return (
      <div className="rounded-lg border border-default bg-subtle p-4 text-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            <Sparkles className="size-4 text-accent-primary" />
            AI summary &amp; action plan
          </div>
          <button
            type="button"
            onClick={() => regen.mutate()}
            disabled={regen.isPending}
            className="flex items-center gap-1 rounded-md border border-default bg-base px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50"
          >
            <RefreshCw
              className={`size-3 ${regen.isPending ? "animate-spin" : ""}`}
            />
            Try again
          </button>
        </div>
        <div className="mt-2 text-accent-danger">
          {(card.error as Error)?.message ?? "Couldn't load AI summary."}
        </div>
      </div>
    );
  }
  const data = card.data;

  return (
    <div className="rounded-lg border border-default bg-subtle p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Sparkles className="size-4 text-accent-primary" />
          AI summary &amp; action plan
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>
            Generated {relativeAge(data.generatedAt)}
            {data.isStale ? " · stale" : ""}
          </span>
          <button
            type="button"
            onClick={() => regen.mutate()}
            disabled={regen.isPending}
            className="flex items-center gap-1 rounded-md border border-default bg-base px-2 py-1 hover:bg-elevated disabled:opacity-50"
          >
            <RefreshCw
              className={`size-3 ${regen.isPending ? "animate-spin" : ""}`}
            />
            {regen.isPending ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      </div>

      <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-secondary">
        {data.summary}
      </div>

      {data.actions.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Suggested actions
          </div>
          <div className="flex flex-wrap gap-2">
            {data.actions.map((a, i) => (
              <button
                key={`${a.kind}-${i}`}
                type="button"
                onClick={() => onAction(a)}
                className="rounded-md border border-default bg-base px-3 py-1.5 text-sm text-primary hover:bg-elevated hover:border-strong"
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
