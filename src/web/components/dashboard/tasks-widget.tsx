import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type TaskRow = {
  id: string;
  title: string;
  dueAt: string | null;
  status: string;
  priority: string;
  customerId: string | null;
  customerName: string | null;
};

function relativeDueDate(iso: string | null): string {
  if (!iso) return "No due date";
  const due = new Date(iso);
  const now = Date.now();
  const diffDays = Math.floor((due.getTime() - now) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return `${-diffDays}d overdue`;
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return `In ${diffDays}d`;
}

export function TasksWidget() {
  const { data, isPending, isError } = useQuery<{ rows: TaskRow[] }>({
    queryKey: ["dashboard", "tasks"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader
          title="My open tasks"
          count={rows.length}
          link="/tasks"
        />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load tasks.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">No open tasks.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((t) => (
              <li key={t.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/tasks"
                  className="block text-sm hover:text-accent-info"
                >
                  <div className="font-medium text-primary truncate">
                    {t.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span>{relativeDueDate(t.dueAt)}</span>
                    {t.customerName && <span>· {t.customerName}</span>}
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
