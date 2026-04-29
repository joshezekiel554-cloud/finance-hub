import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TaskCard, type TaskCardData, type TaskStatus } from "./task-card";
import { cn } from "../lib/cn";

type Column = {
  status: TaskStatus;
  label: string;
};

// The Kanban columns we always render. Cancelled is hidden from the board
// by spec; the parent's status filter surfaces it as a chip if needed.
const COLUMNS: Column[] = [
  { status: "open", label: "Open" },
  { status: "in_progress", label: "In progress" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

// Column height for the empty drop target. A small flat number keeps the
// columns side-by-side at a stable height while there are no cards in them.
type DragState = {
  taskId: string;
  fromStatus: TaskStatus;
} | null;

export function TaskBoard({
  tasks,
  onCardClick,
  listQueryKey,
}: {
  tasks: TaskCardData[];
  onCardClick: (taskId: string) => void;
  // Query key the parent uses to cache the tasks list. We invalidate it
  // after a successful PATCH so the board refetches with canonical data.
  listQueryKey: readonly unknown[];
}) {
  const [drag, setDrag] = useState<DragState>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);
  const queryClient = useQueryClient();

  const grouped = useMemo(() => {
    const out: Record<TaskStatus, TaskCardData[]> = {
      open: [],
      in_progress: [],
      blocked: [],
      done: [],
      cancelled: [],
    };
    for (const t of tasks) {
      const bucket = out[t.status as TaskStatus] ?? out.open;
      bucket.push(t);
    }
    // Sort each column ascending by position. Position is stored as a
    // string but represents a float — parse before comparing.
    for (const status of Object.keys(out) as TaskStatus[]) {
      out[status].sort(
        (a, b) => parseFloat(a.position) - parseFloat(b.position),
      );
    }
    return out;
  }, [tasks]);

  const moveMutation = useMutation({
    mutationFn: async (input: {
      taskId: string;
      status: TaskStatus;
      position: string;
    }) => {
      const res = await fetch(`/api/tasks/${input.taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: input.status,
          position: input.position,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onMutate: async (input) => {
      // Optimistic move so the card stays in its new column until the
      // server confirms. On failure, the snapshot below restores the UI.
      await queryClient.cancelQueries({ queryKey: listQueryKey });
      const prev = queryClient.getQueryData(listQueryKey);
      queryClient.setQueryData<{ rows: TaskCardData[] } | undefined>(
        listQueryKey,
        (old) => {
          if (!old) return old;
          return {
            ...old,
            rows: old.rows.map((t) =>
              t.id === input.taskId
                ? { ...t, status: input.status, position: input.position }
                : t,
            ),
          };
        },
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(listQueryKey, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: listQueryKey });
    },
  });

  // Compute the new position for a drop. `targetIndex` is the slot the
  // card should occupy after the move (0 = first). Spec rules:
  //   - empty column → 0
  //   - drop at top → first.position - 1000
  //   - drop at end → last.position + 1000
  //   - drop between A and B → (A.position + B.position) / 2
  function computePosition(
    columnTasks: TaskCardData[],
    targetIndex: number,
    movingTaskId: string,
  ): string {
    const filtered = columnTasks.filter((t) => t.id !== movingTaskId);
    if (filtered.length === 0) return "0";
    if (targetIndex <= 0) {
      const first = parseFloat(filtered[0]!.position);
      return String(first - 1000);
    }
    if (targetIndex >= filtered.length) {
      const last = parseFloat(filtered[filtered.length - 1]!.position);
      return String(last + 1000);
    }
    const before = parseFloat(filtered[targetIndex - 1]!.position);
    const after = parseFloat(filtered[targetIndex]!.position);
    return String((before + after) / 2);
  }

  function handleDropOnColumn(status: TaskStatus, e: React.DragEvent) {
    e.preventDefault();
    setDragOverColumn(null);
    if (!drag) return;
    const newPos = computePosition(grouped[status], grouped[status].length, drag.taskId);
    if (drag.fromStatus === status) {
      // Dropped at end of same column — only update position if it
      // actually changed.
      const current = tasks.find((t) => t.id === drag.taskId);
      if (current && current.position === newPos) {
        setDrag(null);
        return;
      }
    }
    moveMutation.mutate({
      taskId: drag.taskId,
      status,
      position: newPos,
    });
    setDrag(null);
  }

  function handleDropOnCard(
    status: TaskStatus,
    overTaskId: string,
    e: React.DragEvent,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverColumn(null);
    if (!drag) return;
    if (drag.taskId === overTaskId) {
      setDrag(null);
      return;
    }
    const columnTasks = grouped[status];
    const overIndex = columnTasks.findIndex((t) => t.id === overTaskId);
    if (overIndex < 0) {
      setDrag(null);
      return;
    }
    const newPos = computePosition(columnTasks, overIndex, drag.taskId);
    moveMutation.mutate({
      taskId: drag.taskId,
      status,
      position: newPos,
    });
    setDrag(null);
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((col) => {
        const cards = grouped[col.status];
        const isDragOver = dragOverColumn === col.status;
        return (
          <div
            key={col.status}
            className={cn(
              "flex flex-col rounded-lg border border-default bg-subtle transition-colors",
              isDragOver && "border-accent-primary bg-accent-primary/5",
            )}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              setDragOverColumn(col.status);
            }}
            onDragLeave={(e) => {
              // Only clear when leaving the column container itself,
              // not when crossing between cards inside it.
              if (e.currentTarget === e.target) {
                setDragOverColumn((c) => (c === col.status ? null : c));
              }
            }}
            onDrop={(e) => handleDropOnColumn(col.status, e)}
          >
            <div className="flex items-center justify-between border-b border-default px-3 py-2">
              <h3 className="text-sm font-medium text-primary">{col.label}</h3>
              <span className="text-xs text-muted">{cards.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              {cards.length === 0 && (
                <div className="rounded-md border border-dashed border-default px-3 py-6 text-center text-xs text-muted">
                  No tasks
                </div>
              )}
              {cards.map((task) => (
                <div
                  key={task.id}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                  }}
                  onDrop={(e) => handleDropOnCard(col.status, task.id, e)}
                >
                  <TaskCard
                    task={task}
                    draggable
                    isDragging={drag?.taskId === task.id}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      // setData required for some browsers (Firefox) to
                      // initiate the drag operation.
                      e.dataTransfer.setData("text/plain", task.id);
                      setDrag({
                        taskId: task.id,
                        fromStatus: col.status,
                      });
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setDragOverColumn(null);
                    }}
                    onClick={() => onCardClick(task.id)}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
