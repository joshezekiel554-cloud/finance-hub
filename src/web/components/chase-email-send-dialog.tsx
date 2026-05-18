// ChaseEmailSendDialog — review-and-edit before firing a chase
// email. Same shape as InvoiceReminderDialog and the editable
// statement send: pre-fill from the chase_l{level} template +
// resolver, then let the operator edit subject / body / TO / CC /
// BCC before send.
//
// Level toggle (L1/L2/L3) lives inside the dialog so an operator
// who opened "Send chase" from the customer page can flip the
// dunning tone without dismissing and re-opening. Switching the
// level re-fetches the rendered preview and (if the operator hasn't
// edited yet) re-snaps the form fields. Their edits persist when
// they switch levels — but a level switch resets `edited` afterward
// so they can opt back into following the new template if they
// change levels again.
//
// Optional invoiceIds prop scopes the chase to a subset of the
// customer's open invoices instead of "all open" (the legacy
// chase-row-menu behaviour). Used by the customer-detail Invoices
// tab when the operator multi-selects rows. The backend renders
// {{open_invoices_table}} from only those rows AND only writes
// invoice_chases rows for those invoices.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, AlertCircle } from "lucide-react";
import { SignaturePicker } from "./signature-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

type ChaseLevel = 1 | 2 | 3;

const LEVEL_LABELS: Record<ChaseLevel, { label: string; tone: string }> = {
  1: { label: "L1 · gentle", tone: "Friendly first reminder" },
  2: { label: "L2 · firmer", tone: "Firmer follow-up — please action" },
  3: { label: "L3 · escalation", tone: "Escalation — final notice" },
};

type PreviewResponse = {
  subject: string;
  body: string;
  recipients: { to: string; cc: string; bcc: string };
  bccReasons: Array<{ tag: string; address: string }>;
};

export type ChaseSendSuccess = {
  customerId: string;
  level: ChaseLevel;
};

export default function ChaseEmailSendDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  level: defaultLevel,
  invoiceIds,
  onSent,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  customerId: string;
  customerName: string;
  // Initial level when the dialog mounts. The operator can switch
  // inside the dialog; this is just the starting point.
  level: ChaseLevel;
  // Optional subset of invoice ids to chase. When omitted (or
  // empty), the chase covers ALL the customer's open invoices —
  // the legacy chase-row-menu behaviour.
  invoiceIds?: string[];
  onSent: (result: ChaseSendSuccess) => void;
}) {
  const queryClient = useQueryClient();
  const [level, setLevel] = useState<ChaseLevel>(defaultLevel);
  const [userSignatureId, setUserSignatureId] = useState<string | null>(null);

  // Stable string-key for the invoice-id list — TanStack Query needs
  // a deterministic key, and array identity changes per render.
  const invoiceIdsKey = useMemo(() => {
    if (!invoiceIds || invoiceIds.length === 0) return "all";
    return [...invoiceIds].sort().join(",");
  }, [invoiceIds]);

  const previewQuery = useQuery<PreviewResponse>({
    enabled: open,
    queryKey: ["chase-preview", customerId, level, invoiceIdsKey],
    queryFn: async () => {
      const params = new URLSearchParams({
        customerId,
        level: String(level),
      });
      // Repeated `invoiceIds` params — backend's normaliseInvoiceIds
      // accepts either repeated or comma-joined.
      if (invoiceIds && invoiceIds.length > 0) {
        for (const id of invoiceIds) params.append("invoiceIds", id);
      }
      const res = await fetch(
        `/api/chase/preview-chase-email?${params.toString()}`,
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
  // True once the operator has touched any field. Blocks re-snap
  // from preview re-fetches so we don't clobber their edits when a
  // background refetch happens (or React Query refocus revalidates).
  // Reset on level switch so a fresh template body shows.
  const [edited, setEdited] = useState<boolean>(false);

  // Snap form fields to the latest preview, but only when the
  // operator hasn't started editing. Triggers on initial load AND on
  // level switch (the queryKey includes level so the data ref changes).
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

  // Reset everything on close — including level back to the prop
  // default — so re-opening is a fresh dialog session.
  useEffect(() => {
    if (!open) {
      setSubject("");
      setBody("");
      setTo("");
      setCc("");
      setBcc("");
      setEdited(false);
      setLevel(defaultLevel);
    }
  }, [open, defaultLevel]);

  // Switching level re-fetches the template; reset `edited` so the
  // re-snap effect above can pull the new template into the form.
  // This intentionally discards in-progress edits when the operator
  // changes level — the body is going to be substantially different,
  // and clobbering tweaks is more recoverable than leaving an L1 tone
  // in the form labelled "Send L3".
  function handleLevelChange(next: ChaseLevel): void {
    if (next === level) return;
    setLevel(next);
    setEdited(false);
  }

  const sendMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const d = previewQuery.data;
      const res = await fetch("/api/chase/send-chase-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId,
          level,
          // invoice subset — undefined when chasing all open
          ...(invoiceIds && invoiceIds.length > 0 ? { invoiceIds } : {}),
          // Only pass overrides when they diverge from the rendered
          // defaults — keeps the audit log honest about what the
          // operator actually changed.
          subject: subject !== d?.subject ? subject : undefined,
          body: body !== d?.body ? body : undefined,
          to: to !== d?.recipients.to ? to : undefined,
          cc: cc !== d?.recipients.cc ? cc : undefined,
          bcc: bcc !== d?.recipients.bcc ? bcc : undefined,
          userSignatureId,
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
      // Chase invalidation set: chase list, customer detail (activity
      // timeline + KPI strip pick up new email_out + lastContactedAt),
      // and the customer-invoices query (lastChasedAt now populated for
      // the chased rows). customers list also reads lastContactedAt
      // when sorted by it, so include that too.
      queryClient.invalidateQueries({ queryKey: ["chase", "customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({
        queryKey: ["customer-invoices", customerId],
      });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      onSent({ customerId, level });
      onOpenChange(false);
    },
  });

  const subsetCount = invoiceIds?.length ?? 0;
  const isSubset = subsetCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Send chase email to {customerName}
          </DialogTitle>
          <DialogDescription>
            {isSubset ? (
              <>
                Chasing {subsetCount} selected invoice
                {subsetCount === 1 ? "" : "s"}. Pre-filled from the
                chase_l{level} template — switch level or edit the wording
                before sending.
              </>
            ) : (
              <>
                Pre-filled from the chase_l{level} template covering all
                open invoices. Switch level or edit the wording before
                sending.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          {/* Level selector — 3 segmented buttons so the active level
              is one click away. Switching mid-edit drops in-progress
              tweaks (handleLevelChange resets edited). */}
          <div>
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">
              Dunning level
            </span>
            <div className="inline-flex rounded-md border border-default bg-subtle p-0.5 text-sm">
              {([1, 2, 3] as ChaseLevel[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => handleLevelChange(l)}
                  disabled={sendMutation.isPending}
                  className={cn(
                    "rounded px-3 py-1 transition-colors",
                    level === l
                      ? "bg-base font-medium text-primary shadow-sm"
                      : "text-secondary hover:text-primary disabled:cursor-not-allowed disabled:text-muted",
                  )}
                  title={LEVEL_LABELS[l].tone}
                >
                  {LEVEL_LABELS[l].label}
                </button>
              ))}
            </div>
          </div>

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
          <div className="mr-auto flex items-center gap-2">
            <span className="text-xs text-muted">Signature</span>
            <SignaturePicker value={userSignatureId} onChange={setUserSignatureId} />
          </div>
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
            {isSubset ? ` (${subsetCount} invoice${subsetCount === 1 ? "" : "s"})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
