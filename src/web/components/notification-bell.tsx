// Bell badge in the app header. Shows unread count, opens a dropdown
// with the most recent notifications, marks rows read on click +
// supports mark-all-read.
//
// Live updates: subscribes to the `notification.created` SSE event and
// invalidates both the list + count queries on every fire. The list
// query has a short staleTime so the dropdown reflects fresh data when
// reopened, but the count is the load-bearing UI element (the
// dropdown only opens occasionally).
//
// Click-out: handled by a window-level click listener that ignores
// clicks inside the popover. Esc also closes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, AtSign, ListChecks, Clock3, AlertCircle } from "lucide-react";
import { useEventStream } from "../lib/use-event-stream";
import { cn } from "../lib/cn";

type NotificationKind =
  | "customer_email_in"
  | "task_assigned"
  | "task_overdue"
  | "mention"
  | "ai_proposal"
  | "chase_due"
  | "system";

type NotificationRow = {
  id: string;
  kind: NotificationKind;
  customerId: string | null;
  refType: string | null;
  refId: string | null;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
};

type ListResponse = { rows: NotificationRow[] };
type CountResponse = { count: number };

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return `${sec}s ago`;
  if (sec < 90) return "1m ago";
  const min = Math.round(sec / 60);
  if (min < 45) return `${min}m ago`;
  if (min < 90) return "1h ago";
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(d);
}

function getString(payload: Record<string, unknown> | null, key: string): string | null {
  if (!payload) return null;
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Renders a single row's icon + headline + body. Each kind picks a tone
// + icon and reads its own fields out of the JSON payload.
function rowDisplay(n: NotificationRow): {
  icon: React.ReactNode;
  title: string;
  body: string | null;
  href: string | null;
} {
  switch (n.kind) {
    case "task_assigned": {
      const by =
        getString(n.payload, "byUserName") ??
        getString(n.payload, "byUserEmail") ??
        "Someone";
      const taskTitle = getString(n.payload, "taskTitle") ?? "(untitled task)";
      return {
        icon: <ListChecks className="size-4 text-accent-info" />,
        title: `${by} assigned you a task`,
        body: taskTitle,
        href: n.refId ? "/tasks" : null,
      };
    }
    case "task_overdue": {
      const taskTitle = getString(n.payload, "taskTitle") ?? "(untitled task)";
      const due = getString(n.payload, "dueAt");
      return {
        icon: <Clock3 className="size-4 text-accent-warning" />,
        title: "Task overdue",
        body: due ? `${taskTitle} — due ${relativeTime(due)}` : taskTitle,
        href: "/tasks",
      };
    }
    case "mention": {
      const by =
        getString(n.payload, "byUserName") ??
        getString(n.payload, "byUserEmail") ??
        "Someone";
      const excerpt = getString(n.payload, "excerpt") ?? "";
      return {
        icon: <AtSign className="size-4 text-accent-primary" />,
        title: `${by} mentioned you`,
        body: excerpt,
        // Mentions on a task open the tasks page; other parent types
        // (when added) get their own deep-link.
        href: n.refType === "task" ? "/tasks" : null,
      };
    }
    default: {
      const title = getString(n.payload, "title") ?? n.kind.replace(/_/g, " ");
      const body = getString(n.payload, "body");
      return {
        icon: <AlertCircle className="size-4 text-muted" />,
        title,
        body,
        href: null,
      };
    }
  }
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();

  const { data: countData } = useQuery<CountResponse>({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/unread-count");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
  const unread = countData?.count ?? 0;

  const { data: listData } = useQuery<ListResponse>({
    queryKey: ["notifications", "list"],
    queryFn: async () => {
      const res = await fetch("/api/notifications?filter=all&limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 15_000,
    enabled: open,
  });
  const rows = listData?.rows ?? [];

  const markRead = useMutation<void, Error, string | undefined>({
    mutationFn: async (id) => {
      const res = await fetch("/api/notifications/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(id ? { id } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  // Live updates — every notification.created from the SSE stream busts
  // both queries.
  useEventStream("notification.created", () => {
    queryClient.invalidateQueries({
      queryKey: ["notifications", "unread-count"],
    });
    queryClient.invalidateQueries({ queryKey: ["notifications", "list"] });
  });

  // Click-out + Esc to close.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = useMemo(() => {
    return rows.map((r) => ({ row: r, ...rowDisplay(r) }));
  }, [rows]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-secondary hover:bg-elevated hover:text-primary"
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute right-1 top-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-accent-danger px-1 text-[10px] font-semibold leading-4 text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className="absolute right-0 z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-default bg-base shadow-2xl ring-1 ring-black/5"
        >
          <div className="flex items-center justify-between border-b border-default px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            <button
              type="button"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate(undefined)}
              className={cn(
                "text-xs",
                unread === 0
                  ? "cursor-default text-muted"
                  : "text-accent-primary hover:underline",
              )}
            >
              Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-8 text-xs text-muted">
                <Bell className="size-5 opacity-50" />
                <div>No notifications</div>
              </div>
            ) : (
              <ul>
                {items.map(({ row, icon, title, body, href }) => {
                  const inner = (
                    <div
                      className={cn(
                        "flex items-start gap-3 border-b border-default px-3 py-2 text-sm last:border-0",
                        row.readAt ? "bg-base" : "bg-accent-primary/5",
                      )}
                    >
                      <div className="mt-0.5">{icon}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-primary">{title}</div>
                        {body ? (
                          <div className="truncate text-xs text-secondary">
                            {body}
                          </div>
                        ) : null}
                        <div className="mt-0.5 text-[10px] text-muted">
                          {relativeTime(row.createdAt)}
                        </div>
                      </div>
                      {!row.readAt ? (
                        <span
                          className="mt-1 size-1.5 shrink-0 rounded-full bg-accent-primary"
                          aria-label="Unread"
                        />
                      ) : null}
                    </div>
                  );
                  return (
                    <li key={row.id}>
                      {href ? (
                        <Link
                          to={href}
                          onClick={() => {
                            if (!row.readAt) markRead.mutate(row.id);
                            setOpen(false);
                          }}
                          className="block hover:bg-elevated"
                        >
                          {inner}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (!row.readAt) markRead.mutate(row.id);
                          }}
                          className="block w-full text-left hover:bg-elevated"
                        >
                          {inner}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
