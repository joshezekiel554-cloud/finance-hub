// Shared Tasks page — embeds the inbox GLOBAL tasks board, scoped to the
// logged-in finance user via a short-lived token minted by
// `GET /api/tasks/embed-url`. This is DISTINCT from the finance-native Kanban
// at /tasks (pages/tasks.tsx). Mounted at /shared-tasks.
//
// The board itself is inbox's UI (full SSE/live updates for free). Finance just
// renders it in a full-height iframe.
//
// TWO MODES (shared-tasks M6):
//   "view" — read-only embed, 5-min token, RE-MINTED every ~4 min + on focus so
//            a long-open tab never holds a dead token (the iframe reloads on each
//            re-mint; harmless for a read-only board).
//   "edit" — INTERACTIVE embed (open a task + edit core fields + drag-restatus),
//            30-min `scope:"edit"` token, minted ONCE on mount with NO periodic
//            reload — a re-mint mid-edit would blow away the open editor/drag.
//            Past 30 min idle the embed shows its own soft "session expired —
//            reopen" (inbox-side); navigating back here remounts a fresh token.
//            (Phase-2: a postMessage token-refresh handshake removes the ceiling.)
//
// EMBED_MODE is held at "view" until inbox's interactive embed ships; flip this
// ONE constant to "edit" (coordinated with inbox) to go live with M6.
const EMBED_MODE: "view" | "edit" = "view";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { NewTaskDialog } from "../components/tasks/new-task-dialog";

type EmbedUrlResponse = { url: string; mode?: "view" | "edit" };

async function fetchEmbedUrl(mode: "view" | "edit"): Promise<EmbedUrlResponse> {
  const qs = mode === "edit" ? "?mode=edit" : "";
  const res = await fetch(`/api/tasks/embed-url${qs}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export default function SharedTasksPage() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const isEdit = EMBED_MODE === "edit";
  const { data, isPending, isError, error, refetch } = useQuery<EmbedUrlResponse>({
    queryKey: ["tasks", "embed-url", EMBED_MODE],
    queryFn: () => fetchEmbedUrl(EMBED_MODE),
    // VIEW: 5-min token → refresh comfortably inside that window. EDIT: mint once
    // (30-min token) — no periodic refetch, so an edit session is never reloaded.
    staleTime: isEdit ? Infinity : 4 * 60_000,
    refetchInterval: isEdit ? false : 4 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Re-mint on window focus so a returning tab is never holding a dead token —
  // VIEW mode only. In EDIT mode we deliberately DON'T re-mint on focus: a reload
  // would discard an in-progress edit/drag (a 30-min token + inbox's soft-expiry
  // covers the idle case instead).
  const onFocus = useCallback(() => {
    if (!isEdit) void refetch();
  }, [isEdit, refetch]);
  useEffect(() => {
    if (isEdit) return;
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEdit, onFocus]);

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
