import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Mail,
  CheckCircle2,
  ListChecks,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Card, CardBody } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useEventStream } from "../lib/use-event-stream";
import { cn } from "../lib/cn";

export type EmailLogRow = {
  id: string;
  gmailMessageId: string;
  threadId: string | null;
  customerId: string | null;
  userId: string | null;
  direction: "inbound" | "outbound";
  aliasUsed: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
  classification: string | null;
  emailDate: string;
  actionedAt: string | null;
  actionedByUserId: string | null;
  createdAt: string;
};

type ListResponse = { rows: EmailLogRow[] };
type DirectionFilter = "all" | "inbound" | "outbound";
type ActionedFilter = "open" | "done" | "all";

export function EmailList({ customerId }: { customerId: string }) {
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [actioned, setActioned] = useState<ActionedFilter>("open");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const queryKey = useMemo(
    () => ["customer-emails", customerId, { direction, actioned }] as const,
    [customerId, direction, actioned],
  );

  const { data, isPending, isError, error } = useQuery<ListResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ direction, actioned });
      const res = await fetch(
        `/api/customers/${customerId}/emails?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // Live-refresh when a new email_in activity lands for this customer.
  // The activity-ingester emits this when the Gmail poller writes a new
  // email_log row.
  useEventStream("activity.created", (event) => {
    if (event.customerId !== customerId) return;
    if (event.kind !== "email_in" && event.kind !== "email_out") return;
    queryClient.invalidateQueries({ queryKey });
  });

  const actionMutation = useMutation({
    mutationFn: async (input: { id: string; actioned: boolean }) => {
      const res = await fetch(`/api/email-log/${input.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actioned: input.actioned }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const toTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/email-log/${id}/to-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ taskId: string }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  // Per-customer Gmail backfill. The worker only pulls deltas from the
  // global cursor; this lets the user grab historical email for a
  // specific customer without waiting for the cursor to catch up.
  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/customers/${customerId}/sync-emails`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxResults: 1000 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        fetched: number;
        inserted: number;
        activitiesCreated: number;
        emails: string[];
      }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
    },
  });

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <FilterChips
          label="Show"
          value={actioned}
          options={[
            { key: "open", label: "Open" },
            { key: "done", label: "Actioned" },
            { key: "all", label: "All" },
          ]}
          onChange={(v) => setActioned(v as ActionedFilter)}
        />
        <FilterChips
          label="Direction"
          value={direction}
          options={[
            { key: "all", label: "All" },
            { key: "inbound", label: "Inbound" },
            { key: "outbound", label: "Outbound" },
          ]}
          onChange={(v) => setDirection(v as DirectionFilter)}
        />
        <div className="ml-auto flex items-center gap-2">
          {backfillMutation.data && (
            <span className="text-muted">
              Pulled {backfillMutation.data.inserted} new
              {backfillMutation.data.fetched > backfillMutation.data.inserted
                ? ` (${backfillMutation.data.fetched - backfillMutation.data.inserted} duplicates)`
                : ""}
            </span>
          )}
          {backfillMutation.isError && (
            <span className="text-accent-danger">
              {(backfillMutation.error as Error)?.message ?? "Sync failed"}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            title="Pull this customer's email history from Gmail (may take 10-30 seconds)"
          >
            {backfillMutation.isPending
              ? "Pulling history…"
              : "Pull email history"}
          </Button>
        </div>
      </div>

      {isError && (
        <Card>
          <CardBody className="py-4 text-sm text-accent-danger">
            {(error as Error)?.message ?? "Failed to load emails"}
          </CardBody>
        </Card>
      )}

      {isPending && (
        <Card>
          <CardBody className="py-6 text-center text-sm text-muted">
            Loading emails…
          </CardBody>
        </Card>
      )}

      {!isPending && rows.length === 0 && (
        <Card>
          <CardBody className="py-8 text-center text-sm text-muted">
            <Mail className="mx-auto mb-2 size-6 text-muted/60" />
            No {actioned === "open" ? "open " : actioned === "done" ? "actioned " : ""}
            emails yet. New mail from this customer's billing addresses will
            appear here when the next Gmail poll runs.
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="p-0">
          <ul className="divide-y divide-default">
            {rows.map((email) => {
              const isExpanded = expanded.has(email.id);
              const isInbound = email.direction === "inbound";
              const isActioned = Boolean(email.actionedAt);
              return (
                <li
                  key={email.id}
                  className={cn(
                    "px-4 py-3 text-sm",
                    isActioned && "opacity-60",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={isActioned}
                      onChange={() =>
                        actionMutation.mutate({
                          id: email.id,
                          actioned: !isActioned,
                        })
                      }
                      disabled={actionMutation.isPending}
                      className="mt-1.5 size-4 shrink-0 rounded border-default"
                      aria-label={
                        isActioned
                          ? "Mark as unactioned"
                          : "Mark as actioned"
                      }
                      title={
                        isActioned
                          ? "Mark as unactioned"
                          : "Mark as actioned"
                      }
                    />
                    <div
                      className={cn(
                        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                        isInbound
                          ? "bg-accent-info/10 text-accent-info"
                          : "bg-elevated text-secondary",
                      )}
                    >
                      {isInbound ? (
                        <ArrowDownLeft className="size-3.5" />
                      ) : (
                        <ArrowUpRight className="size-3.5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => toggleExpand(email.id)}
                          className="min-w-0 flex-1 truncate text-left font-medium hover:text-accent-primary"
                        >
                          <span className="mr-1 inline-block align-middle text-muted">
                            {isExpanded ? (
                              <ChevronDown className="inline size-3" />
                            ) : (
                              <ChevronRight className="inline size-3" />
                            )}
                          </span>
                          {email.subject ?? "(no subject)"}
                        </button>
                        <span className="shrink-0 text-xs text-muted">
                          {formatTime(email.emailDate)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-secondary">
                        <Badge tone={isInbound ? "info" : "neutral"}>
                          {isInbound ? "Inbound" : "Outbound"}
                        </Badge>
                        {isActioned && (
                          <Badge tone="success">
                            <Check className="mr-1 size-3" />
                            Actioned
                          </Badge>
                        )}
                        {isInbound && email.fromAddress && (
                          <span className="truncate text-muted">
                            from {email.fromAddress}
                          </span>
                        )}
                        {!isInbound && email.toAddress && (
                          <span className="truncate text-muted">
                            to {email.toAddress.split(",")[0]}
                          </span>
                        )}
                      </div>
                      {!isExpanded && email.snippet && (
                        <p className="mt-1 line-clamp-1 text-xs text-muted">
                          {email.snippet}
                        </p>
                      )}
                      {isExpanded && email.body && (
                        <div className="mt-2 whitespace-pre-wrap rounded-md border border-default bg-subtle p-3 text-xs text-secondary">
                          {email.body}
                        </div>
                      )}
                      {isExpanded && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              actionMutation.mutate({
                                id: email.id,
                                actioned: !isActioned,
                              })
                            }
                            disabled={actionMutation.isPending}
                          >
                            {isActioned ? (
                              <>
                                <CheckCircle2 className="size-3.5" />
                                Mark unactioned
                              </>
                            ) : (
                              <>
                                <Check className="size-3.5" />
                                Mark actioned
                              </>
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => toTaskMutation.mutate(email.id)}
                            disabled={toTaskMutation.isPending}
                          >
                            <ListChecks className="size-3.5" />
                            Turn into task
                          </Button>
                          <Button variant="ghost" size="sm" disabled>
                            Reply (week 7)
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted">{label}:</span>
      <div className="inline-flex rounded-md border border-default bg-subtle p-0.5">
        {options.map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            className={cn(
              "rounded px-2.5 py-1 transition-colors",
              value === opt.key
                ? "bg-base font-medium text-primary shadow-sm"
                : "text-secondary hover:text-primary",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
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
