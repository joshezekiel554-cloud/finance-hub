// Shared Tasks page — embeds the inbox GLOBAL tasks board, scoped to the
// logged-in finance user via a short-lived viewer token minted by
// `GET /api/tasks/embed-url`. This is DISTINCT from the finance-native Kanban
// at /tasks (pages/tasks.tsx). Mounted at /shared-tasks.
//
// The board itself is inbox's UI (full SSE/live updates for free). Finance just
// renders it in a full-height iframe. We re-mint the token on focus so a tab
// left open past the 5-min TTL refreshes its scope on return.

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { NewTaskDialog } from "../components/tasks/new-task-dialog";

type EmbedUrlResponse = { url: string };

async function fetchEmbedUrl(): Promise<EmbedUrlResponse> {
  const res = await fetch("/api/tasks/embed-url");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export default function SharedTasksPage() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery<EmbedUrlResponse>({
    queryKey: ["tasks", "embed-url"],
    queryFn: fetchEmbedUrl,
    // The minted token lives ~5 min; refresh comfortably inside that window.
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    retry: 1,
  });

  // Re-mint on window focus so a returning tab is never holding a dead token.
  // The refetch yields a fresh URL (new token) → keying the iframe on data.url
  // reloads it only when the URL actually changes (no focus/blur thrash).
  const onFocus = useCallback(() => {
    void refetch();
  }, [refetch]);
  useEffect(() => {
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [onFocus]);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3 md:h-[calc(100vh-6rem)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="mt-1 text-sm text-secondary">
            The shared tasks board — your tasks across finance and inbox.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setNewTaskOpen(true)}>
            <Plus className="size-3.5" /> New task
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refetch()}
            disabled={isPending}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
      </div>

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        // Re-mint the embed URL so a just-created task shows on the board.
        onCreated={() => void refetch()}
      />

      {isPending ? (
        <div className="flex-1 animate-pulse rounded-lg bg-subtle" />
      ) : isError ? (
        <Card className="border-accent-danger/40 bg-accent-danger/5">
          <CardBody>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-accent-danger" />
              <div className="flex-1">
                <div className="text-sm font-medium text-primary">
                  Tasks board temporarily unavailable
                </div>
                <div className="mt-0.5 text-xs text-secondary">
                  {(error as Error)?.message === "tasks_not_configured"
                    ? "Shared tasks isn't configured yet on this server."
                    : "Couldn't reach the tasks service. Try again in a moment."}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <iframe
          // key on the URL: reloads with the freshly-minted token when it changes.
          key={data!.url}
          src={data!.url}
          title="Shared tasks board"
          className="min-h-0 flex-1 rounded-lg border border-default bg-base"
        />
      )}
    </div>
  );
}
