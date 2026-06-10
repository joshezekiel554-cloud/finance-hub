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

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Send, Sparkles } from "lucide-react";
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
import { EditorField } from "./editor-field";
import { SignaturePicker } from "./signature-picker";

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
    // When set (Reply all path), prefills the cc field. Comma-separated,
    // already filtered to drop our own outbound addresses + the original
    // sender (which goes to the To field instead).
    cc?: string;
  };
  // When the composer is opened to edit-and-send an AI autopilot draft:
  // seeds the subject + body, and tags the resulting email_log row +
  // closes out the proposal via onSent.
  prefill?: {
    subject: string;
    bodyHtml: string;
    alias?: string;
  };
  aiProposalId?: string;
  // NOTE: AI proposals + customer-card actions carry an `origin`
  // ('feldart' | 'tj') as of osplit2 W2 T5, but compose has no origin param —
  // if compose ever needs book-aware behaviour (template book, default
  // statement book), origin would enter HERE (T5 review accepted the gap).
  // When this compose is a TJ-dispute bookkeeper email (wind-down panel /
  // customer-detail dispute buttons), the invoice under verification. The
  // send body forwards it so the server records the resulting Gmail
  // threadId on invoices.bookkeeper_thread_id (dispute-nudge detection).
  disputeInvoiceId?: string;
  // When set, the compose modal renders an "AI draft" panel (notes + Generate)
  // that POSTs to /api/email-log/<id>/draft-reply. Distinct from inReplyTo:
  // inReplyTo carries the threading metadata for the outbound; this is the
  // inbound-row handle the AI uses to load thread + customer context.
  draftReplyForEmailLogId?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context?: ComposeContext;
  // Fired after a successful send. Used by the autopilot edit-and-send
  // flow to mark the proposal executed once the composer has sent.
  onSent?: (result: { messageId: string; threadId: string }) => void;
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
    unapplied_credit_balance: "",
    overdue_credit_note: "",
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

// Lightweight HTML escape — used when injecting unescaped strings
// (reply body excerpts, plain-text template content) into editor HTML.
function escapeHtmlForEditor(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Convert plain text (e.g. an email_template body, which is stored as
// plain text) into editor-friendly HTML. Mirrors the server-side
// bodyToHtml: blank-line-separated chunks → <p>, single newlines →
// <br/>. Output flows into the TipTap editor as initial content;
// operators can then format further.
function plainTextToHtml(raw: string): string {
  if (!raw) return "";
  const escaped = escapeHtmlForEditor(raw);
  const paragraphs = escaped.split(/\n{2,}/);
  return paragraphs
    .map((p) => `<p>${p.replace(/\n/g, "<br/>") || "<br/>"}</p>`)
    .join("");
}

// Build the reply-quote block as HTML (TipTap-compatible). Renders as
// a divider line + the original sender header + a <blockquote> with
// the parent body. Operators can edit inside or outside the quote.
function buildReplyQuoteHtml(reply: ComposeContext["inReplyTo"]): string {
  if (!reply) return "";
  const fromEsc = escapeHtmlForEditor(reply.from);
  const bodyEsc = escapeHtmlForEditor(reply.bodyExcerpt).replace(
    /\n/g,
    "<br/>",
  );
  return `<p></p><p>----- Original message from ${fromEsc} -----</p><blockquote>${bodyEsc}</blockquote>`;
}

export default function ComposeModal({ open, onOpenChange, context, onSent }: Props) {
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
  // Attachments selected for this send. Stored as File so we can show
  // size/name in the chip; serialised to base64 only at send time.
  const [attachments, setAttachments] = useState<File[]>([]);
  const [userSignatureId, setUserSignatureId] = useState<string | null>(null);
  // AI draft panel — only used when context.draftReplyForEmailLogId is set.
  // aiNotes is the operator's optional steer ("send back X, sorry Y"); empty
  // string means a clean draft. generating is the per-call spinner.
  const [aiNotes, setAiNotes] = useState<string>("");
  const [generating, setGenerating] = useState<boolean>(false);

  // Hydrate form fields when the modal opens, when context changes, or
  // when the aliases finish loading. We rely on a key generated from the
  // open + parent identity so re-opening the modal in reply-to mode for
  // a different message resets the form. Without this the previous
  // draft would persist across opens.
  const prefill = context?.prefill;
  const formKey = open
    ? `${reply?.messageId ?? "new"}::${context?.customerId ?? "anon"}::${context?.aiProposalId ?? ""}`
    : "";

  useEffect(() => {
    if (!open) {
      setErrorMessage(null);
      setSelectedTemplateId("");
      return;
    }
    setTo(reply?.from ?? context?.customerEmail ?? "");
    // Reply-all prefills the cc; otherwise start blank.
    setCc(reply?.cc ?? "");
    setBcc("");
    setShowCcBcc(Boolean(reply?.cc));
    // Prefill (autopilot edit-and-send) wins over reply/empty seeding.
    if (prefill) {
      setSubject(prefill.subject);
      setBody(prefill.bodyHtml);
    } else {
      setSubject(reply ? `Re: ${reply.subject}` : "");
      setBody(reply ? buildReplyQuoteHtml(reply) : "");
    }
    setSelectedTemplateId("");
    setErrorMessage(null);
    setAttachments([]);
    setUserSignatureId(null);
    setAiNotes("");
    setGenerating(false);
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
    // Prefill alias (autopilot draft was scoped to a specific sending
    // alias) takes precedence over the generic default.
    if (prefill?.alias) {
      setFrom(prefill.alias);
      return;
    }
    const def = pickDefaultAlias(aliases);
    if (def) setFrom(def);
  }, [open, aliases, from, prefill?.alias]);

  async function handleGenerateAiDraft(): Promise<void> {
    const sourceId = context?.draftReplyForEmailLogId;
    if (!sourceId) return;
    // Confirm replacing existing body content. We treat the reply quote
    // alone as empty for this check (the quote auto-renders on reply mode
    // and isn't "the operator's draft"). If the operator has typed real
    // content, ask before overwriting.
    const replyQuoteOnly = buildReplyQuoteHtml(reply);
    const hasUserContent =
      body.trim().length > 0 && body.trim() !== replyQuoteOnly.trim();
    if (hasUserContent) {
      const ok =
        typeof window !== "undefined" &&
        window.confirm("Replace the current draft with a fresh AI draft?");
      if (!ok) return;
    }
    setGenerating(true);
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/email-log/${encodeURIComponent(sourceId)}/draft-reply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            aiNotes.trim().length > 0 ? { notes: aiNotes.trim() } : {},
          ),
        },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { subject: string; body: string };
      // The model returns plain prose with blank-line paragraphs. Convert
      // to TipTap-friendly HTML and re-append the reply quote so the
      // operator still sees the parent message at the bottom.
      const draftHtml = plainTextToHtml(data.body) + buildReplyQuoteHtml(reply);
      setSubject(data.subject);
      setBody(draftHtml);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "AI draft failed",
      );
    } finally {
      setGenerating(false);
    }
  }

  function applyTemplate(templateId: string): void {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;
    const vars = fallbackTemplateVars(context);
    setSubject(renderTemplate(tpl.subject, vars));
    // Templates are stored as plain text — convert to HTML for the
    // editor. Preserve the reply quote on the bottom; the quoted parent
    // is informational and shouldn't disappear when the user picks a
    // template.
    const renderedBodyHtml = plainTextToHtml(renderTemplate(tpl.body, vars));
    const replyQuote = buildReplyQuoteHtml(reply);
    setBody(renderedBodyHtml + replyQuote);
  }

  const sendMutation = useMutation({
    mutationFn: async () => {
      // Encode any attached files to base64 before serialising the
      // payload — /api/send expects { filename, mimeType, dataBase64 }.
      const encodedAttachments = attachments.length
        ? await Promise.all(
            attachments.map(async (f) => ({
              filename: f.name,
              mimeType: f.type || "application/octet-stream",
              dataBase64: await fileToBase64(f),
            })),
          )
        : undefined;
      const payload = {
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        body,
        // Body is HTML from the TipTap editor — server runs sanitize-html
        // before using as the html part and derives a plain-text version
        // for the multipart text/plain part.
        isHtml: true,
        alias: from || undefined,
        inReplyTo: reply?.messageId,
        threadId: reply?.threadId,
        customerId: context?.customerId,
        attachments: encodedAttachments,
        userSignatureId,
        aiProposalId: context?.aiProposalId,
        disputeInvoiceId: context?.disputeInvoiceId,
      };
      const res = await fetch("/api/send", {
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
    onSuccess: (result) => {
      if (context?.customerId) {
        queryClient.invalidateQueries({
          queryKey: ["customer-emails", context.customerId],
        });
        queryClient.invalidateQueries({
          queryKey: ["customer", context.customerId],
        });
      }
      onSent?.(result);
      onOpenChange(false);
    },
    onError: (err) => {
      setErrorMessage(err instanceof Error ? err.message : "Send failed");
    },
  });

  // Body is HTML now — an "empty" editor still produces "<p></p>" or
  // similar whitespace markup. Strip tags + trim to test for actual
  // content before enabling Send.
  const bodyHasContent = body.replace(/<[^>]*>/g, "").trim().length > 0;
  const requiredFilled =
    to.trim().length > 0 && subject.trim().length > 0 && bodyHasContent;
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
          // Mobile: full-screen (inset-0, no left border, no max width).
          // Desktop: slide-over from the right edge with max-w-2xl.
          "fixed z-50 flex flex-col bg-base p-0 shadow-xl",
          "inset-0 rounded-none",
          "md:left-auto md:right-0 md:top-0 md:bottom-auto md:h-full md:w-full md:max-w-2xl md:border-l md:border-default",
          // The base DialogContent centers normal dialogs with
          // `-translate-x-1/2 -translate-y-1/2`. This modal anchors itself
          // instead (inset-0 / md:right-0 md:top-0), so that inherited
          // translate must be cancelled — otherwise the container is shifted
          // up by half its (full-viewport) height, pushing the header and the
          // Send footer off-screen ("opens too high, can't see it or send").
          "translate-x-0 translate-y-0",
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

            {context?.draftReplyForEmailLogId && (
              <div className="rounded-md border border-accent-primary/30 bg-accent-primary/5 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Sparkles className="size-3.5 text-accent-primary" />
                  AI draft
                </div>
                <textarea
                  value={aiNotes}
                  onChange={(e) => setAiNotes(e.target.value)}
                  placeholder="Notes for AI (optional) — leave blank for a clean draft. e.g. 'send back X, sorry Y, will get sorted'"
                  className="w-full resize-y rounded-md border border-default bg-base p-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
                  rows={2}
                  disabled={generating}
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-muted">
                    Uses voice guide, facts, customer context + thread history.
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleGenerateAiDraft}
                    disabled={generating}
                  >
                    <Sparkles className="size-3.5" />
                    {generating ? "Generating…" : "Generate"}
                  </Button>
                </div>
              </div>
            )}

            <div>
              <span className="mb-1 block text-xs font-medium text-secondary">
                Body
              </span>
              {/* TipTap-powered editor — see editor-field.tsx. resetKey
                  is the formKey + selectedTemplateId so the editor
                  reloads its content when the operator opens a fresh
                  compose session OR picks a template (both swap the
                  body wholesale). Mid-typing edits stay sticky. */}
              <EditorField
                value={body}
                onChange={setBody}
                placeholder="Write your message…"
                resetKey={`${formKey}::${selectedTemplateId}`}
              />
            </div>

            <AttachmentsField
              attachments={attachments}
              onChange={setAttachments}
              customerId={context?.customerId}
            />
          </div>
        </div>

        {/* Footer action row. On mobile, the row sits at the viewport
            bottom with safe-area-inset padding for the iOS home
            indicator and a translucent backdrop so the body content
            scrolling beneath remains visible. The Signature label is
            hidden on mobile to leave room for Cancel + Send. */}
        <div
          className={cn(
            "flex flex-wrap items-center justify-end gap-2 border-t border-default px-4 py-3 md:px-5",
            "bg-base/95 backdrop-blur supports-[backdrop-filter]:bg-base/85",
            "pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-3",
          )}
        >
          <div className="mr-auto flex items-center gap-2">
            <span className="hidden text-xs text-muted md:inline">Signature</span>
            <SignaturePicker value={userSignatureId} onChange={setUserSignatureId} />
          </div>
          {errorMessage && (
            <span className="text-xs text-accent-danger">
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

// Compact file-picker + chip list for outbound attachments. Backend
// /api/send caps at 20 files; we don't enforce client-side beyond a
// reasonable per-file size warning.
//
// When a customerId is supplied (compose-modal mode), a second button
// surfaces the customer's existing QBO docs (invoices, credit memos)
// + an open-items statement PDF. Picking one fetches the PDF
// server-side and wraps it in a File object so the existing base64-
// encode + send pipeline doesn't change shape.
function AttachmentsField({
  attachments,
  onChange,
  customerId,
}: {
  attachments: File[];
  onChange: (next: File[]) => void;
  customerId?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [docPickerOpen, setDocPickerOpen] = useState(false);

  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-secondary">
        Attachments
      </span>
      <div className="space-y-1.5">
        {attachments.map((f, i) => (
          <div
            key={`${f.name}-${i}`}
            className="flex items-center justify-between rounded-md border border-default bg-elevated px-2 py-1 text-xs"
          >
            <span className="truncate">
              <span className="font-medium">{f.name}</span>
              <span className="ml-2 text-muted">
                {formatFileSize(f.size)}
                {f.type ? ` · ${f.type}` : ""}
              </span>
            </span>
            <button
              type="button"
              className="ml-2 shrink-0 text-muted hover:text-accent-danger"
              onClick={() =>
                onChange(attachments.filter((_, j) => j !== i))
              }
              aria-label={`Remove ${f.name}`}
            >
              ×
            </button>
          </div>
        ))}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files ? Array.from(e.target.files) : [];
            // Reset value so the same file can be re-picked after a remove.
            e.target.value = "";
            if (picked.length === 0) return;
            onChange([...attachments, ...picked]);
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md border border-default bg-base px-2 py-1 text-xs text-secondary hover:bg-elevated"
          >
            <Paperclip className="size-3" />
            {attachments.length === 0 ? "Attach files" : "Add more"}
          </button>
          {customerId ? (
            <button
              type="button"
              onClick={() => setDocPickerOpen((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-default px-2 py-1 text-xs text-secondary hover:bg-elevated",
                docPickerOpen ? "bg-elevated" : "bg-base",
              )}
            >
              <Paperclip className="size-3" />
              {docPickerOpen ? "Hide customer docs" : "Attach customer doc"}
            </button>
          ) : null}
        </div>
        {docPickerOpen && customerId ? (
          <CustomerDocPicker
            customerId={customerId}
            attachedFilenames={new Set(attachments.map((f) => f.name))}
            onPick={(file) => onChange([...attachments, file])}
          />
        ) : null}
      </div>
    </div>
  );
}

// Inline picker for attaching the customer's existing QBO docs to a
// compose-new email. Shows recent invoices + credit memos (from the
// /api/customers/:id/invoices endpoint already used by the Invoices
// tab) plus a "Generate statement PDF (open items)" virtual entry
// that re-renders a fresh statement on demand.
//
// Picking fetches the PDF as a Blob, wraps it in a File so the
// downstream base64-encode + send pipeline doesn't fork by source.
// Already-attached filenames render as disabled to prevent
// double-attaching the same doc — the operator can still use the
// chip's × button to remove it.
type CustomerDocRow = {
  docType: "invoice" | "credit_memo";
  qbId: string;
  docNumber: string | null;
  issueDate: string | null;
  total: string;
  balance: string;
};

function CustomerDocPicker({
  customerId,
  attachedFilenames,
  onPick,
}: {
  customerId: string;
  attachedFilenames: Set<string>;
  onPick: (file: File) => void;
}) {
  const docsQuery = useQuery<{
    invoices: CustomerDocRow[];
  }>({
    queryKey: ["customer-invoices", customerId],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/invoices`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // Which book the generated statement covers (origin-split-2 W2 T6 —
  // closes the W1 gap where compose could only attach Feldart statements).
  const [statementOrigin, setStatementOrigin] = useState<"feldart" | "tj">(
    "feldart",
  );

  async function fetchAsFile(
    url: string,
    filename: string,
  ): Promise<File> {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    return new File([blob], filename, {
      type: blob.type || "application/pdf",
    });
  }

  async function pickInvoiceOrCm(row: CustomerDocRow): Promise<void> {
    const baseName =
      row.docType === "credit_memo"
        ? `CreditMemo-${row.docNumber ?? row.qbId}`
        : `Invoice-${row.docNumber ?? row.qbId}`;
    const filename = `${baseName}.pdf`;
    if (attachedFilenames.has(filename)) return;
    const key = `${row.docType}:${row.qbId}`;
    setBusyKey(key);
    setPickError(null);
    try {
      const url = `/api/qb-pdf/${row.docType === "credit_memo" ? "creditmemo" : "invoice"}/${encodeURIComponent(row.qbId)}`;
      const file = await fetchAsFile(url, filename);
      onPick(file);
    } catch (err) {
      setPickError(
        err instanceof Error ? err.message : "Failed to fetch PDF",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function pickStatement(): Promise<void> {
    // TJ statements get a distinct filename so the attached-file dedupe
    // doesn't block attaching one statement per book on the same email.
    const datePart = new Date().toISOString().slice(0, 10);
    const filename =
      statementOrigin === "tj"
        ? `Statement-TJ-${datePart}.pdf`
        : `Statement-${datePart}.pdf`;
    if (attachedFilenames.has(filename)) return;
    setBusyKey("statement");
    setPickError(null);
    try {
      const url = `/api/customers/${encodeURIComponent(customerId)}/statement-pdf-preview?origin=${statementOrigin}`;
      const file = await fetchAsFile(url, filename);
      onPick(file);
    } catch (err) {
      setPickError(
        err instanceof Error
          ? err.message
          : "Failed to render statement PDF",
      );
    } finally {
      setBusyKey(null);
    }
  }

  const rows = docsQuery.data?.invoices ?? [];
  // Recent first — backend already orders by issue date desc, but we
  // cap the picker at the 25 most recent so an old account with
  // hundreds of invoices doesn't fill the dialog.
  const visibleRows = rows.slice(0, 25);

  return (
    <div className="rounded-md border border-default bg-subtle p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          {docsQuery.isPending
            ? "Loading customer docs…"
            : `Customer docs (${rows.length})`}
        </span>
        {pickError ? (
          <span className="text-[11px] text-accent-danger">
            {pickError}
          </span>
        ) : null}
      </div>
      {/* Statement PDF — always offered (re-renders open items on demand).
          The segmented Feldart/TJ control picks WHICH BOOK the statement
          covers; each statement covers exactly one book (origin-split-2). */}
      <div className="mb-1 flex items-stretch gap-1">
        <button
          type="button"
          onClick={pickStatement}
          disabled={busyKey !== null}
          className="flex flex-1 items-center justify-between rounded border border-default bg-base px-2 py-1.5 text-left text-xs hover:bg-elevated disabled:opacity-50"
        >
          <span>
            <span className="font-medium">Statement (open items)</span>
            <span className="ml-2 text-muted">
              generated now from current open invoices
            </span>
          </span>
          <span className="ml-2 shrink-0 text-[10px] text-muted">
            {busyKey === "statement" ? "fetching…" : "PDF"}
          </span>
        </button>
        <div
          role="group"
          aria-label="Statement book"
          className="flex shrink-0 overflow-hidden rounded border border-default"
        >
          {(["feldart", "tj"] as const).map((book) => (
            <button
              key={book}
              type="button"
              onClick={() => setStatementOrigin(book)}
              aria-pressed={statementOrigin === book}
              className={`px-2 text-[10px] uppercase tracking-wide ${
                statementOrigin === book
                  ? "bg-elevated font-semibold"
                  : "bg-base text-muted hover:bg-elevated"
              }`}
            >
              {book === "tj" ? "TJ" : "Feldart"}
            </button>
          ))}
        </div>
      </div>
      {docsQuery.isError ? (
        <div className="text-xs text-accent-danger">
          {(docsQuery.error as Error)?.message ?? "Failed to load docs"}
        </div>
      ) : null}
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {visibleRows.map((row) => {
          const key = `${row.docType}:${row.qbId}`;
          const filename =
            row.docType === "credit_memo"
              ? `CreditMemo-${row.docNumber ?? row.qbId}.pdf`
              : `Invoice-${row.docNumber ?? row.qbId}.pdf`;
          const alreadyAttached = attachedFilenames.has(filename);
          return (
            <button
              key={key}
              type="button"
              onClick={() => pickInvoiceOrCm(row)}
              disabled={busyKey !== null || alreadyAttached}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-elevated disabled:opacity-50"
            >
              <span className="truncate">
                <span className="font-medium">
                  {row.docType === "credit_memo" ? "CM" : "Inv"}{" "}
                  {row.docNumber ?? row.qbId}
                </span>
                <span className="ml-2 text-muted">
                  {row.issueDate ?? "—"} · ${Number(row.total).toFixed(2)}
                </span>
              </span>
              <span className="ml-2 shrink-0 text-[10px] text-muted">
                {alreadyAttached
                  ? "attached"
                  : busyKey === key
                    ? "fetching…"
                    : "PDF"}
              </span>
            </button>
          );
        })}
        {!docsQuery.isPending && visibleRows.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted">
            No invoices or credit memos for this customer.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Read a File as base64 (no data: prefix). Used to encode attachments
// for the /api/send payload, which expects raw base64 per attachment.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
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
