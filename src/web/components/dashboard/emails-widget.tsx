import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Button } from "../ui/button";
import { WidgetHeader } from "./widget-header";
import { CustomerPickerDialog } from "./customer-picker-dialog";

type LinkedRow = {
  id: string;
  threadId: string | null;
  subject: string | null;
  snippet: string | null;
  emailDate: string;
  customerId: string;
  customerName: string;
};

type UnlinkedRow = {
  id: string;
  threadId: string | null;
  subject: string | null;
  snippet: string | null;
  emailDate: string;
  fromAddress: string | null;
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
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState<UnlinkedRow | null>(null);

  const linkedQuery = useQuery<{ rows: LinkedRow[] }>({
    queryKey: ["dashboard", "emails"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/emails");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const unlinkedQuery = useQuery<{ rows: UnlinkedRow[] }>({
    queryKey: ["dashboard", "emails", "unlinked"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/emails/unlinked");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const linkMutation = useMutation({
    mutationFn: async (args: {
      emailId: string;
      customerId: string;
      rememberAddress: boolean;
    }) => {
      const res = await fetch(
        `/api/dashboard/emails/${encodeURIComponent(args.emailId)}/link-to-customer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customerId: args.customerId,
            rememberAddress: args.rememberAddress,
          }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", "emails"] });
      queryClient.invalidateQueries({
        queryKey: ["dashboard", "emails", "unlinked"],
      });
      setLinking(null);
    },
  });

  // Dismiss = mark actionedAt via the existing per-customer-inbox endpoint
  // (PATCH /api/email-log/:id { actioned: true }). Optimistic remove so the
  // row vanishes immediately; the dashboard /emails filter already excludes
  // actioned rows so the next refetch confirms.
  const dismissMutation = useMutation({
    mutationFn: async (emailId: string) => {
      const res = await fetch(
        `/api/email-log/${encodeURIComponent(emailId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actioned: true }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onMutate: async (emailId: string) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard", "emails"] });
      await queryClient.cancelQueries({
        queryKey: ["dashboard", "emails", "unlinked"],
      });
      const prevLinked = queryClient.getQueryData<{ rows: LinkedRow[] }>([
        "dashboard",
        "emails",
      ]);
      const prevUnlinked = queryClient.getQueryData<{ rows: UnlinkedRow[] }>([
        "dashboard",
        "emails",
        "unlinked",
      ]);
      if (prevLinked) {
        queryClient.setQueryData(["dashboard", "emails"], {
          rows: prevLinked.rows.filter((r) => r.id !== emailId),
        });
      }
      if (prevUnlinked) {
        queryClient.setQueryData(["dashboard", "emails", "unlinked"], {
          rows: prevUnlinked.rows.filter((r) => r.id !== emailId),
        });
      }
      return { prevLinked, prevUnlinked };
    },
    onError: (_err, _emailId, ctx) => {
      if (ctx?.prevLinked) {
        queryClient.setQueryData(["dashboard", "emails"], ctx.prevLinked);
      }
      if (ctx?.prevUnlinked) {
        queryClient.setQueryData(
          ["dashboard", "emails", "unlinked"],
          ctx.prevUnlinked,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", "emails"] });
      queryClient.invalidateQueries({
        queryKey: ["dashboard", "emails", "unlinked"],
      });
    },
  });

  const linked = linkedQuery.data?.rows ?? [];
  const unlinked = unlinkedQuery.data?.rows ?? [];
  const total = linked.length + unlinked.length;

  return (
    <Card>
      <CardHeader>
        <WidgetHeader
          title="Unactioned emails today"
          count={total}
        />
      </CardHeader>
      <CardBody>
        {linkedQuery.isPending && unlinkedQuery.isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : linkedQuery.isError ? (
          <div className="text-xs text-accent-danger">
            Failed to load emails.
          </div>
        ) : total === 0 ? (
          <div className="text-xs text-muted">Inbox zero for today.</div>
        ) : (
          <div className="space-y-3">
            {linked.length > 0 && (
              <ul className="divide-y divide-default">
                {linked.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start gap-2 py-2 first:pt-0"
                  >
                    <Link
                      to="/customers/$customerId"
                      params={{ customerId: e.customerId }}
                      className="flex-1 min-w-0 text-sm hover:text-accent-info"
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
                    <Link
                      to="/customers/$customerId"
                      params={{ customerId: e.customerId }}
                      search={{ draftReplyFor: e.id }}
                      className="inline-flex items-center gap-1 rounded-md border border-default bg-base px-2 py-1 text-xs hover:bg-elevated"
                      title="Open compose with AI draft panel for this email"
                    >
                      <Sparkles className="size-3" />
                      Draft reply
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => dismissMutation.mutate(e.id)}
                      disabled={dismissMutation.isPending}
                      title="Dismiss (mark actioned)"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {unlinked.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">
                  Unlinked ({unlinked.length})
                </div>
                <ul className="divide-y divide-default">
                  {unlinked.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center gap-1 py-2 first:pt-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-primary truncate">
                            {e.fromAddress ?? "(no address)"}
                          </span>
                          <span className="text-xs text-muted shrink-0">
                            {relativeTimeShort(e.emailDate)}
                          </span>
                        </div>
                        <div className="text-xs text-secondary truncate">
                          {e.subject ?? "(no subject)"}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setLinking(e)}
                      >
                        Link
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => dismissMutation.mutate(e.id)}
                        disabled={dismissMutation.isPending}
                        title="Dismiss (mark actioned)"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardBody>

      {linking && (
        <CustomerPickerDialog
          open
          onOpenChange={(o) => !o && setLinking(null)}
          fromAddress={linking.fromAddress}
          saving={linkMutation.isPending}
          onSelect={async (customerId, rememberAddress) => {
            await linkMutation.mutateAsync({
              emailId: linking.id,
              customerId,
              rememberAddress,
            });
          }}
        />
      )}
    </Card>
  );
}
