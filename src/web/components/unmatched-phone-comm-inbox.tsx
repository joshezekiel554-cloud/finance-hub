// Unmatched calls & SMS inbox panel. Renders on the Today tab so the
// operator can triage phone communications whose `customer_id` came
// back NULL from the matcher (number not in our roster, mistyped, or
// new lead). Each row exposes:
//   - "Match to customer" → opens a customer-picker typeahead; on pick,
//     POSTs /api/vocatech/communications/:id/match. Re-runs the matcher
//     server-side to keep phoneLabelMatched honest (null if the operator
//     overrides the matcher's verdict).
//   - "Ignore" → POSTs /api/vocatech/communications/:id/dismiss which
//     stamps dismissed_at + dismissed_by_user_id. The row drops off the
//     inbox query but is preserved for audit.
//
// Refresh: 60s polling + a phone-communication.received SSE subscriber
// so brand-new unmatched rows pop in without needing a poll wait.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneIncoming, PhoneOutgoing, MessageSquare, X, Check } from "lucide-react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useEventStream } from "../lib/use-event-stream";
import { cn } from "../lib/cn";

type Kind = "call_in" | "call_out" | "sms_in" | "sms_out";

type PhoneComm = {
  id: string;
  kind: Kind;
  customerId: string | null;
  phoneLabelMatched: string | null;
  remoteNumber: string;
  extensionNumber: string | null;
  extensionName: string | null;
  direction: "inbound" | "outbound";
  startedAt: string;
  durationSeconds: number | null;
  body: string | null;
  transcription: string | null;
  recordingMediaId: string | null;
  smsStatus: "sent" | "delivered" | "read" | "failed" | null;
  groupNumber: string | null;
  sourceEventId: string | null;
  dismissedAt: string | null;
  dismissedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = { rows: PhoneComm[] };

// Customer search hit. Mirrors the shape returned by GET /api/customers
// (we pluck the same fields the customers list page already exposes).
type CustomerHit = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
};

type CustomerListResponse = { rows: CustomerHit[] };

const UNMATCHED_QUERY_KEY = ["vocatech", "unmatched"] as const;

export function UnmatchedPhoneCommInbox() {
  const queryClient = useQueryClient();

  const { data, refetch, isPending, isError } = useQuery<ListResponse>({
    queryKey: UNMATCHED_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/vocatech/unmatched?days=7");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // Light polling so the inbox stays fresh even when SSE drops. 60s is
    // brisk enough to feel live without hammering the API.
    refetchInterval: 60_000,
  });

  // Live updates: every phone-communication.received event from the
  // server. The typed SSE only fires for matched comms today (the
  // server emits with the customer's id), but in case the contract is
  // widened later, refetch unconditionally — the query is cheap and the
  // dedupe is server-side.
  useEventStream("phone-communication.received", () => {
    queryClient.invalidateQueries({ queryKey: UNMATCHED_QUERY_KEY });
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Unmatched calls & SMS</h2>
            <p className="mt-0.5 text-xs text-secondary">
              Last 7 days — {rows.length} unmatched
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
          >
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardBody className="p-0">
        {isPending ? (
          <div className="px-4 py-6 text-center text-sm text-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="px-4 py-6 text-center text-sm text-accent-danger">
            Failed to load unmatched communications.
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted">
            No unmatched communications in the last 7 days.
          </div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((row) => (
              <UnmatchedRow
                key={row.id}
                row={row}
                onChanged={() =>
                  queryClient.invalidateQueries({
                    queryKey: UNMATCHED_QUERY_KEY,
                  })
                }
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function UnmatchedRow({
  row,
  onChanged,
}: {
  row: PhoneComm;
  onChanged: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const isCall = row.kind === "call_in" || row.kind === "call_out";
  const inbound = row.kind === "call_in" || row.kind === "sms_in";
  const Icon = isCall
    ? inbound
      ? PhoneIncoming
      : PhoneOutgoing
    : MessageSquare;

  const matchMutation = useMutation({
    mutationFn: async (customerId: string) => {
      const res = await fetch(
        `/api/vocatech/communications/${row.id}/match`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      setPickerOpen(false);
      onChanged();
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/vocatech/communications/${row.id}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ ok: true }>;
    },
    onSuccess: onChanged,
  });

  // Body preview for SMS — first 80 chars. Calls show body (typically the
  // AI summary) if present, otherwise nothing.
  const bodyPreview = row.body
    ? row.body.length > 80
      ? row.body.slice(0, 80) + "…"
      : row.body
    : null;

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            inbound ? "text-accent-info" : "text-accent-success",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0 truncate text-sm font-medium text-primary">
              {row.remoteNumber}
              {row.extensionName ? (
                <span className="ml-2 text-xs font-normal text-muted">
                  → {row.extensionName}
                </span>
              ) : null}
            </div>
            <span className="shrink-0 text-xs text-muted">
              {formatRelative(row.startedAt)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-secondary">
            <Badge tone={inbound ? "info" : "success"}>
              {kindLabel(row.kind)}
            </Badge>
            {isCall && row.durationSeconds != null ? (
              <span className="text-muted">
                {formatDuration(row.durationSeconds)}
              </span>
            ) : null}
            {row.smsStatus ? <Badge tone="neutral">{row.smsStatus}</Badge> : null}
          </div>
          {bodyPreview && (
            <p className="mt-1 line-clamp-2 text-xs text-secondary">
              {bodyPreview}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setPickerOpen((o) => !o)}
            >
              <Check className="size-3.5" />
              Match to customer
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={dismissMutation.isPending}
              onClick={() => dismissMutation.mutate()}
            >
              <X className="size-3.5" />
              {dismissMutation.isPending ? "Ignoring…" : "Ignore"}
            </Button>
            {matchMutation.isError && (
              <span className="text-xs text-accent-danger">
                {(matchMutation.error as Error).message}
              </span>
            )}
            {dismissMutation.isError && (
              <span className="text-xs text-accent-danger">
                {(dismissMutation.error as Error).message}
              </span>
            )}
          </div>
          {pickerOpen && (
            <div className="mt-2">
              <CustomerTypeahead
                onPick={(customerId) => matchMutation.mutate(customerId)}
                onClose={() => setPickerOpen(false)}
                isPending={matchMutation.isPending}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// Small typeahead that hits GET /api/customers?q= for the row-level
// customer picker. No dependency on the existing CustomerPicker in
// return-new.tsx because that one is wedged inside the RMA flow's local
// state — copying the input + dropdown is cheaper than refactoring it
// into a shared component for one other consumer.
function CustomerTypeahead({
  onPick,
  onClose,
  isPending,
}: {
  onPick: (customerId: string) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<number | null>(null);

  // Reset active selection whenever the query or results change.
  useEffect(() => { setActiveIndex(-1); }, [query]);
  useEffect(() => { setActiveIndex(-1); }, [results]);

  useEffect(() => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
    }
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/customers?q=${encodeURIComponent(trimmed)}&customerType=all&limit=20`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const body = (await res.json()) as CustomerListResponse;
        setResults(body.rows ?? []);
      } catch (err) {
        // Abort is expected when the user keeps typing; don't log.
        if ((err as Error).name === "AbortError") return;
        // Other errors fall through to setResults([]) implicitly
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
      }
      controller.abort();
    };
  }, [query]);

  return (
    <div className="rounded-md border border-default bg-base p-2">
      <input
        type="text"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search customer by name or email (min 2 chars)…"
        className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(results.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(-1, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (activeIndex >= 0 && results[activeIndex]) {
              onPick(results[activeIndex].id);
            }
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
        disabled={isPending}
      />
      {query.trim().length >= 2 && (
        <div className="mt-1 max-h-48 overflow-y-auto">
          {searching ? (
            <div className="px-2 py-1.5 text-xs text-muted">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted">No matches.</div>
          ) : (
            results.map((c, idx) => (
              <button
                key={c.id}
                type="button"
                disabled={isPending}
                onClick={() => onPick(c.id)}
                onMouseEnter={() => setActiveIndex(idx)}
                className={cn(
                  "block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated disabled:opacity-50",
                  activeIndex === idx && "bg-elevated font-semibold",
                )}
              >
                <div className="font-medium">{c.displayName}</div>
                {c.primaryEmail && (
                  <div className="text-xs text-secondary">{c.primaryEmail}</div>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function kindLabel(k: Kind): string {
  switch (k) {
    case "call_in":
      return "Inbound call";
    case "call_out":
      return "Outbound call";
    case "sms_in":
      return "Inbound SMS";
    case "sms_out":
      return "Outbound SMS";
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatRelative(iso: string): string {
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
  });
}
