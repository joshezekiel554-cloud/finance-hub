// RmaDenialEmailDialog — editable compose dialog for RMA denial emails.
// Same pattern as RmaApprovalEmailDialog:
//   1. Operator enters a denial reason
//   2. POST /api/rmas/:id/preview-denial-email?reason=... renders the template
//   3. Operator edits subject/body/recipients
//   4. Clicks Send → POST /api/rmas/:id/deny + POST /api/send
//
// For Phase 1 (damage) there is no eligibility PDF — just a plain text email.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, AlertCircle } from "lucide-react";
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

export type RmaDenialEmailDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  rmaId: string;
  customerId: string;
  onSent: () => void;
};

export default function RmaDenialEmailDialog({
  open,
  onOpenChange,
  rmaId,
  customerId,
  onSent,
}: RmaDenialEmailDialogProps) {
  const queryClient = useQueryClient();

  // Denial reason state — operator fills this before sending
  const [denialReason, setDenialReason] = useState("");

  // Debounced reason for the preview query key (re-fetches 500ms after
  // the operator stops typing to keep the preview current)
  const [debouncedReason, setDebouncedReason] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebouncedReason(denialReason), 500);
    return () => clearTimeout(h);
  }, [denialReason]);

  const previewQuery = useQuery<PreviewResponse>({
    enabled: open,
    queryKey: ["rma-denial-preview", rmaId, debouncedReason],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/preview-denial-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: denialReason.trim() || undefined }),
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

  // Seed from preview (skip if operator already made manual edits)
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
      setDenialReason("");
      setDebouncedReason("");
      setEdited(false);
    }
  }, [open]);

  // Deny + send mutation: first call /deny, then /api/send
  const sendMutation = useMutation<{ messageId: string }, Error, void>({
    mutationFn: async () => {
      if (!denialReason.trim()) throw new Error("Enter a denial reason before sending");
      if (!to.trim()) throw new Error("TO recipient is required");

      // Step 1: transition RMA to denied state
      const denyRes = await fetch(`/api/rmas/${rmaId}/deny`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: denialReason.trim() }),
      });
      if (!denyRes.ok) {
        const body2 = await denyRes.json().catch(() => ({})) as { error?: string };
        throw new Error(body2.error ?? `Deny failed: HTTP ${denyRes.status}`);
      }

      // Step 2: send the denial email
      const sendRes = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to,
          cc: cc.trim() || undefined,
          bcc: bcc.trim() || undefined,
          subject,
          body,
          customerId,
          refType: "rma",
          refId: rmaId,
        }),
      });
      if (!sendRes.ok) {
        const text = await sendRes.text();
        let parsed: { error?: string } | null = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not json */
        }
        throw new Error(parsed?.error ?? text ?? `HTTP ${sendRes.status}`);
      }
      return sendRes.json();
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
    denialReason.trim().length > 0 &&
    to.trim().length > 0 &&
    subject.trim().length > 0 &&
    body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send denial email</DialogTitle>
          <DialogDescription>
            Enter a denial reason, then review and edit the email before sending.
            Clicking Send will also transition the RMA to Denied status.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          {/* Denial reason — always shown first */}
          <label className="block">
            <span className="mb-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
              Denial reason
              {!denialReason.trim() && (
                <Badge tone="critical">required</Badge>
              )}
            </span>
            <textarea
              value={denialReason}
              onChange={(e) => {
                setDenialReason(e.target.value);
                setEdited(false); // allow preview to re-seed body when reason changes
              }}
              rows={3}
              placeholder="Explain why the return is being denied…"
              className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
            />
          </label>

          {previewQuery.isPending ? (
            <div className="py-2 text-center text-sm text-muted">
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
            variant="danger"
            size="sm"
            disabled={!canSend}
            loading={sendMutation.isPending}
            onClick={() => sendMutation.mutate()}
          >
            <Send className="size-3.5" />
            Deny &amp; send email
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
