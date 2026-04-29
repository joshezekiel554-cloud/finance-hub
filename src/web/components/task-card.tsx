import {
  AlertCircle,
  Calendar,
  MessageSquare,
  Eye,
  AtSign,
  User as UserIcon,
} from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskCardData = {
  id: string;
  customerId: string | null;
  assigneeUserId: string | null;
  title: string;
  body: string | null;
  dueAt: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  tags: string[];
  position: string;
  // Optional joined fields the API may include for card render. They're
  // not strictly required by the spec — when missing, the card renders
  // gracefully without them.
  customerName?: string | null;
  assignee?: { id: string; name: string | null; email: string; image: string | null } | null;
  commentCount?: number;
  watcherCount?: number;
  mentionCount?: number;
};

const PRIORITY_TONE: Record<
  TaskPriority,
  "neutral" | "info" | "high" | "critical"
> = {
  low: "neutral",
  normal: "info",
  high: "high",
  urgent: "critical",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function TaskCard({
  task,
  onClick,
  draggable = false,
  onDragStart,
  onDragEnd,
  isDragging = false,
}: {
  task: TaskCardData;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  isDragging?: boolean;
}) {
  const due = task.dueAt ? new Date(task.dueAt) : null;
  const dueState = computeDueState(due);
  const comments = task.commentCount ?? 0;
  const watchers = task.watcherCount ?? 0;
  const mentions = task.mentionCount ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group cursor-pointer rounded-md border border-default bg-base p-3 text-left text-sm shadow-sm transition-all",
        "hover:border-strong hover:shadow-md",
        "focus:outline-none focus:ring-2 focus:ring-accent-primary/40",
        isDragging && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="line-clamp-2 min-w-0 flex-1 font-medium text-primary">
          {task.title}
        </div>
        <Badge tone={PRIORITY_TONE[task.priority]}>
          {PRIORITY_LABEL[task.priority]}
        </Badge>
      </div>

      {(due || task.customerName) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
          {due && (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                dueState === "overdue" && "text-accent-danger",
                dueState === "today" && "text-accent-warning",
                dueState === "soon" && "text-accent-info",
              )}
            >
              {dueState === "overdue" ? (
                <AlertCircle className="size-3" />
              ) : (
                <Calendar className="size-3" />
              )}
              {formatDue(due, dueState)}
            </span>
          )}
          {task.customerName && (
            <span className="inline-flex max-w-[12rem] items-center gap-1 truncate">
              <UserIcon className="size-3 shrink-0" />
              <span className="truncate">{task.customerName}</span>
            </span>
          )}
        </div>
      )}

      {task.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-sm bg-elevated px-1.5 py-0.5 text-[11px] text-secondary"
            >
              #{tag}
            </span>
          ))}
          {task.tags.length > 4 && (
            <span className="text-[11px] text-muted">
              +{task.tags.length - 4}
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
        <div className="flex items-center gap-2">
          <Avatar assignee={task.assignee} />
          <span className="truncate">
            {task.assignee?.name ?? task.assignee?.email.split("@")[0] ?? "Unassigned"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {comments > 0 && (
            <span
              className="inline-flex items-center gap-0.5"
              title={`${comments} comment${comments === 1 ? "" : "s"}`}
            >
              <MessageSquare className="size-3" />
              {comments}
            </span>
          )}
          {watchers > 0 && (
            <span
              className="inline-flex items-center gap-0.5"
              title={`${watchers} watcher${watchers === 1 ? "" : "s"}`}
            >
              <Eye className="size-3" />
              {watchers}
            </span>
          )}
          {mentions > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-accent-primary"
              title={`${mentions} unread mention${mentions === 1 ? "" : "s"}`}
            >
              <AtSign className="size-3" />
              {mentions}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Avatar({
  assignee,
}: {
  assignee: TaskCardData["assignee"];
}) {
  if (!assignee) {
    return (
      <div className="flex size-5 items-center justify-center rounded-full bg-elevated text-[10px] text-muted">
        ?
      </div>
    );
  }
  if (assignee.image) {
    return (
      <img
        src={assignee.image}
        alt=""
        className="size-5 shrink-0 rounded-full"
      />
    );
  }
  const seed = assignee.name ?? assignee.email;
  return (
    <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-primary/15 text-[10px] font-medium text-accent-primary">
      {seed.charAt(0).toUpperCase()}
    </div>
  );
}

type DueState = "overdue" | "today" | "soon" | "later";

function computeDueState(due: Date | null): DueState | null {
  if (!due) return null;
  const now = new Date();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  if (due.getTime() < now.getTime()) return "overdue";
  if (due.getTime() <= todayEnd.getTime()) return "today";
  const threeDays = todayEnd.getTime() + 3 * 24 * 60 * 60 * 1000;
  if (due.getTime() <= threeDays) return "soon";
  return "later";
}

function formatDue(due: Date, state: DueState | null): string {
  if (state === "overdue") {
    const diffMs = Date.now() - due.getTime();
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return "Overdue today";
    return `${diffDays}d overdue`;
  }
  if (state === "today") return "Due today";
  return due.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
