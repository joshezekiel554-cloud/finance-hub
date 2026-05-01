// InvoiceSendDialog — confirm-and-send dialog for one invoice via
// QBO infrastructure. Pattern mirrors StatementSendDialog.
//
// Flow:
//   1. Open → fetches GET /api/customers/:id/invoices/:qbInvoiceId/recipients
//      which returns the resolved TO/CC/BCC for the invoice channel
//      (per-channel arrays + tag rules). Pre-fills the editable
//      chip-list fields.
//   2. Operator can add/remove TO/CC/BCC entries before sending.
//   3. Click Send → POST /api/customers/:id/invoices/:qbInvoiceId/send
//      with the final {to, cc, bcc} so the server's "what was sent"
//      record matches what the operator confirmed.
//   4. On success: closes the dialog, fires onSent for the parent's
//      success pill, invalidates ["customer", customerId] +
//      ["customer-invoices", customerId] so the timeline + invoice
//      list pick up the new qbo_invoice_sent row.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, X, AlertCircle } from "lucide-react";
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

export type InvoiceSendSuccess = {
  qbInvoiceId: string;
  docNumber: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
};

type RecipientsResponse = {
  to: string[];
  cc: string[];
  bcc: string[];
  bccReasons: Array<{ tag: string; address: string }>;
};

export default function InvoiceSendDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  invoice,
  docType = "invoice",
  onSent,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  customerId: string;
  customerName: string;
  invoice: {
    qbInvoiceId: string;
    docNumber: string | null;
    total: string;
    balance: string;
    issueDate: string | null;
    dueDate: string | null;
  };
  // Whether the doc is an Invoice (default) or a Credit memo.
  // Routed through to the server's send body so the right QBO
  // /send endpoint fires.
  docType?: "invoice" | "credit_memo";
  onSent: (result: InvoiceSendSuccess) => void;
}) {
  const queryClient = useQueryClient();
  const recipientsQuery = useQuery<RecipientsResponse>({
    enabled: open,
    queryKey: [
      "invoice-recipients",
      customerId,
      invoice.qbInvoiceId,
    ],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/invoices/${encodeURIComponent(invoice.qbInvoiceId)}/recipients`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 0,
  });

  // Editable buffers — seeded from the resolved recipients each time
  // the dialog opens. Operator's last-minute add/remove is in here
  // until they hit Send.
  const [toDraft, setToDraft] = useState<string[]>([]);
  const [ccDraft, setCcDraft] = useState<string[]>([]);
  const [bccDraft, setBccDraft] = useState<string[]>([]);

  useEffect(() => {
    if (recipientsQuery.data) {
      setToDraft(recipientsQuery.data.to);
      setCcDraft(recipientsQuery.data.cc);
      setBccDraft(recipientsQuery.data.bcc);
    }
  }, [recipientsQuery.data]);

  // Reset on close so re-open re-fetches fresh.
  useEffect(() => {
    if (!open) {
      setToDraft([]);
      setCcDraft([]);
      setBccDraft([]);
    }
  }, [open]);

  const sendMutation = useMutation<
    { qbInvoiceId: string; docNumber: string | null },
    Error,
    void
  >({
    mutationFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/invoices/${encodeURIComponent(invoice.qbInvoiceId)}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            docType,
            to: toDraft,
            cc: ccDraft,
            bcc: bccDraft,
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        let body: { error?: string } | null = null;
        try {
          body = JSON.parse(text) as { error?: string };
        } catch {
          /* not json */
        }
        throw new Error(body?.error ?? text ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      // Refresh anything that depends on the invoice or the
      // customer's activity feed.
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({
        queryKey: ["customer-invoices", customerId],
      });
      onSent({
        qbInvoiceId: data.qbInvoiceId,
        docNumber: data.docNumber,
        to: toDraft,
        cc: ccDraft,
        bcc: bccDraft,
      });
      onOpenChange(false);
    },
  });

  const total = Number(invoice.total);
  const balance = Number(invoice.balance);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Send {docType === "credit_memo" ? "credit memo" : "invoice"}
            {invoice.docNumber ? ` ${invoice.docNumber}` : ""}
          </DialogTitle>
          <DialogDescription>
            QuickBooks will email it from your QBO account using the
            addresses below. Edit before sending if needed.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div className="rounded-md border border-default bg-subtle px-3 py-2 text-xs">
            <div className="font-medium">{customerName}</div>
            <div className="mt-0.5 flex flex-wrap gap-3 text-muted">
              <span>
                Total{" "}
                <span className="text-primary tabular-nums">
                  ${total.toFixed(2)}
                </span>
              </span>
              {balance > 0 ? (
                <span>
                  Open balance{" "}
                  <span className="text-accent-warning tabular-nums">
                    ${balance.toFixed(2)}
                  </span>
                </span>
              ) : null}
              {invoice.issueDate ? (
                <span>Issued {invoice.issueDate}</span>
              ) : null}
              {invoice.dueDate ? <span>Due {invoice.dueDate}</span> : null}
            </div>
          </div>

          {recipientsQuery.isPending ? (
            <div className="text-sm text-muted">Resolving recipients…</div>
          ) : recipientsQuery.isError ? (
            <div className="text-sm text-accent-danger">
              Couldn't load recipients —{" "}
              {(recipientsQuery.error as Error)?.message ?? "unknown error"}
            </div>
          ) : (
            <>
              <ChipListField
                label="TO"
                values={toDraft}
                onChange={setToDraft}
                placeholder="add TO and press enter"
              />
              <ChipListField
                label="CC"
                values={ccDraft}
                onChange={setCcDraft}
                placeholder="add CC and press enter"
              />
              <ChipListField
                label="BCC"
                values={bccDraft}
                onChange={setBccDraft}
                placeholder="add BCC and press enter"
              />
              {recipientsQuery.data &&
              recipientsQuery.data.bccReasons.length > 0 ? (
                <div className="rounded-md border border-default bg-subtle px-2 py-1 text-[11px] text-secondary">
                  <div className="text-accent-info">
                    Tag-derived BCC{" "}
                    <span className="text-muted">
                      (already included above)
                    </span>
                  </div>
                  <ul className="ml-3 list-disc">
                    {recipientsQuery.data.bccReasons.map((r, i) => (
                      <li key={i}>
                        {r.address}{" "}
                        <span className="text-muted">({r.tag})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}

          {sendMutation.isError ? (
            <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div>{(sendMutation.error as Error).message}</div>
            </div>
          ) : null}
        </div>

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
            variant="primary"
            size="sm"
            onClick={() => sendMutation.mutate()}
            disabled={
              sendMutation.isPending ||
              recipientsQuery.isPending ||
              recipientsQuery.isError ||
              toDraft.length === 0
            }
            loading={sendMutation.isPending}
          >
            <Send className="size-3.5" />
            Send via QuickBooks
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Local chip-list editor — inline so the dialog stays self-contained.
// Email validation is loose (relies on server-side Zod email check);
// here we just trim + dedupe.
function ChipListField({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState<string>("");

  function add() {
    const v = input.trim();
    if (!v) return;
    if (values.some((e) => e.toLowerCase() === v.toLowerCase())) {
      setInput("");
      return;
    }
    onChange([...values, v]);
    setInput("");
  }
  function remove(addr: string) {
    onChange(values.filter((e) => e.toLowerCase() !== addr.toLowerCase()));
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          {label}
        </span>
        {values.length === 0 && label === "TO" ? (
          <Badge tone="critical">required</Badge>
        ) : null}
      </div>
      {values.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {values.map((addr) => (
            <span
              key={addr}
              className="inline-flex items-center gap-1 rounded-md border border-default bg-subtle px-1.5 py-0.5 text-[11px]"
            >
              {addr}
              <button
                type="button"
                onClick={() => remove(addr)}
                className="text-muted hover:text-accent-danger"
                aria-label={`Remove ${addr}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex gap-1">
        <input
          type="email"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-default bg-base px-2 py-1 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={add}
          disabled={!input.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
