import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type EmailRow = {
  id: string;
  threadId: string | null;
  subject: string | null;
  snippet: string | null;
  emailDate: string;
  customerId: string;
  customerName: string;
};

function relativeTimeShort(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

export function EmailsWidget() {
  const { data, isPending, isError } = useQuery<{ rows: EmailRow[] }>({
    queryKey: ["dashboard", "emails"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/emails");
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
        <WidgetHeader title="Unactioned emails today" count={rows.length} />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : isError ? (
          <div className="text-xs text-accent-danger">
            Failed to load emails.
          </div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">Inbox zero for today.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((e) => (
              <li key={e.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: e.customerId }}
                  className="block text-sm hover:text-accent-info"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-primary truncate">
                      {e.customerName}
                    </span>
                    <span className="text-xs text-muted shrink-0">
                      {relativeTimeShort(e.emailDate)}
                    </span>
                  </div>
                  <div className="text-xs text-secondary truncate">
                    {e.subject ?? "(no subject)"}
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
