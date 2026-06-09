import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Mail, Undo2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

// Per-invoice TJ dispute affordance. Renders nothing for non-TJ rows.
// Drives the "customer claims paid" parking loop:
//   null / confirmed_unpaid → "Customer claims paid" (optional note) →
//     POST claims-paid → state becomes "verifying".
//   verifying → amber badge + saved note + (optional) "Email TJ
//     bookkeeper" + "Paid → Void" (voids in QBO) + "Not paid".
//   confirmed_paid → muted "Voided · paid" tag.
// All successful mutations call onChanged so the caller can invalidate
// the relevant queries.

export type DisputeInvoice = {
  id: string | null;
  origin: "feldart" | "tj";
  disputeState: "verifying" | "confirmed_paid" | "confirmed_unpaid" | null;
  disputeClaimedAt: string | null;
  disputeNote: string | null;
  docNumber: string | null;
  balance: string;
};

type Props = {
  invoice: DisputeInvoice;
  onChanged: () => void;
  // When provided, the "verifying" state surfaces an "Email TJ
  // bookkeeper" button that calls this (the caller opens compose
  // pre-filled). Omitted on surfaces that can't compose.
  onEmailBookkeeper?: () => void;
};

function formatClaimedDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString();
}

export function DisputeActions({ invoice, onChanged, onEmailBookkeeper }: Props) {
  // Inline note field for the "claims paid" action (collapsed by default).
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  // Inline confirm for the irreversible "Paid → Void" (voids in QBO).
  const [confirmVoid, setConfirmVoid] = useState(false);

  const invoiceId = invoice.id;

  const claimsPaid = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!invoiceId) throw new Error("invoice has no id");
      const body = note.trim() ? { note: note.trim() } : {};
      const res = await fetch(
        `/api/invoices/${encodeURIComponent(invoiceId)}/dispute/claims-paid`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const msg = await readError(res);
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      setNoteOpen(false);
      setNote("");
      onChanged();
    },
  });

  const resolvePaid = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!invoiceId) throw new Error("invoice has no id");
      const res = await fetch(
        `/api/invoices/${encodeURIComponent(invoiceId)}/dispute/resolve-paid`,
        { method: "POST" },
      );
      if (!res.ok) {
        // 502 carries { error } describing the QBO void failure; surface it.
        const msg = await readError(res);
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      setConfirmVoid(false);
      onChanged();
    },
  });

  const resolveUnpaid = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!invoiceId) throw new Error("invoice has no id");
      const res = await fetch(
        `/api/invoices/${encodeURIComponent(invoiceId)}/dispute/resolve-unpaid`,
        { method: "POST" },
      );
      if (!res.ok) {
        const msg = await readError(res);
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      onChanged();
    },
  });

  // Non-TJ rows never show dispute UI.
  if (invoice.origin !== "tj") return null;

  const state = invoice.disputeState;

  // --- confirmed_paid: terminal muted tag ------------------------------
  if (state === "confirmed_paid") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted ring-1 ring-inset ring-default">
        <Check className="size-3" />
        Voided. paid
      </span>
    );
  }

  // --- verifying: badge + note + resolve actions -----------------------
  if (state === "verifying") {
    const claimed = formatClaimedDate(invoice.disputeClaimedAt);
    const anyError =
      resolvePaid.error?.message ??
      resolveUnpaid.error?.message ??
      null;
    return (
      <div className="flex flex-col items-end gap-1 text-right">
        <Badge tone="high" className="gap-1">
          Verifying{claimed ? ` . claimed ${claimed}` : ""}
        </Badge>
        {invoice.disputeNote ? (
          <span
            className="max-w-[220px] truncate text-[11px] text-muted"
            title={invoice.disputeNote}
          >
            “{invoice.disputeNote}”
          </span>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {onEmailBookkeeper ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onEmailBookkeeper}
              title="Email the TJ bookkeeper to confirm the claim"
            >
              <Mail className="size-3.5" />
              Email TJ bookkeeper
            </Button>
          ) : null}
          {confirmVoid ? (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-accent-danger/10 px-2 py-1 ring-1 ring-inset ring-accent-danger/30">
              <span className="text-[11px] text-accent-danger">Void in QBO?</span>
              <Button
                size="sm"
                variant="danger"
                loading={resolvePaid.isPending}
                onClick={() => resolvePaid.mutate()}
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={resolvePaid.isPending}
                onClick={() => setConfirmVoid(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmVoid(true)}
              title="Confirm the customer paid TJ: voids this invoice in QuickBooks"
            >
              <Check className="size-3.5" />
              Paid. Void
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            loading={resolveUnpaid.isPending}
            onClick={() => resolveUnpaid.mutate()}
            title="Mark not paid: resumes chasing this invoice"
          >
            <Undo2 className="size-3.5" />
            Not paid
          </Button>
        </div>
        {anyError ? (
          <span className="max-w-[240px] text-right text-[11px] text-accent-danger">
            {anyError}
          </span>
        ) : null}
      </div>
    );
  }

  // --- null / confirmed_unpaid: offer to park as "claims paid" ---------
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      {noteOpen ? (
        <div className="flex flex-col items-end gap-1">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional): what did the customer say?"
            className="h-7 w-[220px] rounded-md border border-default bg-base px-2 text-xs text-primary placeholder:text-muted focus:border-strong focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              loading={claimsPaid.isPending}
              onClick={() => claimsPaid.mutate()}
            >
              Park for verify
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={claimsPaid.isPending}
              onClick={() => {
                setNoteOpen(false);
                setNote("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            "text-accent-warning hover:bg-accent-warning/10 hover:text-accent-warning",
          )}
          onClick={() => setNoteOpen(true)}
          title="Park this invoice for bookkeeper verification (customer says they paid TJ)"
        >
          Customer claims paid
        </Button>
      )}
      {claimsPaid.error ? (
        <span className="max-w-[240px] text-right text-[11px] text-accent-danger">
          {claimsPaid.error.message}
        </span>
      ) : null}
    </div>
  );
}

// Best-effort error-body reader: the dispute endpoints return
// { error } on 4xx/5xx; fall back to the status line.
async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    // non-JSON body — fall through
  }
  return `Request failed (HTTP ${res.status})`;
}
