// InvoiceReminderDialog — per-invoice nudge with the PDF attached
// and a fully-editable compose surface (recipients / subject / body).
// Distinct from InvoiceSendDialog (which calls QBO's /send and uses
// QBO's invoice-email template) — this one composes a plain email
// from finance-hub's invoice_reminder template and attaches the PDF
// via /api/send. Activity row tags refType:invoice + refId so the
// customer timeline picks it up alongside other email_out events.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, X, Paperclip, AlertCircle } from "lucide-react";
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
import { renderTemplate } from "../../modules/email-compose/index.js";

type RecipientsResponse = {
  to: string[];
  cc: string[];
  bcc: string[];
  bccReasons: Array<{ tag: string; address: string }>;
};

type EmailTemplate = {
  id: string;
  slug: string;
  name: string;
  context: string;
  subject: string;
  body: string;
};

type TemplatesResponse = { rows: EmailTemplate[] };

type MeResponse = { user: { id: string; name: string | null } };

export type InvoiceReminderSuccess = {
  qbInvoiceId: string;
  docNumber: string | null;
};

const COMPANY_NAME = "Feldart";

export default function InvoiceReminderDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  invoice,
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
  onSent: (result: InvoiceReminderSuccess) => void;
}) {
  const queryClient = useQueryClient();

  const recipientsQuery = useQuery<RecipientsResponse>({
    enabled: open,
    queryKey: ["invoice-recipients", customerId, invoice.qbInvoiceId],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/invoices/${encodeURIComponent(invoice.qbInvoiceId)}/recipients`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 0,
  });

  const templatesQuery = useQuery<TemplatesResponse>({
    enabled: open,
    queryKey: ["email-templates"],
    queryFn: async () => {
      const res = await fetch("/api/email-templates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const meQuery = useQuery<MeResponse>({
    enabled: open,
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 60_000,
  });

  // Auto-fetch the invoice PDF when the dialog opens, encode to
  // base64 for the /api/send attachment payload. Fires in parallel
  // with the other queries so by the time the operator's reading
  // the body, the PDF is ready.
  const pdfQuery = useQuery<{ data: string; size: number }>({
    enabled: open,
    queryKey: ["invoice-pdf", invoice.qbInvoiceId],
    queryFn: async () => {
      const res = await fetch(
        `/api/qb-pdf/invoice/${encodeURIComponent(invoice.qbInvoiceId)}`,
      );
      if (!res.ok) throw new Error(`PDF fetch failed: HTTP ${res.status}`);
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () =>
          reject(r.error ?? new Error("failed to read PDF"));
        r.readAsDataURL(blob);
      });
      // strip the "data:application/pdf;base64," prefix
      const base64 = dataUrl.split(",", 2)[1] ?? "";
      return { data: base64, size: blob.size };
    },
    staleTime: 5 * 60_000,
  });

  // Editable buffers.
  const [toDraft, setToDraft] = useState<string[]>([]);
  const [ccDraft, setCcDraft] = useState<string[]>([]);
  const [bccDraft, setBccDraft] = useState<string[]>([]);
  const [subject, setSubject] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [includeAttachment, setIncludeAttachment] = useState<boolean>(true);

  // Seed recipients from resolver each time the dialog opens.
  useEffect(() => {
    if (recipientsQuery.data) {
      setToDraft(recipientsQuery.data.to);
      setCcDraft(recipientsQuery.data.cc);
      setBccDraft(recipientsQuery.data.bcc);
    }
  }, [recipientsQuery.data]);

  // Seed subject + body from the invoice_reminder template once the
  // template list lands. Template variables are rendered with
  // invoice + customer + user context. Body intentionally re-renders
  // when any of those change so the preview stays accurate until
  // the operator types into the editor — we skip the re-render once
  // they've started editing (tracked via the edited flag below).
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (edited) return;
    const tpl = (templatesQuery.data?.rows ?? []).find(
      (t) => t.slug === "invoice_reminder",
    );
    if (!tpl) return;
    const userName = meQuery.data?.user.name ?? "";
    const total = Number(invoice.total).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
    const balance = Number(invoice.balance).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
    const vars: Record<string, string> = {
      customer_name: customerName,
      user_name: userName,
      company_name: COMPANY_NAME,
      invoice_number: invoice.docNumber ?? invoice.qbInvoiceId,
      invoice_total: total,
      invoice_balance: balance,
      invoice_issue_date: invoice.issueDate ?? "—",
      invoice_due_date: invoice.dueDate ?? "—",
    };
    setSubject(renderTemplate(tpl.subject, vars));
    setBody(renderTemplate(tpl.body, vars));
  }, [
    templatesQuery.data,
    meQuery.data,
    customerName,
    invoice.docNumber,
    invoice.qbInvoiceId,
    invoice.total,
    invoice.balance,
    invoice.issueDate,
    invoice.dueDate,
    edited,
  ]);

  // Reset on close so reopen re-fetches + re-seeds.
  useEffect(() => {
    if (!open) {
      setToDraft([]);
      setCcDraft([]);
      setBccDraft([]);
      setSubject("");
      setBody("");
      setEdited(false);
      setIncludeAttachment(true);
    }
  }, [open]);

  const sendMutation = useMutation<
    { messageId: string },
    Error,
    void
  >({
    mutationFn: async () => {
      const filename = `Invoice-${invoice.docNumber ?? invoice.qbInvoiceId}.pdf`;
      const attachments =
        includeAttachment && pdfQuery.data
          ? [
              {
                filename,
                mimeType: "application/pdf",
                dataBase64: pdfQuery.data.data,
              },
            ]
          : undefined;
      const payload = {
        to: toDraft.join(", "),
        cc: ccDraft.length > 0 ? ccDraft.join(", ") : undefined,
        bcc: bccDraft.length > 0 ? bccDraft.join(", ") : undefined,
        subject,
        body,
        customerId,
        attachments,
        // Tag the activity row this send produces with the invoice
        // ref so the customer timeline shows it under the right doc.
        refType: "invoice",
        refId: invoice.qbInvoiceId,
      };
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } | null = null;
        try {
          parsed = JSON.parse(text) as { error?: string };
        } catch {
          /* not json */
        }
        throw new Error(parsed?.error ?? text ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({
        queryKey: ["customer-invoices", customerId],
      });
      queryClient.invalidateQueries({
        queryKey: ["customer-emails", customerId],
      });
      onSent({
        qbInvoiceId: invoice.qbInvoiceId,
        docNumber: invoice.docNumber,
      });
      onOpenChange(false);
    },
  });

  const blocked =
    sendMutation.isPending ||
    recipientsQuery.isPending ||
    toDraft.length === 0 ||
    subject.trim().length === 0 ||
    body.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Send reminder
            {invoice.docNumber ? ` — Invoice ${invoice.docNumber}` : ""}
          </DialogTitle>
          <DialogDescription>
            Pre-filled from the {`"`}invoice_reminder{`"`} template.
            Edit anything before sending. Goes via finance-hub's Gmail
            (not QBO's invoice-email template).
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div className="rounded-md border border-default bg-subtle px-3 py-2 text-xs">
            <div className="font-medium">{customerName}</div>
            <div className="mt-0.5 flex flex-wrap gap-3 text-muted">
              <span>
                Total{" "}
                <span className="text-primary tabular-nums">
                  ${Number(invoice.total).toFixed(2)}
                </span>
              </span>
              <span>
                Balance{" "}
                <span className="text-accent-warning tabular-nums">
                  ${Number(invoice.balance).toFixed(2)}
                </span>
              </span>
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
              Couldn't resolve recipients —{" "}
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
                      (already in the list above)
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

          <label className="block">
            <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
              Subject
            </span>
            <input
              type="text"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setEdited(true);
              }}
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
              Body
            </span>
            <textarea
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setEdited(true);
              }}
              rows={10}
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>

          <div className="flex items-center justify-between rounded-md border border-default bg-subtle px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <Paperclip className="size-3.5 text-muted" />
              <span>
                {pdfQuery.isPending ? (
                  <span className="text-muted">
                    Loading invoice PDF…
                  </span>
                ) : pdfQuery.isError ? (
                  <span className="text-accent-danger">
                    PDF fetch failed —{" "}
                    {(pdfQuery.error as Error)?.message ?? "unknown error"}
                  </span>
                ) : (
                  <>
                    <span className="font-medium">
                      Invoice-
                      {invoice.docNumber ?? invoice.qbInvoiceId}.pdf
                    </span>
                    {pdfQuery.data ? (
                      <span className="ml-2 text-muted">
                        ({Math.round(pdfQuery.data.size / 1024)} KB)
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-1 text-secondary">
              <input
                type="checkbox"
                checked={includeAttachment}
                onChange={(e) => setIncludeAttachment(e.target.checked)}
                disabled={pdfQuery.isPending || pdfQuery.isError}
              />
              <span>Attach</span>
            </label>
          </div>

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
            disabled={blocked}
            loading={sendMutation.isPending}
          >
            <Send className="size-3.5" />
            Send reminder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Local chip-list editor for the recipient fields. Same shape as the
// one in invoice-send-dialog but kept inline here so this dialog
// is self-contained.
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
