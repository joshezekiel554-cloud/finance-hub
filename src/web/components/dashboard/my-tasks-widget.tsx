// Dashboard "My tasks" widget — the current user's tasks ASSIGNED TO THEM on
// the shared (inbox) board, via `GET /api/tasks/mine`. Mirrors the finance-
// native TasksWidget style; "View all" deep-links to the embedded board at
// /shared-tasks. Degrades gracefully (empty / error / not-configured states)
// since it calls across to the inbox service.

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

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

function relativeDueDate(iso: string | null): string {
  if (!iso) return "No due date";
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return "No due date";
  const diffDays = Math.floor((due.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return `${-diffDays}d overdue`;
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return `In ${diffDays}d`;
}

export function MyTasksWidget() {
  const { data, isPending, isError, error } = useQuery<{ tasks: MineTask[] }>({
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

  // Differentiate "you have no inbox account" from a transient failure so the
  // empty/error copy is accurate.
  const errMsg = (error as Error | undefined)?.message;
  const noInboxAccount = errMsg === "no_inbox_account";

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="My tasks" count={tasks.length} link="/shared-tasks" />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 animate-pulse rounded bg-subtle" />
            <div className="h-6 animate-pulse rounded bg-subtle" />
            <div className="h-6 animate-pulse rounded bg-subtle" />
          </div>
        ) : isError ? (
          <div className="text-xs text-muted">
            {noInboxAccount
              ? "You don't have an inbox account yet — ask an admin to add you."
              : "Tasks temporarily unavailable."}
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-xs text-muted">No tasks assigned to you.</div>
        ) : (
          <ul className="divide-y divide-default">
            {tasks.map((t) => (
              <li key={t.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/shared-tasks"
                  className="block text-sm hover:text-accent-info"
                >
                  <div className="truncate font-medium text-primary">
                    {t.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span>{relativeDueDate(t.dueAt)}</span>
                    <span>· {t.status}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
