// ChaseEmailSendDialog — review-and-edit before firing a chase
// email. Same shape as InvoiceReminderDialog and the editable
// statement send: pre-fill from the chase_l{level} template +
// resolver, then let the operator edit subject / body / TO / CC /
// BCC before send.

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

type PreviewResponse = {
  subject: string;
  body: string;
  recipients: { to: string; cc: string; bcc: string };
  bccReasons: Array<{ tag: string; address: string }>;
};

export type ChaseSendSuccess = {
  customerId: string;
  level: 1 | 2 | 3;
};

export default function ChaseEmailSendDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  level,
  onSent,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  customerId: string;
  customerName: string;
  level: 1 | 2 | 3;
  onSent: (result: ChaseSendSuccess) => void;
}) {
  const queryClient = useQueryClient();

  const previewQuery = useQuery<PreviewResponse>({
    enabled: open,
    queryKey: ["chase-preview", customerId, level],
    queryFn: async () => {
      const res = await fetch(
        `/api/chase/preview-chase-email?customerId=${encodeURIComponent(customerId)}&level=${level}`,
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 0,
  });

  const [subject, setSubject] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [cc, setCc] = useState<string>("");
  const [bcc, setBcc] = useState<string>("");
  const [edited, setEdited] = useState<boolean>(false);

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

  const sendMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const d = previewQuery.data;
      const res = await fetch("/api/chase/send-chase-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId,
          level,
          // Only pass overrides when they diverge from the rendered
          // defaults — keeps the audit log honest about what the
          // operator actually changed.
          subject: subject !== d?.subject ? subject : undefined,
          body: body !== d?.body ? body : undefined,
          to: to !== d?.recipients.to ? to : undefined,
          cc: cc !== d?.recipients.cc ? cc : undefined,
          bcc: bcc !== d?.recipients.bcc ? bcc : undefined,
        }),
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
      queryClient.invalidateQueries({ queryKey: ["chase", "customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      onSent({ customerId, level });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Send chase L{level} to {customerName}
          </DialogTitle>
          <DialogDescription>
            Pre-filled from the chase_l{level} template. Edit subject,
            body or recipients before sending if needed.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          {previewQuery.isPending ? (
            <div className="text-sm text-muted">Loading preview…</div>
          ) : previewQuery.isError ? (
            <div className="text-sm text-accent-danger">
              {(previewQuery.error as Error)?.message ?? "Preview failed"}
            </div>
          ) : (
            <>
              <label className="block">
                <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
                  TO
                </span>
                <input
                  type="text"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setEdited(true);
                  }}
                  className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
                  CC
                </span>
                <input
                  type="text"
                  value={cc}
                  onChange={(e) => {
                    setCc(e.target.value);
                    setEdited(true);
                  }}
                  className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
                  BCC
                </span>
                <input
                  type="text"
                  value={bcc}
                  onChange={(e) => {
                    setBcc(e.target.value);
                    setEdited(true);
                  }}
                  className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                />
              </label>
              {previewQuery.data &&
              previewQuery.data.bccReasons.length > 0 ? (
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
              ) : null}
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
              previewQuery.isPending ||
              previewQuery.isError ||
              to.trim().length === 0 ||
              subject.trim().length === 0 ||
              body.trim().length === 0
            }
            loading={sendMutation.isPending}
          >
            <Send className="size-3.5" />
            Send L{level}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
