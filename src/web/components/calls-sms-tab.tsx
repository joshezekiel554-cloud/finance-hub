// Calls & SMS tab body. Unified chronological feed of phone_communications
// rows for one customer, with a pinned outbound-SMS compose box at the
// bottom. Live-refreshes when Vocatech webhooks publish SSE events for this
// customer.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PhoneIncoming,
  PhoneOutgoing,
  MessageSquare,
  FileText,
} from "lucide-react";
import { Card, CardBody } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CallRecordingPlayer } from "./call-recording-player";
import { CallTranscriptModal } from "./call-transcript-modal";
import { SmsComposeBox } from "./sms-compose-box";
import { useEventStream } from "../lib/use-event-stream";
import { cn } from "../lib/cn";

type Kind = "call_in" | "call_out" | "sms_in" | "sms_out";
type Direction = "inbound" | "outbound";
type SmsStatus = "sent" | "delivered" | "read" | "failed";

export type PhoneCommunicationRow = {
  id: string;
  kind: Kind;
  customerId: string | null;
  phoneLabelMatched: string | null;
  remoteNumber: string;
  extensionNumber: string | null;
  extensionName: string | null;
  direction: Direction;
  startedAt: string;
  durationSeconds: number | null;
  body: string | null;
  transcription: string | null;
  recordingMediaId: string | null;
  smsStatus: SmsStatus | null;
  groupNumber: string | null;
  sourceEventId: string | null;
  dismissedAt: string | null;
  dismissedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = { rows: PhoneCommunicationRow[] };

type AdditionalPhone = { label: string; number: string };

type Props = {
  customerId: string;
  primaryPhone: string | null;
  additionalPhones: AdditionalPhone[] | null;
};

export function CallsSmsTab({
  customerId,
  primaryPhone,
  additionalPhones,
}: Props) {
  const queryClient = useQueryClient();
  const queryKey = ["phone-communications", customerId] as const;

  const { data, isPending, isError, error } = useQuery<ListResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/customers/${customerId}/phone-communications`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // Live refresh — new call/SMS arriving or an existing row's status
  // bumping (sms_status, transcription late-arriving). Filter by
  // customerId because SSE fans out to all sessions.
  useEventStream("phone-communication.received", (evt) => {
    if (evt.customerId !== customerId) return;
    queryClient.invalidateQueries({ queryKey });
  });
  useEventStream("phone-communication.updated", (evt) => {
    if (evt.customerId !== customerId) return;
    queryClient.invalidateQueries({ queryKey });
  });

  const rows = data?.rows ?? [];

  return (
    <div className="flex h-[70vh] flex-col">
      <div className="flex-1 overflow-y-auto pr-1">
        {isPending ? (
          <div className="py-6 text-center text-sm text-muted">Loading…</div>
        ) : isError ? (
          <div className="py-6 text-center text-sm text-accent-danger">
            {(error as Error)?.message ?? "Failed to load"}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted">
            No calls or SMS for this customer yet.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </div>
        )}
      </div>
      <SmsComposeBox
        customerId={customerId}
        primaryPhone={primaryPhone}
        additionalPhones={additionalPhones}
        onSent={() => queryClient.invalidateQueries({ queryKey })}
      />
    </div>
  );
}

function Row({ row }: { row: PhoneCommunicationRow }) {
  const isCall = row.kind === "call_in" || row.kind === "call_out";
  return isCall ? <CallRow row={row} /> : <SmsRow row={row} />;
}

function CallRow({ row }: { row: PhoneCommunicationRow }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const inbound = row.kind === "call_in";
  const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  const remote = row.phoneLabelMatched
    ? `${row.phoneLabelMatched} • ${row.remoteNumber}`
    : row.remoteNumber;
  const headerLeft =
    row.extensionName ?? row.extensionNumber ?? (inbound ? "—" : "Outbound");

  return (
    <Card>
      <CardBody className="flex flex-col gap-2 px-4 py-3">
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
              <div className="text-sm font-medium text-primary">
                {headerLeft}
                <span className="text-muted"> • </span>
                <span className="text-secondary">{remote}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted">
                {row.durationSeconds != null ? (
                  <span>{formatDuration(row.durationSeconds)}</span>
                ) : null}
                <span>{formatTime(row.startedAt)}</span>
              </div>
            </div>
            {row.body ? (
              <p className="mt-1 line-clamp-3 text-sm text-secondary">
                {row.body}
              </p>
            ) : null}
            {(row.transcription || row.recordingMediaId) && (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {row.recordingMediaId ? (
                  <CallRecordingPlayer phoneCommId={row.id} />
                ) : null}
                {row.transcription ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setTranscriptOpen(true)}
                  >
                    <FileText className="size-3.5" /> View transcript
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </div>
        {row.transcription ? (
          <CallTranscriptModal
            open={transcriptOpen}
            onOpenChange={setTranscriptOpen}
            transcription={row.transcription}
            title={`Call transcript — ${formatDateLong(row.startedAt)}`}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function SmsRow({ row }: { row: PhoneCommunicationRow }) {
  const inbound = row.kind === "sms_in";
  return (
    <Card>
      <CardBody className="flex items-start gap-3 px-4 py-3">
        <MessageSquare
          className={cn(
            "mt-0.5 size-4 shrink-0",
            inbound ? "text-accent-info" : "text-accent-success",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-primary">
                {inbound ? "From" : "To"} {row.remoteNumber}
              </span>
              {row.phoneLabelMatched ? (
                <Badge tone="neutral">{row.phoneLabelMatched}</Badge>
              ) : null}
              {row.smsStatus ? <SmsStatusBadge status={row.smsStatus} /> : null}
            </div>
            <span className="text-xs text-muted">
              {formatTime(row.startedAt)}
            </span>
          </div>
          {row.body ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-primary">
              {row.body}
            </p>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

function SmsStatusBadge({ status }: { status: SmsStatus }) {
  const tone: "info" | "success" | "neutral" | "critical" =
    status === "failed"
      ? "critical"
      : status === "read" || status === "delivered"
        ? "success"
        : status === "sent"
          ? "info"
          : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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

function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
