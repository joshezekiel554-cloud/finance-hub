import { useMemo, useState } from "react";
import { Card, CardBody } from "./ui/card";
import { Badge } from "./ui/badge";
import {
  AlertCircle,
  Calendar,
  MessageSquare,
  Eye,
  AtSign,
} from "lucide-react";
import { cn } from "../lib/cn";
import type {
  TaskCardData,
  TaskPriority,
  TaskStatus,
} from "./task-card";

type SortKey = "title" | "priority" | "dueAt" | "status" | "updatedAt";

const PRIORITY_TONE: Record<
  TaskPriority,
  "neutral" | "info" | "high" | "critical"
> = {
  low: "neutral",
  normal: "info",
  high: "high",
  urgent: "critical",
};

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<
  TaskStatus,
  "neutral" | "info" | "high" | "success"
> = {
  open: "neutral",
  in_progress: "info",
  blocked: "high",
  done: "success",
  cancelled: "neutral",
};

type ListTask = TaskCardData & {
  updatedAt?: string;
};

export function TaskList({
  tasks,
  onRowClick,
}: {
  tasks: ListTask[];
  onRowClick: (taskId: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("dueAt");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const out = [...tasks];
    const factor = dir === "asc" ? 1 : -1;
    out.sort((a, b) => {
      switch (sort) {
        case "title":
          return factor * a.title.localeCompare(b.title);
        case "priority":
          return factor * (PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
        case "dueAt": {
          const av = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
          const bv = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
          return factor * (av - bv);
        }
        case "status":
          return factor * a.status.localeCompare(b.status);
        case "updatedAt": {
          const av = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bv = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return factor * (av - bv);
        }
      }
    });
    return out;
  }, [tasks, sort, dir]);

  function toggleSort(col: SortKey) {
    if (sort === col) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(col);
      setDir(col === "priority" || col === "updatedAt" ? "desc" : "asc");
    }
  }

  return (
    <Card>
      <CardBody className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <SortableTh
                label="Task"
                col="title"
                active={sort}
                dir={dir}
                onClick={toggleSort}
              />
              <SortableTh
                label="Priority"
                col="priority"
                active={sort}
                dir={dir}
                onClick={toggleSort}
              />
              <SortableTh
                label="Status"
                col="status"
                active={sort}
                dir={dir}
                onClick={toggleSort}
              />
              <SortableTh
                label="Due"
                col="dueAt"
                active={sort}
                dir={dir}
                onClick={toggleSort}
              />
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Assignee</th>
              <th className="px-3 py-2 text-right">Activity</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((task) => {
              const due = task.dueAt ? new Date(task.dueAt) : null;
              const overdue = due ? due.getTime() < Date.now() : false;
              return (
                <tr
                  key={task.id}
                  onClick={() => onRowClick(task.id)}
                  className="cursor-pointer border-b border-default last:border-b-0 hover:bg-elevated"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{task.title}</div>
                    {task.tags.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {task.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-sm bg-elevated px-1 py-0.5 text-[10px] text-secondary"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={PRIORITY_TONE[task.priority]}>
                      {task.priority}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[task.status]}>
                      {STATUS_LABEL[task.status]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {due ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-xs",
                          overdue ? "text-accent-danger" : "text-secondary",
                        )}
                      >
                        {overdue ? (
                          <AlertCircle className="size-3" />
                        ) : (
                          <Calendar className="size-3" />
                        )}
                        {due.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-secondary">
                    {task.customerName ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-secondary">
                    {task.assignee?.name ??
                      task.assignee?.email.split("@")[0] ??
                      "Unassigned"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted">
                    <span className="inline-flex items-center gap-3">
                      {(task.commentCount ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <MessageSquare className="size-3" />
                          {task.commentCount}
                        </span>
                      )}
                      {(task.watcherCount ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <Eye className="size-3" />
                          {task.watcherCount}
                        </span>
                      )}
                      {(task.mentionCount ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-accent-primary">
                          <AtSign className="size-3" />
                          {task.mentionCount}
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td
                  className="p-8 text-center text-sm text-muted"
                  colSpan={7}
                >
                  No tasks match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

function SortableTh({
  label,
  col,
  active,
  dir,
  onClick,
}: {
  label: string;
  col: SortKey;
  active: SortKey;
  dir: "asc" | "desc";
  onClick: (col: SortKey) => void;
}) {
  return (
    <th
      onClick={() => onClick(col)}
      className="cursor-pointer select-none px-3 py-2 hover:text-primary"
    >
      {label}
      {active === col && <span className="ml-1">{dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}
