// Email review — invoices QBO says were never emailed, or whose email
// bounced. Data: GET /api/invoicing/email-review (mirrors QBO's
// EmailStatus/DeliveryInfo, refreshed by the 30-min QB sync). Send reuses
// InvoiceSendDialog (same path as the customer page); Dismiss/Restore hit
// this section's own endpoints.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { AlertTriangle, MailX, RotateCcw } from "lucide-react";
import InvoiceSendDialog from "../invoice-send-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardBody } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { cn } from "../../lib/cn";
// The wire shape is owned by the module that produces it — importing the
// types keeps this component honest if the response ever changes. These are
// type-only imports, so nothing server-side reaches the browser bundle.
import type {
  EmailReviewRow,
  EmailReviewResponse,
} from "../../../modules/invoice-email-review/bucket.js";
import type { EmailReviewDismissReason } from "../../../db/schema/invoice-email-dismissals.js";

const REASON_LABELS: Record<EmailReviewDismissReason, string> = {
  sent_elsewhere: "Sent another way",
  no_invoice_needed: "No invoice needed",
  other: "Other",
};

export const EMAIL_REVIEW_QUERY_KEY = ["invoicing", "email-review"] as const;

export function useEmailReview(): UseQueryResult<EmailReviewResponse> {
  return useQuery<EmailReviewResponse>({
    queryKey: EMAIL_REVIEW_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/invoicing/email-review");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    // refetchOnWindowFocus is off globally, so poll like the page's other
    // count queries do — otherwise the section goes stale after a sync.
    refetchInterval: 60_000,
  });
}

type Tab = "never_emailed" | "delivery_failed" | "dismissed";

function money(v: string): string {
  const n = Number(v);
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function ageDays(isoDay: string | null): string {
  if (!isoDay) return "";
  const days = Math.floor(
    (Date.now() - new Date(`${isoDay}T00:00:00Z`).getTime()) / 86_400_000,
  );
  // QBO accepts a TxnDate in the future, so negative ages are real.
  return days < 0 ? "future-dated" : days === 0 ? "today" : `${days}d`;
}

function timeOfDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      // keep the HTTP status message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function EmailReviewSection({
  id,
  query,
}: {
  id: string;
  query: UseQueryResult<EmailReviewResponse>;
}) {
  const [tab, setTab] = useState<Tab>("never_emailed");
  const data = query.data;
  const counts = {
    never_emailed: data?.neverEmailed.length ?? 0,
    delivery_failed: data?.deliveryFailed.length ?? 0,
    dismissed: data?.dismissed.length ?? 0,
  };
  const rows: EmailReviewRow[] =
    tab === "never_emailed"
      ? (data?.neverEmailed ?? [])
      : tab === "delivery_failed"
        ? (data?.deliveryFailed ?? [])
        : (data?.dismissed ?? []);

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "never_emailed", label: "Never emailed" },
    { key: "delivery_failed", label: "Delivery failed" },
    { key: "dismissed", label: "Dismissed" },
  ];

  return (
    <section
      id={id}
      className="space-y-3 mt-8 pt-6 border-t-2 border-default scroll-mt-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Email review</h2>
          <p className="mt-0.5 text-xs text-secondary">
            What QuickBooks says about recent invoices: never emailed by anyone,
            or emailed and bounced. As of {timeOfDay(data?.syncedAt ?? null)}{" "}
            (30-min QB sync).
          </p>
        </div>
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                tab === t.key
                  ? "bg-elevated font-medium"
                  : "text-secondary hover:text-primary",
              )}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-secondary">
                {counts[t.key]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {query.isPending && (
        <Card>
          <CardBody>
            <p className="text-sm text-secondary">Loading email review…</p>
          </CardBody>
        </Card>
      )}
      {query.isError && (
        <Card>
          <CardBody className="flex items-center justify-between gap-3">
            <p className="text-sm text-accent-danger">
              Couldn't load:{" "}
              {query.error instanceof Error
                ? query.error.message
                : "unknown error"}
            </p>
            <Button size="sm" variant="secondary" onClick={() => query.refetch()}>
              Retry
            </Button>
          </CardBody>
        </Card>
      )}
      {data && rows.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-sm text-secondary">
              {tab === "dismissed"
                ? "Nothing dismissed."
                : "Nothing waiting — QuickBooks agrees every recent invoice was emailed."}
            </p>
          </CardBody>
        </Card>
      )}
      {data && rows.length > 0 && (
        <Card>
          <ul className="divide-y divide-default">
            {rows.map((row) => (
              <EmailReviewRowItem key={row.invoiceId} row={row} tab={tab} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function EmailReviewRowItem({ row, tab }: { row: EmailReviewRow; tab: Tab }) {
  const queryClient = useQueryClient();
  const [sendOpen, setSendOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<EmailReviewDismissReason>("sent_elsewhere");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: EMAIL_REVIEW_QUERY_KEY });

  const dismiss = useMutation({
    mutationFn: () =>
      postJson<{ ok: boolean; hidden?: boolean }>(
        "/api/invoicing/email-review/dismiss",
        {
          invoiceId: row.invoiceId,
          reason,
          reasonNote: note.trim() || undefined,
        },
      ),
    // Clear the previous attempt's message so a retry never shows a stale
    // error next to a fresh result.
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (result) => {
      setDismissOpen(false);
      setError(null);
      // The dismissal is saved either way; hidden:false means it cannot take
      // effect yet, so say so rather than letting the row look stuck.
      setNotice(
        result.hidden === false
          ? "Dismissal saved, but this bounce has no delivery timestamp so it stays visible until QuickBooks records a newer send."
          : null,
      );
      void invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const restore = useMutation({
    mutationFn: () =>
      postJson<{ ok: boolean; restored?: boolean }>(
        "/api/invoicing/email-review/restore",
        { invoiceId: row.invoiceId },
      ),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: () => {
      setError(null);
      setNotice(null);
      void invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const noteRequired = reason === "other" && note.trim().length === 0;

  return (
    <li className="p-3 md:p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">#{row.docNumber ?? row.qbInvoiceId}</span>
            <Link
              to="/customers/$customerId"
              params={{ customerId: row.customerId }}
              className="truncate text-accent-primary underline-offset-2 hover:underline"
            >
              {row.customerName}
            </Link>
            {row.origin === "tj" && <Badge tone="neutral">TJ</Badge>}
            {row.deliveryError && (
              // QBO delivery errors can be a full SMTP transcript, so cap the
              // badge and keep the whole string in the tooltip.
              <Badge
                tone="critical"
                className="max-w-[24rem] truncate"
                title={row.deliveryError}
              >
                <MailX className="mr-1 inline size-3" />
                {row.deliveryError}
              </Badge>
            )}
            {!row.deliveryError && (
              <Badge tone="high">
                <AlertTriangle className="mr-1 inline size-3" />
                {row.emailStatus ?? "NotSet"}
              </Badge>
            )}
          </div>
          <div className="text-sm text-secondary">
            {/* Undated invoices exist (QBO lets TxnDate be blank), so the
                age parenthetical is dropped rather than left empty. */}
            Issued {row.issueDate ?? "—"}
            {row.issueDate && ` (${ageDays(row.issueDate)})`} · {money(row.total)}{" "}
            total · {money(row.balance)} open
            {row.deliveryTime &&
              ` · last email ${new Date(row.deliveryTime).toLocaleString()}`}
          </div>
          <div className="text-sm">
            {/* A missing TO address is the reason the invoice can't go out,
                so it reads as a warning rather than as a recipient. */}
            <span
              className={
                row.recipients.to.length > 0
                  ? "font-medium"
                  : "text-accent-warning"
              }
            >
              {row.recipients.to.join(", ") || "no TO address"}
            </span>
            {row.recipients.cc.length > 0 && (
              <span className="text-secondary">
                {" "}
                · cc {row.recipients.cc.join(", ")}
              </span>
            )}
          </div>
          {row.dismissal && (
            <div className="text-xs text-secondary">
              Dismissed {new Date(row.dismissal.dismissedAt).toLocaleString()}
              {row.dismissal.dismissedBy
                ? ` by ${row.dismissal.dismissedBy}`
                : ""}{" "}
              · {REASON_LABELS[row.dismissal.reason]}
              {row.dismissal.reasonNote ? ` — ${row.dismissal.reasonNote}` : ""}
              {tab !== "dismissed" &&
                " · re-surfaced: QBO recorded a newer delivery attempt"}
            </div>
          )}
          {error && (
            <div aria-live="polite" className="text-xs text-accent-danger">
              {error}
            </div>
          )}
          {notice && (
            <div aria-live="polite" className="text-xs text-secondary">
              {notice}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {tab === "dismissed" ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => restore.mutate()}
              loading={restore.isPending}
            >
              <RotateCcw className="size-3.5" />
              Restore
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => setSendOpen(true)}>
                Send via QBO
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDismissOpen((v) => !v)}
              >
                Dismiss
              </Button>
            </>
          )}
        </div>
      </div>

      {dismissOpen && tab !== "dismissed" && (
        <div className="mt-3 flex flex-col gap-2 rounded-md bg-elevated p-3 md:flex-row md:items-center">
          <div className="md:w-48">
            <Select
              value={reason}
              onChange={(e) => setReason(e.target.value as EmailReviewDismissReason)}
            >
              {(Object.keys(REASON_LABELS) as EmailReviewDismissReason[]).map((r) => (
                <option key={r} value={r}>
                  {REASON_LABELS[r]}
                </option>
              ))}
            </Select>
          </div>
          <div className="md:flex-1">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                reason === "other" ? "Why? (required)" : "Note (optional)"
              }
              maxLength={500}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => dismiss.mutate()}
              loading={dismiss.isPending}
              disabled={noteRequired}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDismissOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {sendOpen && (
        <InvoiceSendDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          customerId={row.customerId}
          customerName={row.customerName}
          invoice={{
            qbInvoiceId: row.qbInvoiceId,
            docNumber: row.docNumber,
            total: row.total,
            balance: row.balance,
            issueDate: row.issueDate,
            dueDate: null,
          }}
          onSent={() => {
            setSendOpen(false);
            // Optimistic: drop the row now; the next sync confirms EmailSent.
            queryClient.setQueryData<EmailReviewResponse>(
              EMAIL_REVIEW_QUERY_KEY,
              (prev) =>
                prev
                  ? {
                      ...prev,
                      neverEmailed: prev.neverEmailed.filter(
                        (r) => r.invoiceId !== row.invoiceId,
                      ),
                      deliveryFailed: prev.deliveryFailed.filter(
                        (r) => r.invoiceId !== row.invoiceId,
                      ),
                    }
                  : prev,
            );
          }}
        />
      )}
    </li>
  );
}
