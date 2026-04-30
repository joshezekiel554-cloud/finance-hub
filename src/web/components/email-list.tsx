import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckSquare,
  Mail,
  CheckCircle2,
  ListChecks,
  ChevronRight,
  ChevronDown,
  Reply,
  X,
} from "lucide-react";
import { Card, CardBody } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import ComposeModal, { type ComposeContext } from "./compose-modal";
import { useEventStream } from "../lib/use-event-stream";
import { cn } from "../lib/cn";

export type EmailLogRow = {
  id: string;
  gmailMessageId: string;
  threadId: string | null;
  messageIdHeader: string | null;
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

export function EmailList({
  customerId,
  customerName,
  customerEmail,
}: {
  customerId: string;
  customerName?: string;
  customerEmail?: string | null;
}) {
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [actioned, setActioned] = useState<ActionedFilter>("open");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Bulk-action selection. Independent of the per-row "actioned" toggle
  // — selection is which rows the next bulk action applies to. Cleared
  // when filters change (since rows might leave the visible set).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Single modal instance reused across rows. Keying by the email row's
  // identity (rather than mounting one modal per row) keeps state clean
  // when the user bounces between replies without closing the drawer.
  const [composeContext, setComposeContext] =
    useState<ComposeContext | null>(null);
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

  const bulkActionMutation = useMutation<
    { updated: number; missing: number },
    Error,
    { ids: string[]; actioned: boolean }
  >({
    mutationFn: async (input) => {
      const res = await fetch(`/api/email-log/mark-actioned-bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setSelectedIds(new Set());
    },
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

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const rows = data?.rows ?? [];

  // When the visible set of rows changes (filter flipped, refetch
  // brought new ids), drop selections that aren't visible anymore so
  // the toolbar count stays honest.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(rows.map((r) => r.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const someVisibleSelected = rows.some((r) => selectedIds.has(r.id));

  function selectAllVisible() {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  }

  function bulkMarkActioned(actioned: boolean) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkActionMutation.mutate({ ids, actioned });
  }

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

      <ComposeModal
        open={composeContext !== null}
        onOpenChange={(next) => {
          if (!next) setComposeContext(null);
        }}
        context={composeContext ?? undefined}
      />

      {!isPending && rows.length > 0 ? (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-2 py-2 text-xs">
            <label className="inline-flex cursor-pointer select-none items-center gap-2">
              <input
                type="checkbox"
                aria-label="Select all visible"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      someVisibleSelected && !allVisibleSelected;
                }}
                onChange={selectAllVisible}
                className="size-3.5 rounded border-default"
              />
              <span className="text-secondary">
                {selectedIds.size > 0
                  ? `${selectedIds.size} selected`
                  : `Select all (${rows.length})`}
              </span>
            </label>
            {selectedIds.size > 0 ? (
              <>
                <span className="text-muted">·</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => bulkMarkActioned(true)}
                  disabled={bulkActionMutation.isPending}
                >
                  <CheckSquare className="size-3.5" />
                  Mark actioned
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => bulkMarkActioned(false)}
                  disabled={bulkActionMutation.isPending}
                >
                  <Mail className="size-3.5" />
                  Mark unactioned
                </Button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="inline-flex items-center gap-1 text-muted hover:text-primary"
                >
                  <X className="size-3" /> Clear
                </button>
              </>
            ) : null}
            {bulkActionMutation.isError ? (
              <span className="text-accent-danger">
                {(bulkActionMutation.error as Error)?.message ?? "Bulk update failed"}
              </span>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

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
                    selectedIds.has(email.id) && "bg-accent-primary/5",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      aria-label={`Select email "${email.subject ?? "(no subject)"}"`}
                      checked={selectedIds.has(email.id)}
                      onChange={() => toggleSelect(email.id)}
                      className="mt-2 size-3.5 shrink-0 rounded border-default"
                    />
                    <label
                      className={cn(
                        "mt-0.5 inline-flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                        isActioned
                          ? "border-accent-success/40 bg-accent-success/10 text-accent-success"
                          : "border-default bg-base text-secondary hover:border-strong hover:text-primary",
                        actionMutation.isPending && "opacity-60",
                      )}
                      title={
                        isActioned ? "Click to un-action" : "Click to mark as actioned"
                      }
                    >
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
                        className="size-3.5 rounded border-default"
                      />
                      {isActioned ? "Actioned" : "Mark as actioned"}
                    </label>
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
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              setComposeContext({
                                customerId,
                                customerName,
                                customerEmail: customerEmail ?? undefined,
                                inReplyTo: {
                                  // Prefer the RFC 5322 Message-ID header
                                  // so non-Gmail recipients see a proper
                                  // In-Reply-To. Fall back to the Gmail
                                  // API messageId for legacy rows that
                                  // pre-date header capture (still
                                  // threads via Gmail's threadId).
                                  messageId:
                                    email.messageIdHeader ?? email.gmailMessageId,
                                  threadId: email.threadId ?? "",
                                  subject: email.subject ?? "",
                                  from:
                                    email.fromAddress ??
                                    customerEmail ??
                                    "",
                                  bodyExcerpt: email.body
                                    ? email.body.slice(0, 1000)
                                    : "",
                                },
                              })
                            }
                          >
                            <Reply className="size-3.5" />
                            Reply
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
