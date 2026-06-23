// New SHARED task dialog (M2). Creates a task in the inbox canonical store via
// `POST /api/tasks/shared`; the task lands live on the assignee's inbox board.
// This is DISTINCT from the finance-native Kanban "New task" (TaskDetailDrawer)
// — that writes the local tasks table; this writes inbox.
//
// Fields: title (required), body, assignee (members picker, default unassigned),
// due date, reminder date. When opened from a customer page the dialog is given
// a `customer` → its id is sent as `financeCustomerId` and shown locked (read-
// only chip) so the operator can't accidentally re-link it elsewhere.
//
// On success: close, invalidate the "My tasks" widget query, and fire onCreated.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

type Member = { teamMemberId: string; name: string };
type MembersResponse = { members: Member[] };

// Recurrence enums — mirror the inbox contract verbatim.
type RecurrenceKind =
  | "NONE"
  | "DAILY"
  | "WEEKDAYS"
  | "WEEKLY"
  | "MONTHLY"
  | "CUSTOM";
type RecurrenceUnit = "DAY" | "WEEK" | "MONTH";

type CreatedTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  financeCustomerId: string | null;
  ownerId: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // When present, the task is linked to this customer and the link is locked.
  customer?: { id: string; name: string };
  onCreated?: (task: CreatedTask) => void;
};

// A local <input type="datetime-local"> value is wall-clock with no zone; the
// API wants ISO-8601 with offset. Convert via Date (interprets as local) →
// toISOString (UTC). Empty → null.
function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function NewTaskDialog({
  open,
  onOpenChange,
  customer,
  onCreated,
}: Props) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ownerId, setOwnerId] = useState<string>(""); // "" = unassigned
  const [priority, setPriority] = useState<string>("normal");
  const [dueAt, setDueAt] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  // Watchers EXCLUDE the owner — member ids of teammates quietly subscribed.
  const [watcherIds, setWatcherIds] = useState<string[]>([]);
  // Recurrence — inbox enum. "NONE" = one-off. CUSTOM reveals interval + unit.
  const [recurrenceKind, setRecurrenceKind] =
    useState<RecurrenceKind>("NONE");
  const [recurrenceInterval, setRecurrenceInterval] = useState<string>("1");
  const [recurrenceUnit, setRecurrenceUnit] =
    useState<RecurrenceUnit>("WEEK");

  // Reset the form whenever the dialog opens fresh.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setOwnerId("");
    setPriority("normal");
    setDueAt("");
    setReminderAt("");
    setWatcherIds([]);
    setRecurrenceKind("NONE");
    setRecurrenceInterval("1");
    setRecurrenceUnit("WEEK");
    createMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const membersQuery = useQuery<MembersResponse>({
    queryKey: ["tasks", "members"],
    queryFn: async () => {
      const res = await fetch("/api/tasks/members");
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: open,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const createMutation = useMutation<CreatedTask, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/tasks/shared", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim() ? body.trim() : undefined,
          ownerId: ownerId ? ownerId : null,
          priority,
          financeCustomerId: customer ? customer.id : undefined,
          dueAt: localToIso(dueAt),
          reminderAt: localToIso(reminderAt),
          // Omit watchers when none picked. The owner is never a watcher (the
          // picker already excludes them).
          ...(watcherIds.length > 0 ? { watcherIds } : {}),
          // Omit recurrence when one-off; only send interval/unit for CUSTOM.
          ...(recurrenceKind !== "NONE" ? { recurrenceKind } : {}),
          ...(recurrenceKind === "CUSTOM"
            ? {
                recurrenceInterval:
                  Number.parseInt(recurrenceInterval, 10) || 1,
                recurrenceUnit,
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { task: CreatedTask };
      return json.task;
    },
    onSuccess: (task) => {
      // The "My tasks" dashboard widget reads this key.
      queryClient.invalidateQueries({ queryKey: ["dashboard", "my-tasks"] });
      onCreated?.(task);
      onOpenChange(false);
    },
  });

  const members = membersQuery.data?.members ?? [];
  // Watcher candidates exclude whoever is the selected owner.
  const watcherCandidates = members.filter(
    (m) => m.teamMemberId !== ownerId,
  );

  const isRecurring = recurrenceKind !== "NONE";
  // A repeating task needs an anchor date — enforce in the UI (server enforces
  // too via the schema refine).
  const recurringNeedsDue = isRecurring && !dueAt;

  function toggleWatcher(id: string) {
    setWatcherIds((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id],
    );
  }

  // When the owner changes, drop them from the watcher set so the two never
  // overlap (watchers EXCLUDE the owner).
  useEffect(() => {
    if (!ownerId) return;
    setWatcherIds((prev) => prev.filter((w) => w !== ownerId));
  }, [ownerId]);

  const canSubmit =
    title.trim().length > 0 &&
    !recurringNeedsDue &&
    !createMutation.isPending;

  // Distinguish "you have no inbox account" from a transient failure.
  const errMsg = createMutation.error?.message;
  const noInboxAccount = errMsg === "no_inbox_account";
  const errorText = createMutation.isError
    ? noInboxAccount
      ? "You don't have an inbox account yet — ask an admin to add you in inbox → Members."
      : errMsg === "inbox_unreachable" || errMsg === "inbox_error"
        ? "Tasks service is temporarily unavailable. Try again in a moment."
        : "Couldn't create the task. Try again."
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New shared task</DialogTitle>
          <DialogDescription>
            Creates a task on the shared board. Assign it to a teammate or leave
            it unassigned.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid max-h-[70vh] gap-3 overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) createMutation.mutate();
          }}
        >
          <Input
            autoFocus
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            maxLength={300}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="new-task-body"
              className="text-sm font-medium text-primary"
            >
              Details <span className="text-muted">(optional)</span>
            </label>
            <textarea
              id="new-task-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Add any context…"
              rows={3}
              maxLength={10_000}
              className="rounded-md border border-default bg-base px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-strong focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
            />
          </div>

          <Select
            label="Assign to"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            disabled={membersQuery.isPending || membersQuery.isError}
            helperText={
              membersQuery.isError
                ? "Couldn't load teammates — task can still be created unassigned."
                : undefined
            }
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.teamMemberId} value={m.teamMemberId}>
                {m.name}
              </option>
            ))}
          </Select>

          <Select
            label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>

          <div className="grid grid-cols-2 gap-3">
            <Input
              type="datetime-local"
              label="Due"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
            <Input
              type="datetime-local"
              label="Reminder"
              value={reminderAt}
              onChange={(e) => setReminderAt(e.target.value)}
            />
          </div>

          {/* Repeat (recurrence). CUSTOM reveals interval + unit. */}
          <Select
            label="Repeat"
            value={recurrenceKind}
            onChange={(e) =>
              setRecurrenceKind(e.target.value as RecurrenceKind)
            }
            error={
              recurringNeedsDue ? "Repeating tasks need a due date." : undefined
            }
          >
            <option value="NONE">Never</option>
            <option value="DAILY">Daily</option>
            <option value="WEEKDAYS">Weekdays</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="CUSTOM">Custom…</option>
          </Select>

          {recurrenceKind === "CUSTOM" ? (
            <div className="grid grid-cols-2 gap-3">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                label="Every"
                value={recurrenceInterval}
                onChange={(e) => setRecurrenceInterval(e.target.value)}
              />
              <Select
                label="Unit"
                value={recurrenceUnit}
                onChange={(e) =>
                  setRecurrenceUnit(e.target.value as RecurrenceUnit)
                }
              >
                <option value="DAY">Day(s)</option>
                <option value="WEEK">Week(s)</option>
                <option value="MONTH">Month(s)</option>
              </Select>
            </div>
          ) : null}

          {/* Watchers — multi-select checkbox list. Excludes the owner. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-primary">
              Watchers <span className="text-muted">(optional)</span>
            </span>
            {watcherCandidates.length === 0 ? (
              <p className="text-xs text-muted">
                {membersQuery.isError
                  ? "Couldn't load teammates."
                  : ownerId && members.length === 1
                    ? "No other teammates to add as watchers."
                    : "No teammates available."}
              </p>
            ) : (
              <div className="max-h-32 overflow-y-auto rounded-md border border-default bg-base p-2">
                {watcherCandidates.map((m) => {
                  const checked = watcherIds.includes(m.teamMemberId);
                  return (
                    <label
                      key={m.teamMemberId}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-primary hover:bg-subtle"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleWatcher(m.teamMemberId)}
                        className="size-4 rounded border-default accent-accent-primary"
                      />
                      <span>{m.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {customer ? (
            <div className="flex items-center gap-2 text-xs text-secondary">
              <span className="text-muted">Linked to</span>
              <span className="rounded bg-subtle px-2 py-0.5 font-medium text-primary">
                {customer.name}
              </span>
            </div>
          ) : null}

          {errorText ? (
            <p className="text-xs text-accent-danger">{errorText}</p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} loading={createMutation.isPending}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
