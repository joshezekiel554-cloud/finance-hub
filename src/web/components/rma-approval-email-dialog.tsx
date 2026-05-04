// RmaApprovalEmailDialog — editable compose dialog shown after an RMA is
// approved. Fetches the rendered approval email preview from the backend
// (POST /api/rmas/:id/preview-approval-email), shows subject + body +
// recipients (all editable), and sends via /api/send with refType="rma".
//
// Pattern mirrors ChaseEmailSendDialog exactly: preview query → seed
// local buffers → operator edits → Send mutation.

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

type PreviewResponse = {
  subject: string;
  body: string;
  recipients: { to: string; cc: string; bcc: string };
  bccReasons: Array<{ tag: string; address: string }>;
};

export type RmaApprovalEmailDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  rmaId: string;
  rmaNumber: string;
  customerId: string;
  onSent: () => void;
  /**
   * When set (override-approval path), the eligibility PDF with this Drive ID
   * is fetched and its URL included in the email send payload so the backend
   * can attach it.
   */
  pdfDriveId?: string | null;
};

export default function RmaApprovalEmailDialog({
  open,
  onOpenChange,
  rmaId,
  rmaNumber,
  customerId,
  onSent,
  pdfDriveId = null,
}: RmaApprovalEmailDialogProps) {
  const queryClient = useQueryClient();

  const previewQuery = useQuery<PreviewResponse>({
    enabled: open,
    queryKey: ["rma-approval-preview", rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/preview-approval-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } | null = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not json */
        }
        throw new Error(parsed?.error ?? text ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 0,
  });

  // Editable buffers
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [edited, setEdited] = useState(false);

  // Seed from preview when it lands (skip if operator already edited)
  useEffect(() => {
    if (edited) return;
    const d = previewQuery.data;
    if (!d) return;
    setSubject(d.subject);
    setBody(d.body);
    setTo(d.recipients.to);
    setCc(d.recipients.cc);
    setBcc(d.recipients.bcc);
  }, [previewQuery.data, edited]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setSubject("");
      setBody("");
      setTo("");
      setCc("");
      setBcc("");
      setEdited(false);
    }
  }, [open]);

  const sendMutation = useMutation<{ messageId: string }, Error, void>({
    mutationFn: async () => {
      if (!to.trim()) throw new Error("TO recipient is required");
      const payload: Record<string, unknown> = {
        to,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject,
        body,
        customerId,
        refType: "rma",
        refId: rmaId,
      };
      if (pdfDriveId) {
        payload.attachmentDriveId = pdfDriveId;
      }
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } | null = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not json */
        }
        throw new Error(parsed?.error ?? text ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      onSent();
      onOpenChange(false);
    },
  });

  const canSend =
    !sendMutation.isPending &&
    !previewQuery.isPending &&
    to.trim().length > 0 &&
    subject.trim().length > 0 &&
    body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send approval email — RMA {rmaNumber}</DialogTitle>
          <DialogDescription>
            Pre-filled from the rma-approval template. Edit subject, body, or
            recipients before sending.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          {previewQuery.isPending ? (
            <div className="py-4 text-center text-sm text-muted">
              Loading email preview…
            </div>
          ) : previewQuery.isError ? (
            <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {(previewQuery.error as Error)?.message ?? "Preview failed"}
            </div>
          ) : (
            <>
              <RecipientField
                label="TO"
                value={to}
                onChange={(v) => { setTo(v); setEdited(true); }}
                required
              />
              <RecipientField
                label="CC"
                value={cc}
                onChange={(v) => { setCc(v); setEdited(true); }}
              />
              <RecipientField
                label="BCC"
                value={bcc}
                onChange={(v) => { setBcc(v); setEdited(true); }}
              />

              {previewQuery.data && previewQuery.data.bccReasons.length > 0 && (
                <div className="rounded-md border border-default bg-subtle px-2 py-1 text-[11px] text-secondary">
                  <div className="text-accent-info">
                    Tag-derived BCC{" "}
                    <span className="text-muted">(in BCC list above)</span>
                  </div>
                  <ul className="ml-3 list-disc">
                    {previewQuery.data.bccReasons.map((r, i) => (
                      <li key={i}>
                        {r.address}{" "}
                        <span className="text-muted">({r.tag})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <label className="block">
                <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
                  Subject
                </span>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => { setSubject(e.target.value); setEdited(true); }}
                  className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                />
              </label>

              <label className="block">
                <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
                  Body
                </span>
                <textarea
                  value={body}
                  onChange={(e) => { setBody(e.target.value); setEdited(true); }}
                  rows={12}
                  className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                />
              </label>
            </>
          )}

          {sendMutation.isError && (
            <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {(sendMutation.error as Error).message}
            </div>
          )}
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
            disabled={!canSend}
            loading={sendMutation.isPending}
            onClick={() => sendMutation.mutate()}
          >
            <Send className="size-3.5" />
            Send approval email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Shared recipient field ------------------------------------------------

function RecipientField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
        {label}
        {required && !value.trim() && (
          <Badge tone="critical">required</Badge>
        )}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
        placeholder={`${label} address(es), comma-separated`}
      />
    </label>
  );
}

// Suppress unused X import — kept for future chip-list UI parity
void X;
