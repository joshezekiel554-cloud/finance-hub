// Customer activity timeline. Subscribes to SSE for live updates so a
// new email arriving (Gmail poll → recordActivity → app.sseBroker.publish)
// or a payment landing in QBO (qb-sync → recordActivity → publish) shows
// up without needing a refresh.
//
// Pattern: when a `activity.created` event for this customer arrives,
// invalidate the customer query so React Query refetches and the new
// row slots in via the existing render. This is heavier than splicing
// the row in optimistically, but it keeps a single source of truth.

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  FileText,
  Send,
  DollarSign,
  TrendingUp,
  Pause,
  Play,
  Edit3,
  MessageSquare,
  CheckSquare,
  CircleDot,
  ChevronDown,
  ChevronRight,
  FileDown,
  RotateCcw,
  CheckCircle,
  XCircle,
  ShieldCheck,
  PackageX,
  Truck,
  PackageCheck,
  Receipt,
  CheckCircle2,
  MessageCircle,
  Ban,
  PhoneIncoming,
  PhoneOutgoing,
  ArrowUpRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardBody } from "./ui/card";
import { Badge } from "./ui/badge";
import { useEventStream } from "../lib/use-event-stream";
import { cn } from "../lib/cn";

export type ActivityKind =
  | "email_in"
  | "email_out"
  | "qbo_invoice_sent"
  | "qbo_statement_sent"
  | "qbo_payment"
  | "qbo_credit_memo"
  | "balance_change"
  | "hold_on"
  | "hold_off"
  | "terms_changed"
  | "manual_note"
  | "task_created"
  | "task_completed"
  // RMA kinds (Phase 1)
  | "rma_created"
  | "rma_approved"
  | "rma_denied"
  | "rma_override_approved"
  | "rma_warehouse_export_generated"
  | "rma_warehouse_export_cancelled"
  | "rma_sent_to_warehouse"
  | "rma_received_at_warehouse"
  | "rma_credit_memo_issued"
  | "rma_completed"
  | "rma_customer_reply"
  | "rma_cancelled"
  // Phone-communication synthetic kinds. The activities table doesn't
  // store these (ACTIVITY_KINDS is strict); the customer-detail GET
  // merges phone_communications rows into the timeline server-side
  // with these kinds so they render alongside emails/payments.
  | "phone_call_in"
  | "phone_call_out"
  | "phone_sms_in"
  | "phone_sms_out";

export type Activity = {
  id: string;
  customerId: string;
  userId: string | null;
  kind: ActivityKind | string;
  occurredAt: string;
  subject: string | null;
  body: string | null;
  bodyHtml: string | null;
  source: string;
  refType: string | null;
  refId: string | null;
  // Normalized payload. Written by the QB sync for QBO events; written by
  // the returns service for RMA events. Extended fields are optional so
  // old rows without them still render cleanly.
  meta: {
    qbId?: string;
    docNumber?: string | null;
    amount?: number;
    currency?: string | null;
    txnDate?: string | null;
    // RMA-specific meta fields
    creditMemoDocNumber?: string | null;
    rmaNumber?: string | null;
    // Phone-communication meta (only populated when kind starts with
    // "phone_"). Synthesized by the customer-detail GET — no DB column.
    remoteNumber?: string;
    extensionName?: string | null;
    durationSeconds?: number | null;
    smsStatus?: string | null;
    phoneLabelMatched?: string | null;
  } | null;
};

const KIND_META: Record<
  ActivityKind,
  { icon: LucideIcon; label: string; tone: "info" | "success" | "medium" | "neutral" }
> = {
  email_in: { icon: Mail, label: "Email received", tone: "info" },
  email_out: { icon: Send, label: "Email sent", tone: "info" },
  qbo_invoice_sent: { icon: FileText, label: "Invoice sent", tone: "info" },
  qbo_statement_sent: { icon: FileText, label: "Statement sent", tone: "info" },
  qbo_payment: { icon: DollarSign, label: "Payment", tone: "success" },
  qbo_credit_memo: { icon: DollarSign, label: "Credit memo", tone: "neutral" },
  balance_change: { icon: TrendingUp, label: "Balance change", tone: "neutral" },
  hold_on: { icon: Pause, label: "Put on hold", tone: "medium" },
  hold_off: { icon: Play, label: "Hold released", tone: "success" },
  terms_changed: { icon: Edit3, label: "Terms changed", tone: "neutral" },
  manual_note: { icon: MessageSquare, label: "Note", tone: "neutral" },
  task_created: { icon: CheckSquare, label: "Task created", tone: "neutral" },
  task_completed: { icon: CheckSquare, label: "Task completed", tone: "success" },
  // RMA event kinds
  rma_created: { icon: RotateCcw, label: "RMA created", tone: "neutral" },
  rma_approved: { icon: CheckCircle, label: "RMA approved", tone: "success" },
  rma_denied: { icon: XCircle, label: "RMA denied", tone: "medium" },
  rma_override_approved: { icon: ShieldCheck, label: "RMA override approved", tone: "success" },
  rma_warehouse_export_generated: { icon: FileDown, label: "Warehouse export generated", tone: "info" },
  rma_warehouse_export_cancelled: { icon: PackageX, label: "Warehouse export cancelled", tone: "medium" },
  rma_sent_to_warehouse: { icon: Truck, label: "Sent to warehouse", tone: "info" },
  rma_received_at_warehouse: { icon: PackageCheck, label: "Received at warehouse", tone: "info" },
  rma_credit_memo_issued: { icon: Receipt, label: "Credit memo issued", tone: "success" },
  rma_completed: { icon: CheckCircle2, label: "RMA completed", tone: "success" },
  rma_customer_reply: { icon: MessageCircle, label: "Customer reply", tone: "info" },
  rma_cancelled: { icon: Ban, label: "RMA cancelled", tone: "medium" },
  // Phone-comm rows. Call_in matches email_in's blue tone; call_out
  // mirrors email_out's success-green. SMS reuses the call colors for
  // inbound/outbound parity but with the MessageSquare icon.
  phone_call_in: { icon: PhoneIncoming, label: "Call received", tone: "info" },
  phone_call_out: { icon: PhoneOutgoing, label: "Call placed", tone: "success" },
  phone_sms_in: { icon: MessageSquare, label: "SMS received", tone: "info" },
  phone_sms_out: { icon: MessageSquare, label: "SMS sent", tone: "success" },
};

// Set of synthetic phone-comm kinds — used by the timeline to decide
// whether a row should expose the "open Calls & SMS tab" affordance.
const PHONE_COMM_KINDS = new Set<string>([
  "phone_call_in",
  "phone_call_out",
  "phone_sms_in",
  "phone_sms_out",
]);

function metaFor(kind: string) {
  return (KIND_META as Record<string, (typeof KIND_META)[ActivityKind]>)[kind] ?? {
    icon: CircleDot,
    label: kind,
    tone: "neutral" as const,
  };
}

export function ActivityTimeline({
  customerId,
  activities,
  queryKey,
  onJumpToCallsSms,
}: {
  customerId: string;
  activities: Activity[];
  // Query key to invalidate when a new SSE event arrives. Lets the
  // component live inside any page that fetches activities however it
  // wants (full customer query vs. a dedicated activities endpoint).
  queryKey: readonly unknown[];
  // Optional handler invoked when a phone-comm timeline row is clicked
  // (or its "open Calls & SMS" affordance). The customer-detail page
  // wires this to setTab("calls_sms"). Other consumers (none today)
  // could omit it; in that case the row stays inert.
  onJumpToCallsSms?: () => void;
}) {
  const [filterKinds, setFilterKinds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  // Subscribe to live activity events for THIS customer. We invalidate
  // (rather than splice) so the parent's data stays the source of truth.
  useEventStream("activity.created", (event) => {
    if (event.customerId !== customerId) return;
    queryClient.invalidateQueries({ queryKey });
  });
  // Same pattern for phone communications — when a new call/SMS lands
  // for this customer, the customer-detail GET will re-merge it into
  // the timeline on the next fetch.
  useEventStream("phone-communication.received", (event) => {
    if (event.customerId !== customerId) return;
    queryClient.invalidateQueries({ queryKey });
  });
  useEventStream("phone-communication.updated", (event) => {
    if (event.customerId !== customerId) return;
    queryClient.invalidateQueries({ queryKey });
  });

  // Group + sort. The API returns desc by occurredAt already, but a
  // local sort is cheap and resilient to upstream reordering.
  const sorted = useMemo(() => {
    return [...activities].sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }, [activities]);

  const filtered = useMemo(() => {
    if (filterKinds.size === 0) return sorted;
    return sorted.filter((a) => filterKinds.has(a.kind));
  }, [sorted, filterKinds]);

  // Build the list of kind chips that actually appear in the data — no
  // point showing a "Statement sent" filter when there are zero of them.
  const presentKinds = useMemo(() => {
    const set = new Set<string>();
    for (const a of activities) set.add(a.kind);
    return Array.from(set);
  }, [activities]);

  function toggleKindFilter(kind: string) {
    const next = new Set(filterKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setFilterKinds(next);
  }

  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }

  if (activities.length === 0) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-muted">
          No activity yet for this customer. New activity (emails, invoices,
          payments) will appear here in real time.
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {presentKinds.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Filter:</span>
          {presentKinds.map((kind) => {
            const m = metaFor(kind);
            const active = filterKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKindFilter(kind)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors",
                  active
                    ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                    : "border-default text-secondary hover:border-strong hover:text-primary",
                )}
              >
                <m.icon className="size-3" />
                {m.label}
              </button>
            );
          })}
          {filterKinds.size > 0 && (
            <button
              type="button"
              onClick={() => setFilterKinds(new Set())}
              className="text-secondary underline-offset-2 hover:text-primary hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <Card>
        <CardBody className="p-0">
          <ul className="divide-y divide-default">
            {filtered.map((activity) => {
              const m = metaFor(activity.kind);
              const isExpanded = expanded.has(activity.id);
              const hasBody = Boolean(activity.body);
              const isPhoneComm = PHONE_COMM_KINDS.has(activity.kind);
              return (
                <li key={activity.id} className="px-4 py-3 text-sm">
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                        m.tone === "info" && "bg-accent-info/10 text-accent-info",
                        m.tone === "success" &&
                          "bg-accent-success/10 text-accent-success",
                        m.tone === "medium" &&
                          "bg-accent-warning/10 text-accent-warning",
                        m.tone === "neutral" && "bg-elevated text-secondary",
                      )}
                    >
                      <m.icon className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <button
                          type="button"
                          disabled={!hasBody}
                          onClick={() => {
                            if (hasBody) toggleExpanded(activity.id);
                          }}
                          className={cn(
                            "min-w-0 flex-1 truncate text-left font-medium",
                            hasBody && "cursor-pointer hover:text-accent-primary",
                          )}
                        >
                          {hasBody && (
                            <span className="mr-1 inline-block align-middle text-muted">
                              {isExpanded ? (
                                <ChevronDown className="inline size-3" />
                              ) : (
                                <ChevronRight className="inline size-3" />
                              )}
                            </span>
                          )}
                          {activity.subject ?? m.label}
                        </button>
                        <span className="shrink-0 text-xs text-muted">
                          {formatTime(activity.occurredAt)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-secondary">
                        <Badge tone={m.tone}>{m.label}</Badge>
                        {activity.meta?.amount !== undefined &&
                          activity.meta.amount > 0 && (
                            <Badge tone="neutral">
                              {formatAmount(
                                activity.meta.amount,
                                activity.meta.currency,
                              )}
                            </Badge>
                          )}
                        {activity.meta?.docNumber && (
                          <span className="text-muted">
                            #{activity.meta.docNumber}
                          </span>
                        )}
                        {isPhoneComm && activity.meta?.phoneLabelMatched && (
                          <Badge tone="neutral">
                            {activity.meta.phoneLabelMatched}
                          </Badge>
                        )}
                        {isPhoneComm && activity.meta?.smsStatus && (
                          <Badge tone="neutral">{activity.meta.smsStatus}</Badge>
                        )}
                        <PdfLink kind={activity.kind} qbId={activity.meta?.qbId} />
                        <RmaLink refType={activity.refType} refId={activity.refId} />
                        {isPhoneComm && onJumpToCallsSms && (
                          <button
                            type="button"
                            onClick={onJumpToCallsSms}
                            className="inline-flex items-center gap-1 text-accent-primary hover:underline"
                          >
                            <ArrowUpRight className="size-3" />
                            Open in Calls & SMS
                          </button>
                        )}
                        <span className="text-muted">via {activity.source}</span>
                      </div>
                      {hasBody && isExpanded && (
                        <div className="mt-2 whitespace-pre-wrap rounded-md border border-default bg-subtle p-3 text-xs text-secondary">
                          {activity.body}
                        </div>
                      )}
                      {/* Expanded RMA meta — e.g. credit memo doc number */}
                      {activity.kind === "rma_credit_memo_issued" &&
                        activity.meta?.creditMemoDocNumber && (
                          <div className="mt-1 text-xs text-muted">
                            CM #{activity.meta.creditMemoDocNumber}
                          </div>
                        )}
                    </div>
                  </div>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-muted">
                No activities match the selected filters.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

// RMA link — renders a "View RMA" anchor whenever refType === "rma" and
// refId is set. Uses a plain <a> so this component has no dependency on
// the TanStack Router param types.
function RmaLink({
  refType,
  refId,
}: {
  refType: string | null;
  refId: string | null;
}) {
  if (refType !== "rma" || !refId) return null;
  return (
    <a
      href={`/returns/${encodeURIComponent(refId)}`}
      className="inline-flex items-center gap-1 text-accent-primary hover:underline"
    >
      <RotateCcw className="size-3" />
      View RMA
    </a>
  );
}

// PDF link for invoice + credit-memo activities. Streams from the
// /api/qb-pdf proxy so the user gets a real PDF in a new tab; nothing
// is stored locally. Renders nothing for kinds without a PDF endpoint
// (payments, hold toggles, emails, etc.).
function PdfLink({
  kind,
  qbId,
}: {
  kind: string;
  qbId: string | undefined;
}) {
  if (!qbId) return null;
  const route =
    kind === "qbo_invoice_sent"
      ? "invoice"
      : kind === "qbo_credit_memo"
        ? "creditmemo"
        : null;
  if (!route) return null;
  return (
    <a
      href={`/api/qb-pdf/${route}/${qbId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-accent-primary hover:underline"
    >
      <FileDown className="size-3" />
      PDF
    </a>
  );
}

function formatAmount(amount: number, currency: string | null | undefined): string {
  // Prefer Intl.NumberFormat when we have a real ISO 4217 currency code;
  // fall back to a simple "$" prefix for unknown / null currencies.
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).format(amount);
    } catch {
      // Unsupported currency code; fall through to the plain format
    }
  }
  return `$${amount.toFixed(2)}`;
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
  // Older than a week: include time so multiple same-day emails render
  // in a readable order. Year only when older than a year ago — keeps
  // recent rows tight ("25 Nov, 14:32" vs "25 Nov 2025, 14:32").
  const datePart = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: diffDay > 365 ? "numeric" : undefined,
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${datePart}, ${timePart}`;
}
