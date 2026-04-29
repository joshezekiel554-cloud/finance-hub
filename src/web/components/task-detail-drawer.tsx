import { useEffect, useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  X,
  Trash2,
  Eye,
  EyeOff,
  Plus,
  Calendar as CalendarIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { useEventStream } from "../lib/use-event-stream";
import { CommentsThread, type Comment } from "./comments-thread";
import { cn } from "../lib/cn";
import type {
  TaskCardData,
  TaskPriority,
  TaskStatus,
} from "./task-card";

type User = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

type TaskFull = TaskCardData & {
  body: string | null;
  createdByUserId: string | null;
  relatedActivityId: string | null;
  aiProposed: boolean;
  completedAt: string | null;
  completedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type DetailResponse = {
  task: TaskFull;
  comments: Comment[];
  watchers: User[];
  mentions: unknown[];
};

type CustomerOption = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
};

const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export type DrawerMode =
  | { mode: "edit"; taskId: string }
  | { mode: "create"; defaults?: Partial<TaskFull> };

export function TaskDetailDrawer({
  open,
  onClose,
  drawer,
  currentUser,
  listQueryKey,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  drawer: DrawerMode;
  currentUser: User | null;
  listQueryKey: readonly unknown[];
  // Create mode → after POST succeeds, the parent flips drawer to edit mode.
  onCreated?: (taskId: string) => void;
}) {
  // Lock background scroll while the drawer is open and listen for Escape.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Task detail"
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-default bg-base shadow-xl transition-transform",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {open && drawer.mode === "edit" && (
          <EditDrawerBody
            taskId={drawer.taskId}
            onClose={onClose}
            currentUser={currentUser}
            listQueryKey={listQueryKey}
          />
        )}
        {open && drawer.mode === "create" && (
          <CreateDrawerBody
            onClose={onClose}
            defaults={drawer.defaults}
            currentUser={currentUser}
            listQueryKey={listQueryKey}
            onCreated={onCreated}
          />
        )}
      </aside>
    </>
  );
}

function CreateDrawerBody({
  onClose,
  defaults,
  currentUser,
  listQueryKey,
  onCreated,
}: {
  onClose: () => void;
  defaults?: Partial<TaskFull>;
  currentUser: User | null;
  listQueryKey: readonly unknown[];
  onCreated?: (taskId: string) => void;
}) {
  const [title, setTitle] = useState(defaults?.title ?? "");
  const [body, setBody] = useState(defaults?.body ?? "");
  const [priority, setPriority] = useState<TaskPriority>(
    (defaults?.priority as TaskPriority) ?? "normal",
  );
  const [status, setStatus] = useState<TaskStatus>(
    (defaults?.status as TaskStatus) ?? "open",
  );
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(
    defaults?.assigneeUserId ?? currentUser?.id ?? null,
  );
  const [customerId, setCustomerId] = useState<string | null>(
    defaults?.customerId ?? null,
  );
  const [dueAt, setDueAt] = useState<string>(
    defaults?.dueAt ? toLocalDatetimeInput(defaults.dueAt) : "",
  );
  const [tags, setTags] = useState<string[]>(defaults?.tags ?? []);

  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim() || undefined,
          status,
          priority,
          assigneeUserId,
          customerId,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
          tags,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ task: TaskFull }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: listQueryKey });
      onCreated?.(data.task.id);
    },
  });

  return (
    <>
      <DrawerHeader
        title="New task"
        onClose={onClose}
        right={null}
      />
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <TitleField value={title} onChange={setTitle} autoFocus />
        <BodyField value={body} onChange={setBody} />
        <FieldGrid>
          <StatusField value={status} onChange={setStatus} />
          <PriorityField value={priority} onChange={setPriority} />
          <AssigneeField
            value={assigneeUserId}
            onChange={setAssigneeUserId}
          />
          <DueField value={dueAt} onChange={setDueAt} />
          <CustomerField value={customerId} onChange={setCustomerId} />
        </FieldGrid>
        <TagsField value={tags} onChange={setTags} />
        {createMutation.isError && (
          <p className="text-xs text-accent-danger">
            {(createMutation.error as Error).message}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-default p-4">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!title.trim() || createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? "Creating…" : "Create task"}
        </Button>
      </div>
    </>
  );
}

function EditDrawerBody({
  taskId,
  onClose,
  currentUser,
  listQueryKey,
}: {
  taskId: string;
  onClose: () => void;
  currentUser: User | null;
  listQueryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const taskQueryKey = useMemo(() => ["task", taskId] as const, [taskId]);

  const { data, isPending, isError, error } = useQuery<DetailResponse>({
    queryKey: taskQueryKey,
    queryFn: async () => {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // Refetch on comment.created for this task (live updates while open).
  useEventStream("comment.created", (event) => {
    if (event.parentType !== "task" || event.parentId !== taskId) return;
    queryClient.invalidateQueries({ queryKey: taskQueryKey });
  });

  const patchMutation = useMutation({
    mutationFn: async (patch: Partial<TaskFull>) => {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskQueryKey });
      queryClient.invalidateQueries({ queryKey: listQueryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listQueryKey });
      onClose();
    },
  });

  const watchMutation = useMutation({
    mutationFn: async (watching: boolean) => {
      const res = await fetch(`/api/tasks/${taskId}/watch`, {
        method: watching ? "POST" : "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskQueryKey });
    },
  });

  if (isPending) {
    return (
      <>
        <DrawerHeader title="Loading…" onClose={onClose} right={null} />
        <div className="flex-1 p-5 text-sm text-muted">Loading task…</div>
      </>
    );
  }
  if (isError) {
    return (
      <>
        <DrawerHeader title="Error" onClose={onClose} right={null} />
        <div className="flex-1 p-5 text-sm text-accent-danger">
          {(error as Error).message ?? "Failed to load task"}
        </div>
      </>
    );
  }
  if (!data) return null;

  const { task, comments, watchers } = data;
  const isWatching =
    currentUser !== null && watchers.some((w) => w.id === currentUser.id);

  return (
    <>
      <DrawerHeader
        title={null}
        onClose={onClose}
        right={
          <div className="flex items-center gap-1">
            {currentUser && (
              <Button
                variant={isWatching ? "secondary" : "ghost"}
                size="sm"
                disabled={watchMutation.isPending}
                onClick={() => watchMutation.mutate(!isWatching)}
              >
                {isWatching ? (
                  <>
                    <EyeOff className="size-3.5" />
                    Unwatch
                  </>
                ) : (
                  <>
                    <Eye className="size-3.5" />
                    Watch
                  </>
                )}
              </Button>
            )}
            <button
              type="button"
              onClick={() => {
                if (confirm("Delete this task? This cannot be undone."))
                  deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className="rounded-md p-2 text-muted hover:bg-elevated hover:text-accent-danger"
              aria-label="Delete task"
              title="Delete task"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-4 border-b border-default p-5">
          <InlineTitleField
            value={task.title}
            onSave={(t) => patchMutation.mutate({ title: t })}
          />
          <InlineBodyField
            value={task.body ?? ""}
            onSave={(b) => patchMutation.mutate({ body: b })}
          />
          <FieldGrid>
            <StatusField
              value={task.status}
              onChange={(s) => patchMutation.mutate({ status: s })}
            />
            <PriorityField
              value={task.priority}
              onChange={(p) => patchMutation.mutate({ priority: p })}
            />
            <AssigneeField
              value={task.assigneeUserId}
              onChange={(id) => patchMutation.mutate({ assigneeUserId: id })}
            />
            <DueField
              value={task.dueAt ? toLocalDatetimeInput(task.dueAt) : ""}
              onChange={(v) =>
                patchMutation.mutate({
                  dueAt: v ? new Date(v).toISOString() : null,
                })
              }
            />
            <CustomerField
              value={task.customerId}
              onChange={(id) => patchMutation.mutate({ customerId: id })}
            />
          </FieldGrid>
          <TagsField
            value={task.tags}
            onChange={(t) => patchMutation.mutate({ tags: t })}
          />
          <WatchersStack
            watchers={watchers}
            currentUserId={currentUser?.id ?? null}
          />
          {task.relatedActivityId && (
            <div className="text-xs text-muted">
              Related to activity{" "}
              <span className="font-mono">{task.relatedActivityId}</span>
            </div>
          )}
          {task.aiProposed && (
            <Badge tone="info">AI proposed</Badge>
          )}
          {patchMutation.isError && (
            <p className="text-xs text-accent-danger">
              {(patchMutation.error as Error).message}
            </p>
          )}
        </div>

        <div className="p-5">
          <h3 className="mb-3 text-sm font-medium text-secondary">Comments</h3>
          <CommentsThread
            taskId={task.id}
            comments={comments}
            currentUserId={currentUser?.id ?? null}
            taskQueryKey={taskQueryKey}
          />
        </div>
      </div>
    </>
  );
}

function DrawerHeader({
  title,
  onClose,
  right,
}: {
  title: string | null;
  onClose: () => void;
  right: React.ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-default px-5 py-3">
      <h2 className="truncate text-base font-semibold">{title ?? "Task"}</h2>
      <div className="flex items-center gap-1">
        {right}
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-muted hover:bg-elevated hover:text-primary"
          aria-label="Close drawer"
        >
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-secondary">
      {children}
    </span>
  );
}

function TitleField({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <FieldLabel>Title</FieldLabel>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        className="w-full rounded-md border border-default bg-base px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
      />
    </label>
  );
}

function BodyField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <FieldLabel>Description</FieldLabel>
      <textarea
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-md border border-default bg-base px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
        placeholder="Optional details, context, links…"
      />
    </label>
  );
}

// Like TitleField, but commits on blur — saves a roundtrip on every keystroke.
function InlineTitleField({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="block">
      <FieldLabel>Title</FieldLabel>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (trimmed && trimmed !== value) onSave(trimmed);
          else setDraft(value);
        }}
        className="w-full rounded-md border border-default bg-base px-3 py-2 text-base font-semibold focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
      />
    </label>
  );
}

function InlineBodyField({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="block">
      <FieldLabel>Description</FieldLabel>
      <textarea
        rows={4}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onSave(draft);
        }}
        className="w-full resize-y rounded-md border border-default bg-base px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
        placeholder="Add a description…"
      />
    </label>
  );
}

function StatusField({
  value,
  onChange,
}: {
  value: TaskStatus;
  onChange: (v: TaskStatus) => void;
}) {
  return (
    <label className="block">
      <FieldLabel>Status</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TaskStatus)}
        className="w-full rounded-md border border-default bg-base px-2 py-2 text-sm"
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PriorityField({
  value,
  onChange,
}: {
  value: TaskPriority;
  onChange: (v: TaskPriority) => void;
}) {
  return (
    <label className="block">
      <FieldLabel>Priority</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TaskPriority)}
        className="w-full rounded-md border border-default bg-base px-2 py-2 text-sm"
      >
        {PRIORITIES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DueField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <FieldLabel>Due date</FieldLabel>
      <div className="relative">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-default bg-base pl-8 pr-2 py-2 text-sm"
        />
        <CalendarIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
      </div>
    </label>
  );
}

function AssigneeField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<User[]>([]);
  const [selected, setSelected] = useState<User | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve the current value to a name on mount / change.
  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    if (selected?.id === value) return;
    fetch(`/api/users?q=`)
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((b: { users: User[] }) => {
        const found = b.users.find((u) => u.id === value);
        if (found) setSelected(found);
      })
      .catch(() => {});
  }, [value, selected?.id]);

  // Live search as the user types.
  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(query)}`);
        if (!res.ok) {
          setResults([]);
          return;
        }
        const body = (await res.json()) as { users: User[] };
        setResults(body.users.slice(0, 8));
      } catch {
        setResults([]);
      }
    }, 120);
    return () => clearTimeout(handle);
  }, [query, open]);

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <label className="block">
      <FieldLabel>Assignee</FieldLabel>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-md border border-default bg-base px-2 py-2 text-left text-sm"
        >
          {selected ? (
            <span className="truncate">
              {selected.name ?? selected.email}
            </span>
          ) : (
            <span className="text-muted">Unassigned</span>
          )}
          <span className="ml-2 text-muted">▾</span>
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-default bg-base shadow-lg">
            <div className="border-b border-default p-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search teammates…"
                className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm focus:outline-none"
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                onChange(null);
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-muted hover:bg-elevated"
            >
              Unassign
            </button>
            {results.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => {
                  setSelected(u);
                  onChange(u.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 border-t border-default px-3 py-2 text-left text-sm hover:bg-elevated"
              >
                <UserAvatar user={u} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="block truncate font-medium">
                    {u.name ?? u.email.split("@")[0]}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {u.email}
                  </span>
                </span>
              </button>
            ))}
            {results.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted">No matches.</div>
            )}
          </div>
        )}
      </div>
    </label>
  );
}

function CustomerField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [selected, setSelected] = useState<CustomerOption | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve current value once (the list endpoint accepts any id; we match
  // by id from a small page of results).
  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    if (selected?.id === value) return;
    fetch(`/api/customers?customerType=all&limit=20`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((b: { rows: CustomerOption[] }) => {
        const found = b.rows.find((c) => c.id === value);
        if (found) setSelected(found);
      })
      .catch(() => {});
  }, [value, selected?.id]);

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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <label className="block">
      <FieldLabel>Customer</FieldLabel>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-md border border-default bg-base px-2 py-2 text-left text-sm"
        >
          {selected ? (
            <span className="truncate">{selected.displayName}</span>
          ) : (
            <span className="text-muted">No customer linked</span>
          )}
          <span className="ml-2 text-muted">▾</span>
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-default bg-base shadow-lg">
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
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                onChange(null);
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-muted hover:bg-elevated"
            >
              No customer
            </button>
            {results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setSelected(c);
                  onChange(c.id);
                  setOpen(false);
                }}
                className="block w-full border-t border-default px-3 py-2 text-left text-sm hover:bg-elevated"
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
    </label>
  );
}

function TagsField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const t = draft.trim().replace(/^#/, "");
    if (!t) return;
    if (value.includes(t)) {
      setDraft("");
      return;
    }
    onChange([...value, t]);
    setDraft("");
  }
  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }
  return (
    <div>
      <FieldLabel>Tags</FieldLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-xs"
          >
            #{tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              className="rounded p-0.5 text-muted hover:text-accent-danger"
              aria-label={`Remove tag ${tag}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <div className="inline-flex items-center gap-1">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add tag…"
            className="w-28 rounded-md border border-default bg-base px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
          />
          {draft.trim() && (
            <button
              type="button"
              onClick={add}
              className="rounded p-0.5 text-muted hover:bg-elevated hover:text-primary"
              aria-label="Add tag"
            >
              <Plus className="size-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WatchersStack({
  watchers,
  currentUserId,
}: {
  watchers: User[];
  currentUserId: string | null;
}) {
  if (watchers.length === 0) {
    return (
      <div className="text-xs text-muted">No watchers yet.</div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-secondary">Watching:</span>
      <div className="flex -space-x-1">
        {watchers.slice(0, 6).map((w) => (
          <div
            key={w.id}
            className="ring-2 ring-base"
            title={w.name ?? w.email}
          >
            <UserAvatar user={w} highlight={w.id === currentUserId} />
          </div>
        ))}
        {watchers.length > 6 && (
          <div className="flex size-6 items-center justify-center rounded-full bg-elevated text-[10px] text-secondary ring-2 ring-base">
            +{watchers.length - 6}
          </div>
        )}
      </div>
    </div>
  );
}

function UserAvatar({
  user,
  highlight,
}: {
  user: User;
  highlight?: boolean;
}) {
  if (user.image) {
    return (
      <img
        src={user.image}
        alt=""
        className={cn(
          "size-6 rounded-full",
          highlight && "ring-2 ring-accent-primary",
        )}
      />
    );
  }
  const seed = user.name ?? user.email;
  return (
    <div
      className={cn(
        "flex size-6 items-center justify-center rounded-full bg-accent-primary/15 text-[10px] font-medium text-accent-primary",
        highlight && "ring-2 ring-accent-primary",
      )}
    >
      {seed.charAt(0).toUpperCase()}
    </div>
  );
}

// HTML datetime-local wants `YYYY-MM-DDTHH:MM` in local TZ. Convert from
// the API's ISO string for editing, then back via new Date(...).toISOString().
function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
