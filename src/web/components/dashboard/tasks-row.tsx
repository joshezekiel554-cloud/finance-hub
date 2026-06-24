// Dashboard "Tasks" row — a full-width band at the TOP of the home dashboard
// showing the current user's tasks (assigned to them on the shared inbox<->
// finance board) with a prominent "New task" button — the headline tasks surface
// on the dashboard. Tasks read from `GET /api/tasks/mine`; "New task" opens the
// shared create dialog; cards + "Open board" deep-link to /shared-tasks.
// Finance-native styling throughout.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, Plus, ArrowRight } from "lucide-react";
import { Card, CardBody } from "../ui/card";
import { Button } from "../ui/button";
import { NewTaskDialog } from "../tasks/new-task-dialog";

type MineTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  financeCustomerId: string | null;
  ownerId: string | null; // inbox calls the assignee "owner"
};

type MineError = { error?: string };

// Due-date pill text + tone. Overdue is the only "loud" state on the dashboard.
function dueLabel(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const diffDays = Math.floor((due.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return { text: `${-diffDays}d overdue`, overdue: true };
  if (diffDays === 0) return { text: "Due today", overdue: false };
  if (diffDays === 1) return { text: "Due tomorrow", overdue: false };
  return { text: `Due in ${diffDays}d`, overdue: false };
}

// Map the inbox status token → a short finance-friendly label.
const STATUS_LABEL: Record<string, string> = {
  UNASSIGNED: "Unassigned",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  WAITING: "Waiting",
  DONE: "Done",
};

const PRIORITY_TONE: Record<string, string> = {
  URGENT: "text-accent-danger",
  IMPORTANT: "text-accent-warning",
};

export function DashboardTasksRow() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery<{
    tasks: MineTask[];
  }>({
    queryKey: ["dashboard", "my-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/tasks/mine");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as MineError;
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const tasks = data?.tasks ?? [];
  const errMsg = (error as Error | undefined)?.message;
  const noInboxAccount = errMsg === "no_inbox_account";

  // Cap the dashboard preview; the full set lives on the board.
  const PREVIEW_CAP = 6;
  const shown = tasks.slice(0, PREVIEW_CAP);
  const overflow = tasks.length - shown.length;

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ListChecks className="size-5 text-accent-info" />
            <h2 className="text-base font-semibold tracking-tight text-primary">
              Tasks
            </h2>
            {tasks.length > 0 ? (
              <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-medium text-secondary">
                {tasks.length}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setNewTaskOpen(true)}>
              <Plus className="size-3.5" /> New task
            </Button>
            <Link to="/shared-tasks">
              <Button variant="secondary" size="sm">
                Open board <ArrowRight className="size-3.5" />
              </Button>
            </Link>
          </div>
        </div>

        <NewTaskDialog
          open={newTaskOpen}
          onOpenChange={setNewTaskOpen}
          onCreated={() => void refetch()}
        />

        <div className="mt-4">
          {isPending ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-subtle" />
              ))}
            </div>
          ) : isError ? (
            <div className="text-sm text-muted">
              {noInboxAccount
                ? "You don't have an inbox account yet — ask an admin to add you."
                : "Tasks temporarily unavailable."}
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex items-center justify-between rounded-lg border border-dashed border-default px-4 py-6">
              <div className="text-sm text-secondary">
                No tasks assigned to you. Create one or open the board to grab from
                the pool.
              </div>
              <Button size="sm" variant="secondary" onClick={() => setNewTaskOpen(true)}>
                <Plus className="size-3.5" /> New task
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((t) => {
                  const due = dueLabel(t.dueAt);
                  return (
                    <Link
                      key={t.id}
                      to="/shared-tasks"
                      className="group flex flex-col gap-1.5 rounded-lg border border-default bg-base p-3 transition-colors hover:border-accent-info/50 hover:bg-elevated"
                    >
                      <div className="line-clamp-2 text-sm font-medium text-primary">
                        {t.title}
                      </div>
                      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <span className={PRIORITY_TONE[t.priority] ?? ""}>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </span>
                        {due ? (
                          <span
                            className={
                              due.overdue
                                ? "font-medium text-accent-danger"
                                : "text-muted"
                            }
                          >
                            · {due.text}
                          </span>
                        ) : null}
                      </div>
                    </Link>
                  );
                })}
              </div>
              {overflow > 0 ? (
                <Link
                  to="/shared-tasks"
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-info hover:underline"
                >
                  +{overflow} more on the board <ArrowRight className="size-3" />
                </Link>
              ) : null}
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
