// Dashboard "Tasks" board — the full shared inbox<->finance board (the 5
// columns: Unassigned / To do / In progress / Waiting / Done) embedded at the
// TOP of the home dashboard, fixed-height so it never grows the page (each
// column scrolls within). Same embed the Tasks page renders, so inbox's finance
// skin themes both. A "+ New task" button (opens the shared create dialog) +
// "Open full board" sit in the header above the board.

import { useCallback, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ListChecks, Plus, ArrowRight } from "lucide-react";
import { Button } from "../ui/button";
import { NewTaskDialog } from "../tasks/new-task-dialog";
import { TasksEmbed, type TasksEmbedHandle } from "../tasks/tasks-embed";

export function DashboardBoard() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [embed, setEmbed] = useState<TasksEmbedHandle | null>(null);
  // Memoize so TasksEmbed doesn't re-fire onReady every render.
  const onReady = useCallback((h: TasksEmbedHandle) => setEmbed(h), []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ListChecks className="size-5 text-accent-info" />
          <h2 className="text-base font-semibold tracking-tight text-primary">
            Tasks
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setNewTaskOpen(true)}>
            <Plus className="size-3.5" /> New task
          </Button>
          <Link to="/shared-tasks">
            <Button variant="secondary" size="sm">
              Open full board <ArrowRight className="size-3.5" />
            </Button>
          </Link>
        </div>
      </div>

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        // Re-mint the embed so a just-created task shows on the board.
        onCreated={() => embed?.refetch()}
      />

      {/* Fixed-height board: the columns scroll within, so the dashboard stays
          compact regardless of task volume. */}
      <TasksEmbed
        mode="edit"
        onReady={onReady}
        className="h-[28rem] w-full rounded-lg border border-default bg-base"
      />
    </div>
  );
}
