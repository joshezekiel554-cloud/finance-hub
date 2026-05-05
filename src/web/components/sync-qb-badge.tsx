// SyncQbBadge — "Synced N min ago" + manual Sync button.
//
// Shown on /customers and /chase so the operator can see how stale the
// QB-derived data is and force a refresh before sending statements /
// chases. The auto-sync still runs every 30 min via the scheduled
// qb-sync job; this is the user-visible escape hatch.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";

type LastRunResponse = {
  run: {
    id: string;
    startedAt: string;
    completedAt: string | null;
    status: "running" | "ok" | "partial" | "failed";
    stats: Record<string, unknown> | null;
    errorMessage: string | null;
  } | null;
};

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 30_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function SyncQbBadge() {
  const queryClient = useQueryClient();

  // Fetch the last run; refresh every 10s when a run is in progress so
  // the UI reflects completion without manual reload. Otherwise refresh
  // every 60s — cheap, keeps the relative time fresh enough.
  const { data, refetch } = useQuery<LastRunResponse>({
    queryKey: ["sync", "qb", "last"],
    queryFn: async () => {
      const res = await fetch("/api/sync/qb/last");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: (q) => {
      const status = (q.state.data as LastRunResponse | undefined)?.run?.status;
      return status === "running" ? 5_000 : 60_000;
    },
  });

  // Local tick so the relative-time label updates between server refetches.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = data?.run ?? null;
  const isRunning = run?.status === "running";

  const triggerMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sync/qb", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      // Refetch quickly so the UI flips to "running" and starts the 5s
      // polling loop.
      void queryClient.invalidateQueries({ queryKey: ["sync", "qb", "last"] });
      void refetch();
    },
  });

  const label = (() => {
    if (isRunning) return "Syncing QB…";
    if (!run) return "QB never synced";
    if (run.status === "failed") return "Last QB sync failed";
    if (run.status === "partial") {
      return `Synced (partial) ${formatRelative(run.completedAt ?? run.startedAt)}`;
    }
    return `Synced ${formatRelative(run.completedAt ?? run.startedAt)}`;
  })();

  return (
    <div className="inline-flex items-center gap-2">
      <span
        className={
          run?.status === "failed"
            ? "text-xs text-accent-danger"
            : isRunning
              ? "text-xs text-accent-info"
              : "text-xs text-secondary"
        }
        title={
          run?.errorMessage
            ? `Last error: ${run.errorMessage}`
            : run?.startedAt
              ? `Started ${new Date(run.startedAt).toLocaleString()}`
              : undefined
        }
      >
        {label}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={isRunning || triggerMutation.isPending}
        onClick={() => triggerMutation.mutate()}
      >
        {isRunning || triggerMutation.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        {isRunning
          ? "Syncing…"
          : triggerMutation.isPending
            ? "Queued…"
            : "Sync QB"}
      </Button>
      {triggerMutation.isError && (
        <span className="text-xs text-accent-danger">
          {(triggerMutation.error as Error).message}
        </span>
      )}
    </div>
  );
}
