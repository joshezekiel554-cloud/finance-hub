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
  const [dueAt, setDueAt] = useState("");
  const [reminderAt, setReminderAt] = useState("");

  // Reset the form whenever the dialog opens fresh.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setOwnerId("");
    setDueAt("");
    setReminderAt("");
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
          financeCustomerId: customer ? customer.id : undefined,
          dueAt: localToIso(dueAt),
          reminderAt: localToIso(reminderAt),
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
  const canSubmit = title.trim().length > 0 && !createMutation.isPending;

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
          className="grid gap-3"
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
            maxLength={512}
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
