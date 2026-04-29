import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, Check, X } from "lucide-react";
import { Button } from "./ui/button";
import { MentionInput, MentionText, type MentionInputHandle } from "./mention-input";
import { cn } from "../lib/cn";

export type Comment = {
  id: string;
  parentType: string;
  parentId: string;
  userId: string;
  body: string;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
};

export function CommentsThread({
  taskId,
  comments,
  currentUserId,
  taskQueryKey,
}: {
  taskId: string;
  comments: Comment[];
  currentUserId: string | null;
  // Query key for the task detail query; new/updated/deleted comments
  // invalidate it so the parent refetches.
  taskQueryKey: readonly unknown[];
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<MentionInputHandle>(null);
  const queryClient = useQueryClient();

  const addMutation = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: taskQueryKey });
    },
  });

  function submit() {
    const body = draft.trim();
    if (!body || addMutation.isPending) return;
    addMutation.mutate(body);
  }

  // Sorted oldest-first so the conversation reads top-to-bottom and the
  // reply form is at the bottom under the latest message.
  const sorted = [...comments].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return (
    <div className="space-y-3">
      {sorted.length === 0 && (
        <p className="rounded-md border border-default bg-subtle px-3 py-4 text-center text-xs text-muted">
          No comments yet. Be the first to leave one — type @ to mention a
          teammate.
        </p>
      )}

      <ul className="space-y-3">
        {sorted.map((c) => (
          <li key={c.id}>
            <CommentRow
              comment={c}
              currentUserId={currentUserId}
              taskQueryKey={taskQueryKey}
            />
          </li>
        ))}
      </ul>

      <div className="space-y-2 border-t border-default pt-3">
        <MentionInput
          ref={inputRef}
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          rows={3}
          placeholder="Add a comment… type @ to mention someone"
        />
        {addMutation.isError && (
          <p className="text-xs text-accent-danger">
            {(addMutation.error as Error).message}
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">
            ⌘+Enter to send. Use @ to mention a teammate.
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={!draft.trim() || addMutation.isPending}
          >
            {addMutation.isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  currentUserId,
  taskQueryKey,
}: {
  comment: Comment;
  currentUserId: string | null;
  taskQueryKey: readonly unknown[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const queryClient = useQueryClient();
  const isOwn = currentUserId !== null && comment.userId === currentUserId;

  const editMutation = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: taskQueryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/comments/${comment.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskQueryKey });
    },
  });

  const displayName =
    comment.user?.name ?? comment.user?.email.split("@")[0] ?? "Someone";

  return (
    <div className="flex gap-3">
      <CommentAvatar user={comment.user} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="font-medium">{displayName}</span>
            <span className="text-xs text-muted">
              {formatTime(comment.createdAt)}
              {comment.editedAt ? " (edited)" : ""}
            </span>
          </div>
          {isOwn && !editing && (
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(true);
                }}
                className="rounded p-1 text-muted hover:bg-elevated hover:text-primary"
                aria-label="Edit comment"
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm("Delete this comment?")) deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending}
                className="rounded p-1 text-muted hover:bg-elevated hover:text-accent-danger"
                aria-label="Delete comment"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          )}
        </div>
        {editing ? (
          <div className="mt-1 space-y-2">
            <MentionInput
              value={draft}
              onChange={setDraft}
              onSubmit={() => editMutation.mutate(draft.trim())}
              rows={3}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setDraft(comment.body);
                }}
              >
                <X className="size-3" />
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!draft.trim() || editMutation.isPending}
                onClick={() => editMutation.mutate(draft.trim())}
              >
                <Check className="size-3" />
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className={cn(
            "mt-1 whitespace-pre-wrap rounded-md bg-subtle px-3 py-2 text-sm text-primary",
            "group-hover:bg-elevated/80",
          )}>
            <MentionText body={comment.body} />
          </div>
        )}
      </div>
    </div>
  );
}

function CommentAvatar({
  user,
}: {
  user: Comment["user"] | undefined;
}) {
  if (user?.image) {
    return (
      <img
        src={user.image}
        alt=""
        className="size-8 shrink-0 rounded-full"
      />
    );
  }
  const seed = user?.name ?? user?.email ?? "?";
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-primary/15 text-xs font-medium text-accent-primary">
      {seed.charAt(0).toUpperCase()}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: diffDay > 365 ? "numeric" : undefined,
  });
}
