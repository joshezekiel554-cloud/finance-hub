// StatementSendDialog — confirm-before-send dialog for the
// per-customer statement of account.
//
// Flow:
//   1. Open → fetches GET /api/customers/:id/statement-preview which
//      returns the open-invoice list, totals, and addressed recipients
//      (To/CC/BCC). Lookup of QBO Pay-now InvoiceLink presence is
//      best-effort; failures render as gray "unknown" dots.
//   2. User clicks Send → POST /api/customers/:id/statement-send
//      (no body — the server is authoritative about everything).
//   3. On success: closes the dialog, fires onSent so the customer
//      detail page can show a confirmation pill, and invalidates the
//      ["customer", customerId] query so the activity timeline picks
//      up the new qbo_statement_sent row.
//
// Errors are surfaced inline with friendly copy for the well-known
// codes (no_open_invoices, no_primary_email, template_missing /
// template_not_found). All other errors fall back to the server's
// returned message.
//
// Design notes:
//   - The Send button is disabled while the preview is still loading
//     (we won't let the user fire blind) and while the send is in
//     flight.
//   - We cap the rendered invoice list at 50 (the server caps too).
//   - The recipient row uses pills with To/CC/BCC labels per the spec.
//   - The InvoiceLink dot is green (present), gray (missing), or muted
//     (unknown — QBO lookup failed).

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Mail, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

type PreviewInvoice = {
  qbInvoiceId: string;
  docNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  balance: string;
  hasInvoiceLink: boolean | null;
};

type StatementPreviewResponse = {
  openInvoices: PreviewInvoice[];
  totalOpenBalance: number;
  totalOverdueBalance: number;
  recipients: {
    to: string;
    cc: string[];
    // null when the operator has disabled the statement BCC in
    // Settings (statement_bcc_email is blank). The dialog hides the
    // BCC row in that case.
    bcc: string | null;
  };
  truncated: boolean;
  invoiceLinkLookupOk: boolean;
};

type StatementSendResponse = {
  statementSendId: string;
  sent: { to: string; cc: string | null; bcc: string | null };
  openInvoiceCount: number;
  totalOpenBalance: number;
  totalOverdueBalance: number;
  sentAt: string;
  messageId: string;
};

type ApiError = {
  error?: string;
  code?: string;
};

export type StatementSendSuccess = {
  to: string;
  invoiceCount: number;
  totalOpenBalance: number;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  onSent?: (result: StatementSendSuccess) => void;
};

const PREVIEW_DISPLAY_CAP = 50;

function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

// Stringly typed at API boundary — `balance` is a numeric string from
// MySQL DECIMAL. We only need its display form here.
function formatBalanceString(s: string): string {
  const n = Number(s);
  return Number.isFinite(n) ? formatMoney(n) : s;
}

// Map a server error code to the inline copy the spec calls out.
// Falls back to whatever message the server sent.
function friendlyError(err: ApiError | null, fallback: string): string {
  if (!err) return fallback;
  switch (err.code) {
    case "no_open_invoices":
      return "No open invoices to send — nothing to do.";
    case "no_primary_email":
      return "Customer has no primary email — fix in QBO first.";
    case "template_missing":
    case "template_not_found":
      return "Statement template missing — run the template seed script.";
    case "customer_not_found":
      return "Customer not found.";
    case "too_many_invoices":
      return (
        err.error ??
        `Too many open invoices to attach in one send (cap is ${PREVIEW_DISPLAY_CAP}).`
      );
    case "qbo_failed":
      return err.error ?? "QuickBooks lookup failed — try again in a moment.";
    case "send_failed":
      return err.error ?? "Email send failed — try again in a moment.";
    default:
      return err.error ?? fallback;
  }
}

export default function StatementSendDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  onSent,
}: Props) {
  const queryClient = useQueryClient();

  const previewQuery = useQuery<StatementPreviewResponse, ApiError>({
    queryKey: ["statement-preview", customerId],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/statement-preview`,
      );
      if (!res.ok) {
        const json: ApiError = await res.json().catch(() => ({}));
        // Throw the error envelope so react-query exposes it in
        // previewQuery.error with code intact.
        throw json.code
          ? json
          : ({ error: json.error ?? `HTTP ${res.status}` } as ApiError);
      }
      return (await res.json()) as StatementPreviewResponse;
    },
    enabled: open,
    // The preview's main user-visible cost is a QBO call; don't refetch
    // on focus. A confirm-and-send dialog is short-lived anyway.
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const sendMutation = useMutation<
    StatementSendResponse,
    ApiError,
    void
  >({
    mutationFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/statement-send`,
        { method: "POST" },
      );
      if (!res.ok) {
        const json: ApiError = await res.json().catch(() => ({}));
        throw json.code
          ? json
          : ({ error: json.error ?? `HTTP ${res.status}` } as ApiError);
      }
      return (await res.json()) as StatementSendResponse;
    },
    onSuccess: (result) => {
      // Activity timeline + customer header rollups depend on
      // ["customer", customerId]. Invalidate so the new
      // qbo_statement_sent activity surfaces immediately.
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      onSent?.({
        to: result.sent.to,
        invoiceCount: result.openInvoiceCount,
        totalOpenBalance: result.totalOpenBalance,
      });
      onOpenChange(false);
    },
  });

  const previewError = previewQuery.error;
  const sendError = sendMutation.error;

  const isPreviewBlocking = previewQuery.isPending && !previewQuery.data;
  const canSend =
    !isPreviewBlocking &&
    !sendMutation.isPending &&
    !!previewQuery.data &&
    previewQuery.data.openInvoices.length > 0 &&
    !previewError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send statement to {customerName}</DialogTitle>
          <DialogDescription>
            A single Statement.pdf is generated and attached to the
            email. Each open invoice in the statement has a Pay-now
            link straight to QuickBooks. The recipient list below
            shows the BCC (if any) — change it in Settings → Statement
            PDF.
          </DialogDescription>
        </DialogHeader>

        {isPreviewBlocking && (
          <div className="py-6 text-center text-sm text-muted">
            Loading preview…
          </div>
        )}

        {previewError && !previewQuery.isPending && (
          <ErrorBlock
            message={friendlyError(previewError, "Failed to load preview")}
          />
        )}

        {previewQuery.data && (
          <PreviewBody data={previewQuery.data} />
        )}

        {/* The send error wins over the preview error in the inline
            slot — but only render it once. PreviewError is shown above
            (ErrorBlock); the send error renders just above the footer
            so the user sees the most-recent failure near the action. */}
        {sendError && (
          <ErrorBlock
            message={friendlyError(sendError, "Send failed")}
            className="mt-3"
          />
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={sendMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              window.open(
                `/api/customers/${encodeURIComponent(customerId)}/statement-pdf-preview`,
                "_blank",
                "noopener,noreferrer",
              )
            }
            disabled={!canSend}
            title="Open the rendered Statement.pdf in a new tab — same content the customer will receive"
          >
            Preview PDF
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => sendMutation.mutate()}
            disabled={!canSend}
            loading={sendMutation.isPending}
          >
            <Send className="size-3.5" />
            {sendMutation.isPending ? "Sending…" : "Send statement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ data }: { data: StatementPreviewResponse }) {
  const { openInvoices, totalOpenBalance, totalOverdueBalance, recipients } =
    data;

  const cappedInvoices = useMemo(
    () => openInvoices.slice(0, PREVIEW_DISPLAY_CAP),
    [openInvoices],
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 rounded-md border border-default bg-elevated p-3 text-sm">
        <SummaryStat
          label="Open invoices"
          value={String(openInvoices.length)}
        />
        <SummaryStat
          label="Open balance"
          value={formatMoney(totalOpenBalance)}
        />
        <SummaryStat
          label="Overdue"
          value={
            totalOverdueBalance > 0 ? formatMoney(totalOverdueBalance) : "—"
          }
          tone={totalOverdueBalance > 0 ? "warning" : "neutral"}
        />
        <SummaryStat
          label="Attaches"
          value="1 Statement.pdf"
        />
      </div>

      <RecipientsRow recipients={recipients} />

      <InvoiceList
        invoices={cappedInvoices}
        invoiceLinkLookupOk={data.invoiceLinkLookupOk}
        truncated={data.truncated}
      />

      {!data.invoiceLinkLookupOk && (
        <p className="text-xs text-muted">
          Couldn't reach QuickBooks to check Pay-now link presence — dots
          shown as unknown. The send will still try to fetch links itself.
        </p>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning" | "neutral";
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-base font-semibold tabular-nums",
          tone === "warning" && "text-accent-warning",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function RecipientsRow({
  recipients,
}: {
  recipients: StatementPreviewResponse["recipients"];
}) {
  return (
    <div className="rounded-md border border-default bg-base p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        <Mail className="size-3" />
        Recipients
      </div>
      <ul className="space-y-1.5 text-sm">
        <li className="flex flex-wrap items-center gap-2">
          <Badge tone="info">To</Badge>
          <span className="break-all">{recipients.to}</span>
        </li>
        {recipients.cc.length > 0 && (
          <li className="flex flex-wrap items-start gap-2">
            <Badge tone="neutral">CC</Badge>
            <span className="break-all">{recipients.cc.join(", ")}</span>
          </li>
        )}
        {recipients.bcc ? (
          <li className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">BCC</Badge>
            <span className="break-all">{recipients.bcc}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function InvoiceList({
  invoices,
  invoiceLinkLookupOk,
  truncated,
}: {
  invoices: PreviewInvoice[];
  invoiceLinkLookupOk: boolean;
  truncated: boolean;
}) {
  return (
    <div className="rounded-md border border-default">
      <div className="flex items-center justify-between border-b border-default bg-elevated px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
        <span>Invoices ({invoices.length})</span>
        {invoiceLinkLookupOk && (
          <span className="flex items-center gap-1 text-[10px] normal-case">
            <DotIndicator state={true} />
            <span>= Pay link present</span>
          </span>
        )}
      </div>
      <ul className="max-h-72 divide-y divide-default overflow-y-auto">
        {invoices.map((inv) => (
          <li
            key={inv.qbInvoiceId}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <DotIndicator state={inv.hasInvoiceLink} />
            <span className="font-mono text-xs text-secondary">
              #{inv.docNumber ?? `qb-${inv.qbInvoiceId}`}
            </span>
            <span className="text-xs text-muted">
              {inv.issueDate ?? "—"}
            </span>
            <span className="ml-auto tabular-nums">
              {formatBalanceString(inv.balance)}
            </span>
          </li>
        ))}
      </ul>
      {truncated && (
        <div className="border-t border-default bg-elevated px-3 py-2 text-xs text-muted">
          More than {PREVIEW_DISPLAY_CAP} open invoices — only the first{" "}
          {PREVIEW_DISPLAY_CAP} are listed in this preview. The full set
          renders in the Statement.pdf.
        </div>
      )}
    </div>
  );
}

// Pay-now link presence indicator. true = green, false = gray, null =
// muted (unknown — QBO lookup failed/skipped). The dot is purely
// informational; the send still attempts to fetch links itself.
function DotIndicator({ state }: { state: boolean | null }) {
  let cls: string;
  let title: string;
  if (state === true) {
    cls = "bg-accent-success";
    title = "Pay-now link present";
  } else if (state === false) {
    cls = "bg-muted/50";
    title = "No Pay-now link";
  } else {
    cls = "bg-muted/30";
    title = "Pay-now link unknown";
  }
  return (
    <span
      title={title}
      aria-label={title}
      className={cn("inline-block size-2 shrink-0 rounded-full", cls)}
    />
  );
}

function ErrorBlock({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/5 px-3 py-2 text-sm text-accent-danger",
        className,
      )}
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
