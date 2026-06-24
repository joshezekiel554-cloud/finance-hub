// Shared Tasks page — embeds the inbox GLOBAL tasks board, scoped to the
// logged-in finance user via a short-lived token minted by
// `GET /api/tasks/embed-url`. Mounted at /shared-tasks. The finance-native
// Kanban has been retired; this IS the tasks board now.
//
// The board itself is inbox's UI (full SSE/live updates for free). The iframe +
// token-refresh handshake live in the reusable <TasksEmbed> component (shared
// with the customer-detail Tasks tab). `isTokenRefreshRequest` is re-exported
// here so the existing shared-tasks.test.ts import keeps working.

import { useCallback, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { NewTaskDialog } from "../components/tasks/new-task-dialog";
import {
  TasksEmbed,
  type TasksEmbedHandle,
} from "../components/tasks/tasks-embed";

export { isTokenRefreshRequest } from "../components/tasks/tasks-embed";

export default function SharedTasksPage() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [embed, setEmbed] = useState<TasksEmbedHandle | null>(null);
  // Memoize the onReady handler so the embed doesn't re-fire it every render.
  const onReady = useCallback((handle: TasksEmbedHandle) => setEmbed(handle), []);

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
            onClick={() => embed?.refetch()}
            disabled={embed?.isPending ?? true}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
      </div>

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        // Re-mint the embed URL so a just-created task shows on the board.
        onCreated={() => embed?.refetch()}
      />

      <TasksEmbed mode="edit" onReady={onReady} />
    </div>
  );
}
