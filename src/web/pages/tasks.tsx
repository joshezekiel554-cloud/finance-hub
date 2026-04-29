import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, LayoutGrid, List as ListIcon, Search, X } from "lucide-react";
import {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
} from "../components/ui/toast";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { TaskBoard } from "../components/task-board";
import { TaskList } from "../components/task-list";
import {
  TaskDetailDrawer,
  type DrawerMode,
} from "../components/task-detail-drawer";
import type { TaskCardData } from "../components/task-card";
import { useEventStream } from "../lib/use-event-stream";
import { cn } from "../lib/cn";

type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
type TaskPriority = "low" | "normal" | "high" | "urgent";

type Task = TaskCardData & {
  createdByUserId: string | null;
  relatedActivityId: string | null;
  aiProposed: boolean;
  completedAt: string | null;
  completedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = {
  rows: Task[];
  hasMore: boolean;
};

type CurrentUserResponse = {
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
};

type ToastEntry = {
  id: string;
  title: string;
  description?: string;
  tone?: "info" | "success" | "danger" | "neutral";
};

type View = "board" | "list";
type AssigneeFilter = "me" | "all";

const ALL_STATUSES: TaskStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
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

const DEFAULT_STATUS_FILTER: TaskStatus[] = ["open", "in_progress", "blocked"];

export default function TasksPage() {
  const [view, setView] = useState<View>("board");
  const [assignee, setAssignee] = useState<AssigneeFilter>("me");
  const [statusFilter, setStatusFilter] = useState<Set<TaskStatus>>(
    new Set(DEFAULT_STATUS_FILTER),
  );
  const [priorityFilter, setPriorityFilter] = useState<Set<TaskPriority>>(
    new Set(),
  );
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [customerFilter, setCustomerFilter] = useState<{
    id: string;
    displayName: string;
  } | null>(null);
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const queryClient = useQueryClient();

  const { data: meData } = useQuery<CurrentUserResponse>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const currentUser = meData?.user ?? null;

  // Single canonical query key — passed to every mutation/board so the
  // optimistic updates and SSE invalidations share the same cache slot.
  const listQueryKey = useMemo(
    () =>
      [
        "tasks",
        {
          assignee,
          status: Array.from(statusFilter).sort().join(","),
          q: search.trim(),
          customerId: customerFilter?.id ?? "",
        },
      ] as const,
    [assignee, statusFilter, search, customerFilter],
  );

  const { data, isPending, isError, error } = useQuery<ListResponse>({
    queryKey: listQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        sort: "position",
        dir: "asc",
        limit: "200",
      });
      if (assignee === "me") params.set("assignee", "me");
      if (statusFilter.size > 0) {
        params.set("status", Array.from(statusFilter).join(","));
      }
      if (search.trim()) params.set("q", search.trim());
      if (customerFilter) params.set("customerId", customerFilter.id);
      const res = await fetch(`/api/tasks?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const allRows = data?.rows ?? [];

  // Tag filter is built from the loaded rows themselves — there's no
  // server-side tag list to fetch. Active tag chips that no longer apply
  // (because the data refetched without them) are quietly dropped.
  const presentTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of allRows) for (const tag of t.tags) set.add(tag);
    return Array.from(set).sort();
  }, [allRows]);

  const visibleRows = useMemo(() => {
    return allRows.filter((t) => {
      if (priorityFilter.size > 0 && !priorityFilter.has(t.priority))
        return false;
      if (tagFilter.size > 0 && !t.tags.some((tag) => tagFilter.has(tag)))
        return false;
      return true;
    });
  }, [allRows, priorityFilter, tagFilter]);

  // SSE wiring. Task changes invalidate the list. Mention events fire a toast.
  useEventStream("task.created", () => {
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
  });
  useEventStream("task.updated", () => {
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
  });
  useEventStream("task.completed", () => {
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
  });
  useEventStream("mention", (event) => {
    if (currentUser && event.mentionedUserId !== currentUser.id) return;
    pushToast({
      title: "You were mentioned",
      description: event.excerpt,
      tone: "info",
    });
  });

  function pushToast(t: Omit<ToastEntry, "id">) {
    const id = Math.random().toString(36).slice(2);
    setToasts((cur) => [...cur, { id, ...t }]);
  }

  function dismissToast(id: string) {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }

  function toggleStatus(s: TaskStatus) {
    const next = new Set(statusFilter);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setStatusFilter(next);
  }

  function togglePriority(p: TaskPriority) {
    const next = new Set(priorityFilter);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setPriorityFilter(next);
  }

  function toggleTag(t: string) {
    const next = new Set(tagFilter);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTagFilter(next);
  }

  function openCard(taskId: string) {
    setDrawer({ mode: "edit", taskId });
  }

  return (
    <ToastProvider swipeDirection="right" duration={6000}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
            <p className="mt-1 text-sm text-secondary">
              Plan and track work across the team. Drag cards between
              columns; @-mention teammates in comments.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ViewToggle view={view} onChange={setView} />
            <Button
              variant="primary"
              size="sm"
              onClick={() => setDrawer({ mode: "create" })}
            >
              <Plus className="size-3.5" />
              New task
            </Button>
          </div>
        </div>

        <FilterBar
          assignee={assignee}
          onAssigneeChange={setAssignee}
          statusFilter={statusFilter}
          onToggleStatus={toggleStatus}
          priorityFilter={priorityFilter}
          onTogglePriority={togglePriority}
          tagFilter={tagFilter}
          onToggleTag={toggleTag}
          presentTags={presentTags}
          search={search}
          onSearchChange={setSearch}
          customerFilter={customerFilter}
          onCustomerFilterChange={setCustomerFilter}
        />

        {isError && (
          <Card>
            <CardBody className="text-sm text-accent-danger">
              {(error as Error)?.message ?? "Failed to load tasks"}
            </CardBody>
          </Card>
        )}

        {isPending && (
          <Card>
            <CardBody className="text-sm text-secondary">
              Loading tasks…
            </CardBody>
          </Card>
        )}

        {!isPending && !isError && (
          <>
            <div className="text-xs text-muted">
              {visibleRows.length}
              {data?.hasMore ? "+" : ""} task
              {visibleRows.length === 1 ? "" : "s"}
              {visibleRows.length !== allRows.length && (
                <> · {allRows.length} before priority/tag filters</>
              )}
            </div>
            {view === "board" ? (
              <TaskBoard
                tasks={visibleRows}
                onCardClick={openCard}
                listQueryKey={listQueryKey}
              />
            ) : (
              <TaskList tasks={visibleRows} onRowClick={openCard} />
            )}
          </>
        )}
      </div>

      <TaskDetailDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        drawer={drawer ?? { mode: "create" }}
        currentUser={currentUser}
        listQueryKey={listQueryKey}
        onCreated={(taskId) => setDrawer({ mode: "edit", taskId })}
      />

      <ToastViewport />
      {toasts.map((t) => (
        <Toast
          key={t.id}
          tone={t.tone ?? "neutral"}
          onOpenChange={(open) => {
            if (!open) dismissToast(t.id);
          }}
        >
          <ToastTitle>{t.title}</ToastTitle>
          {t.description && (
            <ToastDescription>{t.description}</ToastDescription>
          )}
          <ToastClose />
        </Toast>
      ))}
    </ToastProvider>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-default bg-subtle p-0.5 text-sm">
      <button
        type="button"
        onClick={() => onChange("board")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          view === "board"
            ? "bg-base font-medium text-primary shadow-sm"
            : "text-secondary hover:text-primary",
        )}
      >
        <LayoutGrid className="size-3.5" />
        Kanban
      </button>
      <button
        type="button"
        onClick={() => onChange("list")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          view === "list"
            ? "bg-base font-medium text-primary shadow-sm"
            : "text-secondary hover:text-primary",
        )}
      >
        <ListIcon className="size-3.5" />
        List
      </button>
    </div>
  );
}

function FilterBar({
  assignee,
  onAssigneeChange,
  statusFilter,
  onToggleStatus,
  priorityFilter,
  onTogglePriority,
  tagFilter,
  onToggleTag,
  presentTags,
  search,
  onSearchChange,
  customerFilter,
  onCustomerFilterChange,
}: {
  assignee: AssigneeFilter;
  onAssigneeChange: (v: AssigneeFilter) => void;
  statusFilter: Set<TaskStatus>;
  onToggleStatus: (s: TaskStatus) => void;
  priorityFilter: Set<TaskPriority>;
  onTogglePriority: (p: TaskPriority) => void;
  tagFilter: Set<string>;
  onToggleTag: (t: string) => void;
  presentTags: string[];
  search: string;
  onSearchChange: (v: string) => void;
  customerFilter: { id: string; displayName: string } | null;
  onCustomerFilterChange: (v: { id: string; displayName: string } | null) => void;
}) {
  return (
    <Card>
      <CardBody className="space-y-3 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <ChipGroup label="Assignee">
            <Chip
              active={assignee === "me"}
              onClick={() => onAssigneeChange("me")}
            >
              My tasks
            </Chip>
            <Chip
              active={assignee === "all"}
              onClick={() => onAssigneeChange("all")}
            >
              All
            </Chip>
          </ChipGroup>
          <CustomerFilterPicker
            value={customerFilter}
            onChange={onCustomerFilterChange}
          />
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search title, body…"
              className="!pl-8"
              aria-label="Search tasks"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ChipGroup label="Status">
            {ALL_STATUSES.map((s) => (
              <Chip
                key={s}
                active={statusFilter.has(s)}
                onClick={() => onToggleStatus(s)}
              >
                {STATUS_LABELS[s]}
              </Chip>
            ))}
          </ChipGroup>

          <ChipGroup label="Priority">
            {(["urgent", "high", "normal", "low"] as TaskPriority[]).map(
              (p) => (
                <Chip
                  key={p}
                  active={priorityFilter.has(p)}
                  onClick={() => onTogglePriority(p)}
                  tone={PRIORITY_TONE[p]}
                >
                  {PRIORITY_LABELS[p]}
                </Chip>
              ),
            )}
          </ChipGroup>
        </div>

        {presentTags.length > 0 && (
          <ChipGroup label="Tags">
            {presentTags.map((t) => (
              <Chip
                key={t}
                active={tagFilter.has(t)}
                onClick={() => onToggleTag(t)}
              >
                #{t}
              </Chip>
            ))}
          </ChipGroup>
        )}
      </CardBody>
    </Card>
  );
}

type CustomerOption = {
  id: string;
  displayName: string;
  primaryEmail?: string | null;
};

function CustomerFilterPicker({
  value,
  onChange,
}: {
  value: { id: string; displayName: string } | null;
  onChange: (v: { id: string; displayName: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerOption[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          customerType: "all",
          limit: "20",
        });
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/customers?${params.toString()}`);
        if (!res.ok) {
          setResults([]);
          return;
        }
        const body = (await res.json()) as { rows: CustomerOption[] };
        setResults(body.rows);
      } catch {
        setResults([]);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {value ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-accent-primary bg-accent-primary/10 px-2.5 py-0.5 text-xs text-accent-primary">
          <span className="max-w-[10rem] truncate">{value.displayName}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded-full p-0.5 hover:bg-accent-primary/20"
            aria-label="Clear customer filter"
          >
            <X className="size-3" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-full border border-default px-2.5 py-0.5 text-xs text-secondary hover:border-strong hover:text-primary"
        >
          <span className="text-muted">Customer:</span>
          Any
        </button>
      )}
      {open && !value && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-default bg-base shadow-lg">
          <div className="border-b border-default p-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customers…"
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm focus:outline-none"
              autoFocus
            />
          </div>
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onChange({ id: c.id, displayName: c.displayName });
                setOpen(false);
                setQuery("");
              }}
              className="block w-full border-t border-default px-3 py-2 text-left text-sm hover:bg-elevated first:border-t-0"
            >
              <span className="block truncate font-medium">
                {c.displayName}
              </span>
              {c.primaryEmail && (
                <span className="block truncate text-xs text-muted">
                  {c.primaryEmail}
                </span>
              )}
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">No matches.</div>
          )}
        </div>
      )}
    </div>
  );
}

function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-muted">{label}:</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "neutral" | "info" | "high" | "critical";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
          : "border-default text-secondary hover:border-strong hover:text-primary",
        tone === "critical" && active && "border-accent-danger bg-accent-danger/10 text-accent-danger",
        tone === "high" && active && "border-accent-warning bg-accent-warning/10 text-accent-warning",
      )}
    >
      {children}
    </button>
  );
}
