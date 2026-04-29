// Email compose slide-over. Used by:
//   - email-list.tsx → reply to a customer email
//   - (future) customer-detail.tsx + chase digest etc. for outbound sends
//
// Wires together:
//   - GET /api/aliases (sendAs list)        → "From" dropdown
//   - GET /api/email-templates              → template picker (renders
//                                             via renderTemplate against
//                                             a TemplateVars from context)
//   - POST /api/email/send                  → submit
//
// Reply mode: when `context.inReplyTo` is supplied, the body is
// pre-quoted and the subject pre-fixed with "Re:". The send call carries
// the parent threadId + Message-ID so Gmail (and non-Gmail clients via
// In-Reply-To/References) thread the reply correctly.
//
// HTML escaping of user-supplied body happens server-side; this file
// only handles plain text in the textarea. The server wraps it as both
// text and html parts so the recipient's mail client picks whichever it
// prefers.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/cn";
import {
  renderTemplate,
  type TemplateVars,
} from "../../modules/email-compose/index.js";

type GmailAlias = {
  sendAsEmail: string;
  displayName: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  treatAsAlias: boolean;
  verificationStatus: string | null;
};

type EmailTemplateContext =
  | "chase"
  | "statement"
  | "payment_confirmation"
  | "generic"
  | "reply";

type EmailTemplate = {
  id: string;
  slug: string;
  name: string;
  context: EmailTemplateContext;
  subject: string;
  body: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

type AliasesResponse = { aliases: GmailAlias[] };
type TemplatesResponse = { rows: EmailTemplate[] };

export type ComposeContext = {
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  inReplyTo?: {
    messageId: string;
    threadId: string;
    subject: string;
    from: string;
    bodyExcerpt: string;
  };
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context?: ComposeContext;
};

const PREFERRED_DEFAULT_ALIAS = "accounts@feldart.com";

// Fallback variables for templates rendered against the compose context.
// We don't have full customer data on the client (balance, open invoices,
// oldest unpaid invoice) — those need a server fetch; templates that
// depend on them will render the placeholders as-is until the user fills
// them in. Keeps the modal independent of the customer-detail query.
function fallbackTemplateVars(ctx: ComposeContext | undefined): TemplateVars {
  return {
    customer_name: ctx?.customerName ?? "",
    primary_email: ctx?.customerEmail ?? "",
    open_balance: "",
    overdue_balance: "",
    days_overdue: "",
    oldest_unpaid_invoice: "",
    oldest_unpaid_amount: "",
    user_name: "",
    company_name: "Feldart",
    thread_subject: ctx?.inReplyTo?.subject ?? "",
  };
}

function formatAliasLabel(a: GmailAlias): string {
  return a.displayName
    ? `${a.displayName} <${a.sendAsEmail}>`
    : a.sendAsEmail;
}

// Pick the default From alias. Prefer accounts@feldart.com if present,
// then the alias the API marks as default, then the first verified one,
// then the first one outright.
function pickDefaultAlias(aliases: GmailAlias[]): string | null {
  if (aliases.length === 0) return null;
  const preferred = aliases.find(
    (a) => a.sendAsEmail.toLowerCase() === PREFERRED_DEFAULT_ALIAS,
  );
  if (preferred) return preferred.sendAsEmail;
  const apiDefault = aliases.find((a) => a.isDefault);
  if (apiDefault) return apiDefault.sendAsEmail;
  const verified = aliases.find(
    (a) =>
      a.verificationStatus === "accepted" || a.verificationStatus === null,
  );
  if (verified) return verified.sendAsEmail;
  return aliases[0]?.sendAsEmail ?? null;
}

function buildReplyQuoteBody(reply: ComposeContext["inReplyTo"]): string {
  if (!reply) return "";
  return `\n\n----- Original message from ${reply.from} -----\n${reply.bodyExcerpt}`;
}

export default function ComposeModal({ open, onOpenChange, context }: Props) {
  const queryClient = useQueryClient();
  const reply = context?.inReplyTo;

  const aliasesQuery = useQuery<AliasesResponse>({
    queryKey: ["aliases"],
    queryFn: async () => {
      const res = await fetch("/api/aliases");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open,
  });

  const templatesQuery = useQuery<TemplatesResponse>({
    queryKey: ["email-templates"],
    queryFn: async () => {
      const res = await fetch("/api/email-templates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open,
  });

  const aliases = aliasesQuery.data?.aliases ?? [];
  const templates = templatesQuery.data?.rows ?? [];

  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [cc, setCc] = useState<string>("");
  const [bcc, setBcc] = useState<string>("");
  const [showCcBcc, setShowCcBcc] = useState<boolean>(false);
  const [subject, setSubject] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Hydrate form fields when the modal opens, when context changes, or
  // when the aliases finish loading. We rely on a key generated from the
  // open + parent identity so re-opening the modal in reply-to mode for
  // a different message resets the form. Without this the previous
  // draft would persist across opens.
  const formKey = open
    ? `${reply?.messageId ?? "new"}::${context?.customerId ?? "anon"}`
    : "";

  useEffect(() => {
    if (!open) {
      setErrorMessage(null);
      setSelectedTemplateId("");
      return;
    }
    setTo(reply?.from ?? context?.customerEmail ?? "");
    setCc("");
    setBcc("");
    setShowCcBcc(false);
    setSubject(reply ? `Re: ${reply.subject}` : "");
    setBody(reply ? buildReplyQuoteBody(reply) : "");
    setSelectedTemplateId("");
    setErrorMessage(null);
    // formKey is the controlled re-init trigger — we don't want this
    // effect to re-fire on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  // Default the From dropdown once aliases load. We don't reset to the
  // default if the user has already picked a different alias for the
  // current open session.
  useEffect(() => {
    if (!open) return;
    if (from) return;
    const def = pickDefaultAlias(aliases);
    if (def) setFrom(def);
  }, [open, aliases, from]);

  function applyTemplate(templateId: string): void {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;
    const vars = fallbackTemplateVars(context);
    setSubject(renderTemplate(tpl.subject, vars));
    // Preserve the reply quote on the bottom when applying a template
    // mid-reply — the quoted parent is informational and shouldn't
    // disappear when the user picks a template.
    const replyQuote = buildReplyQuoteBody(reply);
    setBody(renderTemplate(tpl.body, vars) + replyQuote);
  }

  const sendMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        body,
        alias: from || undefined,
        inReplyTo: reply?.messageId,
        threadId: reply?.threadId,
        customerId: context?.customerId,
      };
      const res = await fetch("/api/email/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { messageId: string; threadId: string };
    },
    onSuccess: () => {
      if (context?.customerId) {
        queryClient.invalidateQueries({
          queryKey: ["customer-emails", context.customerId],
        });
        queryClient.invalidateQueries({
          queryKey: ["customer", context.customerId],
        });
      }
      onOpenChange(false);
    },
    onError: (err) => {
      setErrorMessage(err instanceof Error ? err.message : "Send failed");
    },
  });

  const requiredFilled =
    to.trim().length > 0 && subject.trim().length > 0 && body.trim().length > 0;
  const canSend =
    requiredFilled && from.length > 0 && !sendMutation.isPending;

  const sortedTemplates = useMemo(() => {
    return [...templates].sort((a, b) => {
      if (a.context !== b.context) return a.context.localeCompare(b.context);
      return a.name.localeCompare(b.name);
    });
  }, [templates]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "fixed left-auto right-0 top-0 z-50 flex h-full w-full max-w-2xl translate-x-0 translate-y-0 flex-col rounded-none border-l border-default bg-base p-0 shadow-xl",
        )}
      >
        <div className="flex items-start justify-between border-b border-default px-5 py-4">
          <div>
            <DialogTitle>{reply ? "Reply" : "New email"}</DialogTitle>
            {context?.customerName && (
              <p className="mt-0.5 text-xs text-secondary">
                To {context.customerName}
              </p>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-3">
            <FromField
              from={from}
              onChange={setFrom}
              aliases={aliases}
              loading={aliasesQuery.isPending}
              error={aliasesQuery.isError}
            />

            <FieldRow label="To">
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="customer@example.com"
              />
            </FieldRow>

            {!showCcBcc && (
              <button
                type="button"
                onClick={() => setShowCcBcc(true)}
                className="text-xs text-secondary hover:text-primary"
              >
                Show CC/BCC
              </button>
            )}
            {showCcBcc && (
              <>
                <FieldRow label="CC">
                  <Input
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    placeholder="comma-separated"
                  />
                </FieldRow>
                <FieldRow label="BCC">
                  <Input
                    value={bcc}
                    onChange={(e) => setBcc(e.target.value)}
                    placeholder="comma-separated"
                  />
                </FieldRow>
              </>
            )}

            <FieldRow label="Subject">
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </FieldRow>

            <FieldRow label="Template">
              <select
                value={selectedTemplateId}
                onChange={(e) => applyTemplate(e.target.value)}
                className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
              >
                <option value="">Use a template…</option>
                {templatesQuery.isPending && (
                  <option disabled>Loading…</option>
                )}
                {sortedTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    [{tpl.context}] {tpl.name}
                  </option>
                ))}
              </select>
            </FieldRow>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-secondary">
                Body
              </span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={16}
                autoFocus
                className="w-full rounded-md border border-default bg-base px-3 py-2 font-mono text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
                placeholder="Write your message…"
              />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-default px-5 py-3">
          {errorMessage && (
            <span className="mr-auto text-xs text-accent-danger">
              {errorMessage}
            </span>
          )}
          <Button
            variant="ghost"
            size="md"
            onClick={() => onOpenChange(false)}
            disabled={sendMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setErrorMessage(null);
              sendMutation.mutate();
            }}
            disabled={!canSend}
            loading={sendMutation.isPending}
          >
            <Send className="size-3.5" />
            {sendMutation.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}

function FromField({
  from,
  onChange,
  aliases,
  loading,
  error,
}: {
  from: string;
  onChange: (v: string) => void;
  aliases: GmailAlias[];
  loading: boolean;
  error: boolean;
}) {
  return (
    <FieldRow label="From">
      <select
        value={from}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
        disabled={loading || aliases.length === 0}
      >
        {loading && <option value="">Loading aliases…</option>}
        {error && <option value="">Failed to load aliases</option>}
        {!loading && aliases.length === 0 && !error && (
          <option value="">No aliases configured</option>
        )}
        {aliases.map((a) => (
          <option key={a.sendAsEmail} value={a.sendAsEmail}>
            {formatAliasLabel(a)}
            {a.verificationStatus && a.verificationStatus !== "accepted"
              ? ` (${a.verificationStatus})`
              : ""}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}
