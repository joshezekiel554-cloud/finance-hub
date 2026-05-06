import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Download,
  ExternalLink,
  Eye,
  Plus,
  Save,
  Trash2,
  Variable,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { LogoUploader } from "../components/logo-uploader";
import { cn } from "../lib/cn";

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

type ListResponse = { rows: EmailTemplate[] };

// The merge variables our resolver supports. Surfaced as clickable chips in
// the editor so the user can tap-to-insert without memorizing them.
const MERGE_VARIABLES: { key: string; label: string }[] = [
  { key: "{{customer_name}}", label: "Customer name" },
  { key: "{{primary_email}}", label: "Customer email" },
  { key: "{{open_balance}}", label: "Open balance" },
  { key: "{{overdue_balance}}", label: "Overdue balance" },
  { key: "{{days_overdue}}", label: "Days overdue" },
  { key: "{{oldest_unpaid_invoice}}", label: "Oldest invoice #" },
  { key: "{{oldest_unpaid_amount}}", label: "Oldest invoice amount" },
  { key: "{{user_name}}", label: "Your name" },
  { key: "{{company_name}}", label: "Company name" },
  { key: "{{thread_subject}}", label: "Thread subject (replies)" },
  { key: "{{statement_table}}", label: "Statement table (statement only)" },
];

const CONTEXT_LABELS: Record<EmailTemplateContext, string> = {
  chase: "Chase",
  statement: "Statement",
  payment_confirmation: "Payment confirmation",
  generic: "Generic",
  reply: "Reply",
};

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-secondary">
          Workspace configuration. More sections land here as the app grows.
        </p>
      </div>
      <EmailTemplatesSection />
      <StatementPdfSection />
      <ReturnsSection />
      <RoutingRulesSection />
      <ImportsSection />
    </div>
  );
}

// CRUD for email_routing_rules. Each row maps a customer tag → an
// email-routing action (auto-CC/BCC on invoices or statements). Today
// the seeded rule is `yiddy → bcc_invoice → sales@feldart.com`; the
// table is plural so the operator can add per-team rules without
// touching code.
type RoutingRule = {
  id: string;
  tag: string;
  action:
    | "bcc_invoice"
    | "bcc_statement"
    | "cc_invoice"
    | "cc_statement";
  value: string;
  createdAt: string;
};

const RULE_ACTION_LABEL: Record<RoutingRule["action"], string> = {
  bcc_invoice: "BCC on invoices",
  bcc_statement: "BCC on statements",
  cc_invoice: "CC on invoices",
  cc_statement: "CC on statements",
};

function RoutingRulesSection() {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery<{ rules: RoutingRule[] }>({
    queryKey: ["email-routing-rules"],
    queryFn: async () => {
      const res = await fetch("/api/email-routing-rules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const [tag, setTag] = useState("");
  const [action, setAction] = useState<RoutingRule["action"]>("bcc_invoice");
  const [value, setValue] = useState("");

  const createMutation = useMutation({
    mutationFn: async (input: {
      tag: string;
      action: RoutingRule["action"];
      value: string;
    }) => {
      const res = await fetch("/api/email-routing-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-routing-rules"] });
      setTag("");
      setValue("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/email-routing-rules/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-routing-rules"] });
    },
  });

  const rules = data?.rules ?? [];

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">Email routing rules</h2>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-xs text-muted">
          When a customer has a matching tag, the rule's address is
          auto-added to the recipient list on every send. Used for
          per-salesperson invoice copies and similar — the seeded
          example is <code>yiddy</code> →{" "}
          <code>BCC sales@feldart.com on invoices</code>.
        </p>
        {isPending ? (
          <div className="text-xs text-muted">Loading…</div>
        ) : rules.length === 0 ? (
          <div className="text-xs text-muted">No rules yet.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-default text-[10px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-2 py-1 text-left">Tag</th>
                <th className="px-2 py-1 text-left">Action</th>
                <th className="px-2 py-1 text-left">Address</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-default">
                  <td className="px-2 py-1 font-mono">{r.tag}</td>
                  <td className="px-2 py-1">{RULE_ACTION_LABEL[r.action]}</td>
                  <td className="px-2 py-1">{r.value}</td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (confirm(`Delete rule "${r.tag} → ${RULE_ACTION_LABEL[r.action]} → ${r.value}"?`)) {
                          deleteMutation.mutate(r.id);
                        }
                      }}
                      className="text-muted hover:text-accent-danger"
                      aria-label="Delete rule"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t border-default pt-3">
          <label className="block text-xs">
            <span className="mb-0.5 block text-muted">Tag</span>
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="yiddy"
              className="w-32 text-xs"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-0.5 block text-muted">Action</span>
            <select
              value={action}
              onChange={(e) =>
                setAction(e.target.value as RoutingRule["action"])
              }
              className="rounded-md border border-default bg-base px-2 py-1 text-xs"
            >
              {Object.entries(RULE_ACTION_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs flex-1">
            <span className="mb-0.5 block text-muted">Address</span>
            <Input
              type="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="sales@feldart.com"
              className="text-xs"
            />
          </label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={
              !tag.trim() ||
              !value.trim() ||
              createMutation.isPending
            }
            onClick={() =>
              createMutation.mutate({
                tag: tag.trim().toLowerCase(),
                action,
                value: value.trim(),
              })
            }
          >
            <Plus className="size-3.5" /> Add rule
          </Button>
        </div>
        {createMutation.isError ? (
          <div className="text-xs text-accent-danger">
            {(createMutation.error as Error)?.message ?? "create failed"}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ImportsSection() {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">One-off imports</h2>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Monday — payment terms</div>
            <div className="text-xs text-muted">
              Backfill payment terms from the USA Stores Information board.
              Preview before any writes.
            </div>
          </div>
          <Link to="/import/monday-terms">
            <Button variant="secondary" size="sm">
              <Download className="size-3.5" /> Open
              <ArrowRight className="size-3.5" />
            </Button>
          </Link>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-default pt-3">
          <div>
            <div className="text-sm font-medium">
              Shopify — link customer ids
            </div>
            <div className="text-xs text-muted">
              Match each B2B customer to their Shopify record once. Run
              this BEFORE the b2b-tag audit so QBO/Shopify email
              mismatches don't hold the wrong customers.
            </div>
          </div>
          <Link to="/import/shopify-link">
            <Button variant="secondary" size="sm">
              <Download className="size-3.5" /> Open
              <ArrowRight className="size-3.5" />
            </Button>
          </Link>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-default pt-3">
          <div>
            <div className="text-sm font-medium">
              Shopify — B2B-tag audit
            </div>
            <div className="text-xs text-muted">
              Bring customer status (active / hold / payment upfront) into
              sync with the b2b and b2b-b2b-upfront tags in Shopify.
            </div>
          </div>
          <Link to="/import/shopify-b2b-audit">
            <Button variant="secondary" size="sm">
              <Download className="size-3.5" /> Open
              <ArrowRight className="size-3.5" />
            </Button>
          </Link>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-default pt-3">
          <div>
            <div className="text-sm font-medium">
              Roster — bulk-tag customers
            </div>
            <div className="text-xs text-muted">
              Apply one tag to many customers at once (e.g. Yiddy's
              commission roster). Paste names or upload a CSV; preview
              before any writes.
            </div>
          </div>
          <Link to="/import/roster-tag">
            <Button variant="secondary" size="sm">
              <Download className="size-3.5" /> Open
              <ArrowRight className="size-3.5" />
            </Button>
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

function EmailTemplatesSection() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const queryClient = useQueryClient();
  const { data, isPending } = useQuery<ListResponse>({
    queryKey: ["email-templates"],
    queryFn: async () => {
      const res = await fetch("/api/email-templates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];
  const selected = selectedId
    ? rows.find((r) => r.id === selectedId) ?? null
    : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">Email templates</h2>
            <p className="mt-0.5 text-xs text-muted">
              Edited copy lands instantly — no deploy needed. Pick a
              template below or create a new one.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          >
            <Plus className="size-3.5" />
            New template
          </Button>
        </div>
      </CardHeader>
      <CardBody className="grid gap-4 md:grid-cols-[280px_1fr]">
        <div className="border-r border-default md:pr-4">
          {isPending && (
            <div className="text-sm text-muted">Loading…</div>
          )}
          <ul className="space-y-1">
            {rows.map((tpl) => (
              <li key={tpl.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(tpl.id);
                    setCreating(false);
                  }}
                  className={cn(
                    "w-full rounded-md px-2 py-2 text-left text-sm transition-colors",
                    selectedId === tpl.id && !creating
                      ? "bg-elevated text-primary"
                      : "hover:bg-subtle text-secondary",
                  )}
                >
                  <div className="font-medium">{tpl.name}</div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <Badge tone="neutral">{CONTEXT_LABELS[tpl.context]}</Badge>
                    <span className="font-mono text-[10px] text-muted">
                      {tpl.slug}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          {creating ? (
            <TemplateEditor
              key="new"
              template={null}
              onSaved={(saved) => {
                queryClient.invalidateQueries({ queryKey: ["email-templates"] });
                setCreating(false);
                setSelectedId(saved.id);
              }}
              onCancel={() => setCreating(false)}
            />
          ) : selected ? (
            <TemplateEditor
              key={selected.id}
              template={selected}
              onSaved={() => {
                queryClient.invalidateQueries({ queryKey: ["email-templates"] });
              }}
              onDeleted={() => {
                queryClient.invalidateQueries({ queryKey: ["email-templates"] });
                setSelectedId(null);
              }}
              onCancel={() => setSelectedId(null)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Select a template on the left to edit, or create a new one.
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function TemplateEditor({
  template,
  onSaved,
  onDeleted,
  onCancel,
}: {
  template: EmailTemplate | null;
  onSaved: (template: EmailTemplate) => void;
  onDeleted?: () => void;
  onCancel: () => void;
}) {
  const isNew = template === null;
  const [name, setName] = useState(template?.name ?? "");
  const [slug, setSlug] = useState(template?.slug ?? "");
  const [context, setContext] = useState<EmailTemplateContext>(
    template?.context ?? "generic",
  );
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [description, setDescription] = useState(template?.description ?? "");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = isNew
        ? "/api/email-templates"
        : `/api/email-templates/${template!.id}`;
      const method = isNew ? "POST" : "PATCH";
      const body_ = isNew
        ? { slug, name, context, subject, body, description }
        : { name, context, subject, body, description };
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body_),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { template: EmailTemplate };
    },
    onSuccess: ({ template: saved }) => onSaved(saved),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/email-templates/${template!.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => onDeleted?.(),
  });

  function insertVariable(variable: string, target: "subject" | "body") {
    if (target === "subject") {
      setSubject((s) => s + variable);
    } else {
      setBody((b) => b + variable);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-secondary">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-secondary">Slug</span>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!isNew}
            className="font-mono disabled:opacity-60"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-secondary">Context</span>
          <select
            value={context}
            onChange={(e) =>
              setContext(e.target.value as EmailTemplateContext)
            }
            className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm"
          >
            {Object.entries(CONTEXT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-secondary">
            Description (optional)
          </span>
          <Input
            value={description ?? ""}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-secondary">Subject</span>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-secondary">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="w-full rounded-md border border-default bg-base px-3 py-2 font-mono text-sm"
        />
      </label>
      <div className="rounded-md border border-default bg-subtle px-3 py-2 text-xs">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-secondary">
          <Variable className="size-3" />
          Click a variable to append it to the body
        </div>
        <div className="flex flex-wrap gap-1.5">
          {MERGE_VARIABLES.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => insertVariable(v.key, "body")}
              className="rounded border border-default bg-base px-2 py-0.5 font-mono text-[10px] text-secondary hover:border-strong hover:text-primary"
              title={v.label}
            >
              {v.key}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-default pt-3">
        <div>
          {!isNew && onDeleted && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm("Delete this template? Cannot be undone.")) {
                  deleteMutation.mutate();
                }
              }}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {saveMutation.isError && (
            <span className="text-xs text-accent-danger">
              {(saveMutation.error as Error)?.message ?? "Save failed"}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            <Save className="size-3.5" />
            {saveMutation.isPending ? "Saving…" : isNew ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Statement PDF section ─────────────────────────

type AppSettingsResponse = { settings: Record<string, string> };

// Order matters — drives both the form layout and the diff comparison.
// company_logo_path is omitted from the textual form (handled by the
// LogoUploader, which writes it server-side via /api/logo-upload).
const STATEMENT_PDF_KEYS = [
  "company_name",
  "company_address",
  "company_phone",
  "company_email",
  "company_website",
  "payment_methods",
  "footer_note",
  "statement_number_next",
  "statement_bcc_email",
] as const;

type StatementPdfKey = (typeof STATEMENT_PDF_KEYS)[number];

function StatementPdfSection() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery<AppSettingsResponse>({
    queryKey: ["app-settings"],
    queryFn: async () => {
      const res = await fetch("/api/app-settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const initial = useMemo(
    () => settingsQuery.data?.settings ?? {},
    [settingsQuery.data],
  );

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedAgoLabel, setSavedAgoLabel] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Snap the draft to the latest server values on (re)load. We compare
  // by reference equality on `initial` — the memo above only changes
  // when the underlying query data changes, so this is cheap.
  useEffect(() => {
    if (settingsQuery.data) {
      setDraft({ ...initial });
    }
  }, [settingsQuery.data, initial]);

  // Tick the "Saved Ns ago" label every 5s so it stays vaguely fresh
  // without burning re-renders.
  useEffect(() => {
    if (!savedAt) {
      setSavedAgoLabel(null);
      return;
    }
    const recompute = () => {
      const ago = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
      setSavedAgoLabel(formatSecondsAgo(ago));
    };
    recompute();
    const t = setInterval(recompute, 5000);
    return () => clearInterval(t);
  }, [savedAt]);

  const value = (key: StatementPdfKey) => draft[key] ?? "";
  const set = (key: StatementPdfKey, v: string) =>
    setDraft((d) => ({ ...d, [key]: v }));

  // Compute the diff between draft and the server-loaded initial state.
  // We only PATCH keys whose value actually changed — keeps audit-log
  // chatter tight and avoids gratuitous updated_at bumps.
  const diff = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of STATEMENT_PDF_KEYS) {
      const current = draft[key] ?? "";
      const original = initial[key] ?? "";
      if (current !== original) out[key] = current;
    }
    return out;
  }, [draft, initial]);
  const dirtyCount = Object.keys(diff).length;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/app-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(diff),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as AppSettingsResponse;
    },
    onSuccess: () => {
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/customers?customerType=b2b&limit=1");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        rows?: { id: string }[];
      };
      const id = json.rows?.[0]?.id;
      if (!id) throw new Error("No B2B customer to preview against");
      return id;
    },
    onSuccess: (id) => {
      setPreviewError(null);
      window.open(
        `/api/customers/${id}/statement-pdf-preview`,
        "_blank",
        "noopener",
      );
    },
    onError: (err: Error) => {
      setPreviewError(err.message);
    },
  });

  const isLoading = settingsQuery.isPending;
  const logoPath = initial["company_logo_path"] ?? "";
  const dirty = dirtyCount > 0;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">Statement PDF</h2>
        <p className="mt-0.5 text-xs text-muted">
          Configure how your statement document looks. Edits apply to
          every statement going forward.
        </p>
      </CardHeader>
      <CardBody className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block font-medium text-secondary">
                  Company name
                </span>
                <Input
                  value={value("company_name")}
                  onChange={(e) => set("company_name", e.target.value)}
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-medium text-secondary">
                  Company phone
                </span>
                <Input
                  value={value("company_phone")}
                  onChange={(e) => set("company_phone", e.target.value)}
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-medium text-secondary">
                  Company email
                </span>
                <Input
                  type="email"
                  value={value("company_email")}
                  onChange={(e) => set("company_email", e.target.value)}
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-medium text-secondary">
                  Company website
                </span>
                <Input
                  type="url"
                  value={value("company_website")}
                  onChange={(e) => set("company_website", e.target.value)}
                />
              </label>
            </div>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-secondary">
                Company address
              </span>
              <textarea
                value={value("company_address")}
                onChange={(e) => set("company_address", e.target.value)}
                rows={4}
                className="w-full rounded-md border border-default bg-base px-3 py-2 text-sm"
              />
            </label>
            <div className="block text-xs">
              <span className="mb-1 block font-medium text-secondary">
                Logo
              </span>
              <LogoUploader
                logoPath={logoPath}
                onUploaded={() =>
                  queryClient.invalidateQueries({
                    queryKey: ["app-settings"],
                  })
                }
              />
            </div>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-secondary">
                Payment methods
              </span>
              <textarea
                value={value("payment_methods")}
                onChange={(e) => set("payment_methods", e.target.value)}
                rows={6}
                className="w-full rounded-md border border-default bg-base px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-secondary">
                Footer note (optional)
              </span>
              <Input
                value={value("footer_note")}
                onChange={(e) => set("footer_note", e.target.value)}
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-secondary">
                Next statement number
              </span>
              <Input
                type="number"
                value={value("statement_number_next")}
                onChange={(e) =>
                  set("statement_number_next", e.target.value)
                }
                helperText="Auto-increments after each send. Set high enough to clear your existing QBO range."
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-secondary">
                BCC every statement to
              </span>
              <Input
                type="email"
                value={value("statement_bcc_email")}
                onChange={(e) =>
                  set("statement_bcc_email", e.target.value)
                }
                placeholder="leave empty to disable"
                helperText="Address that receives a silent copy of every Statement.pdf send. Empty disables the BCC."
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-default pt-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => previewMutation.mutate()}
                  disabled={previewMutation.isPending}
                >
                  <Eye className="size-3.5" />
                  {previewMutation.isPending
                    ? "Loading preview…"
                    : "Preview statement"}
                  <ExternalLink className="size-3" />
                </Button>
                {previewError && (
                  <span className="text-xs text-accent-danger">
                    {previewError}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {saveMutation.isError && (
                  <span className="text-xs text-accent-danger">
                    {(saveMutation.error as Error)?.message ?? "Save failed"}
                  </span>
                )}
                {!saveMutation.isError &&
                  !saveMutation.isPending &&
                  savedAgoLabel && (
                    <span className="text-xs text-muted">
                      Saved {savedAgoLabel}
                    </span>
                  )}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !dirty}
                >
                  <Save className="size-3.5" />
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

// ───────────────────────── Returns section ──────────────────────────────

function ReturnsSection() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery<AppSettingsResponse>({
    queryKey: ["app-settings"],
    queryFn: async () => {
      const res = await fetch("/api/app-settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const initialDriveFolder =
    settingsQuery.data?.settings.drive_root_folder_id ?? "";
  const initialWarehouseEmail =
    settingsQuery.data?.settings.warehouse_team_email ?? "";
  const initialShippingFeeItemId =
    settingsQuery.data?.settings.rma_shipping_fee_item_id ?? "";
  const initialRestockingFeeItemId =
    settingsQuery.data?.settings.rma_restocking_fee_item_id ?? "";
  const initialDamageCmNumberNext =
    settingsQuery.data?.settings.damage_cm_number_next ?? "38771";

  const [driveFolderDraft, setDriveFolderDraft] = useState<string>("");
  const [warehouseEmailDraft, setWarehouseEmailDraft] = useState<string>("");
  const [shippingFeeItemIdDraft, setShippingFeeItemIdDraft] =
    useState<string>("");
  const [restockingFeeItemIdDraft, setRestockingFeeItemIdDraft] =
    useState<string>("");
  const [damageCmNumberNextDraft, setDamageCmNumberNextDraft] =
    useState<string>("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Snap drafts to server values on (re)load.
  useEffect(() => {
    if (settingsQuery.data) {
      setDriveFolderDraft(initialDriveFolder);
      setWarehouseEmailDraft(initialWarehouseEmail);
      setShippingFeeItemIdDraft(initialShippingFeeItemId);
      setRestockingFeeItemIdDraft(initialRestockingFeeItemId);
      setDamageCmNumberNextDraft(initialDamageCmNumberNext);
    }
  }, [
    settingsQuery.data,
    initialDriveFolder,
    initialWarehouseEmail,
    initialShippingFeeItemId,
    initialRestockingFeeItemId,
    initialDamageCmNumberNext,
  ]);

  const driveFolderDirty =
    driveFolderDraft.trim() !== initialDriveFolder.trim();
  const warehouseEmailDirty =
    warehouseEmailDraft.trim() !== initialWarehouseEmail.trim();
  const shippingFeeDirty =
    shippingFeeItemIdDraft.trim() !== initialShippingFeeItemId.trim();
  const restockingFeeDirty =
    restockingFeeItemIdDraft.trim() !== initialRestockingFeeItemId.trim();
  const damageCmNumberNextDirty =
    damageCmNumberNextDraft.trim() !== initialDamageCmNumberNext.trim();
  const dirty =
    driveFolderDirty ||
    warehouseEmailDirty ||
    shippingFeeDirty ||
    restockingFeeDirty ||
    damageCmNumberNextDirty;

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Send only the keys that actually changed so the audit log + the
      // updated_at column don't churn on every save.
      const body: Record<string, string> = {};
      if (driveFolderDirty) body.drive_root_folder_id = driveFolderDraft.trim();
      if (warehouseEmailDirty)
        body.warehouse_team_email = warehouseEmailDraft.trim();
      if (shippingFeeDirty)
        body.rma_shipping_fee_item_id = shippingFeeItemIdDraft.trim();
      if (restockingFeeDirty)
        body.rma_restocking_fee_item_id = restockingFeeItemIdDraft.trim();
      if (damageCmNumberNextDirty)
        body.damage_cm_number_next = damageCmNumberNextDraft.trim();
      const res = await fetch("/api/app-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as AppSettingsResponse;
    },
    onSuccess: () => {
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
    },
  });

  // Try to extract a folder ID if the operator pastes a full Drive URL.
  function handleDriveFolderChange(raw: string): void {
    const match = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    setDriveFolderDraft(match?.[1] ?? raw);
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Returns</h2>
        <p className="mt-1 text-xs text-muted">
          Settings that apply to all RMA workflows.
        </p>
      </CardHeader>
      <CardBody className="space-y-4">
        <div>
          <label
            htmlFor="drive-root-folder-id"
            className="block text-sm font-medium text-secondary"
          >
            Google Drive folder for RMA photos
          </label>
          <p className="mt-0.5 text-xs text-muted">
            Photos uploaded on damage RMAs land here, in a per-RMA subfolder.
            Paste the folder URL or just the ID. To find the ID: open the folder
            in Drive — the ID is the last segment of the URL after{" "}
            <code className="rounded bg-elevated px-1">/folders/</code>.
          </p>
          <Input
            id="drive-root-folder-id"
            type="text"
            placeholder="https://drive.google.com/drive/folders/... or just the ID"
            value={driveFolderDraft}
            onChange={(e) => handleDriveFolderChange(e.target.value)}
            className="mt-2 font-mono text-xs"
          />
        </div>

        <div>
          <label
            htmlFor="warehouse-team-email"
            className="block text-sm font-medium text-secondary"
          >
            Warehouse team email
          </label>
          <p className="mt-0.5 text-xs text-muted">
            Recipient(s) for the "customer is shipping back RMA X with tracking
            Y" notification. Comma-separate multiple addresses. Leave empty to
            disable the auto-email — tracking still saves but you'll have to
            notify the warehouse out-of-band.
          </p>
          <Input
            id="warehouse-team-email"
            type="email"
            placeholder="warehouse@example.com"
            value={warehouseEmailDraft}
            onChange={(e) => setWarehouseEmailDraft(e.target.value)}
            className="mt-2 text-xs"
          />
        </div>

        <div>
          <label
            htmlFor="rma-shipping-fee-item-id"
            className="block text-sm font-medium text-secondary"
          >
            Shipping-deduction QBO Item ID
          </label>
          <p className="mt-0.5 text-xs text-muted">
            QBO Item id for the negative line on credit memos when an RMA
            includes a return-shipping deduction. Create a service item in
            QBO (e.g. "Return shipping deduction" pointed at a contra-revenue
            account), then paste its numeric Item.Id here. Leave empty to
            disable shipping deductions — the CM builder will refuse to
            issue any CM with shipping fees while this is unset.
          </p>
          <Input
            id="rma-shipping-fee-item-id"
            type="text"
            placeholder="e.g. 47"
            value={shippingFeeItemIdDraft}
            onChange={(e) => setShippingFeeItemIdDraft(e.target.value)}
            className="mt-2 font-mono text-xs"
          />
        </div>

        <div>
          <label
            htmlFor="rma-restocking-fee-item-id"
            className="block text-sm font-medium text-secondary"
          >
            Restocking-fee QBO Item ID
          </label>
          <p className="mt-0.5 text-xs text-muted">
            QBO Item id for the negative line on credit memos when an RMA
            includes a restocking fee. Same setup as the shipping item:
            create a service item in QBO, paste its numeric Item.Id. Leave
            empty to disable restocking deductions.
          </p>
          <Input
            id="rma-restocking-fee-item-id"
            type="text"
            placeholder="e.g. 112"
            value={restockingFeeItemIdDraft}
            onChange={(e) => setRestockingFeeItemIdDraft(e.target.value)}
            className="mt-2 font-mono text-xs"
          />
        </div>

        <div>
          <label
            htmlFor="damage-cm-number-next"
            className="block text-sm font-medium text-secondary"
          >
            Next damage credit-memo number
          </label>
          <p className="mt-0.5 text-xs text-muted">
            Sequential counter used as the QBO DocNumber for damage CMs
            (formatted as <code className="rounded bg-elevated px-1">DC#####</code>).
            Auto-increments at every damage RMA approve. Adjust here if you
            need to seed a different starting number or correct after an
            accidental increment. Seasonal + non-seasonal CMs use{" "}
            <code className="rounded bg-elevated px-1">{"{tx#}CR"}</code>{" "}
            instead and don't consume this counter.
          </p>
          <Input
            id="damage-cm-number-next"
            type="number"
            min={1}
            placeholder="38771"
            value={damageCmNumberNextDraft}
            onChange={(e) => setDamageCmNumberNextDraft(e.target.value)}
            className="mt-2 font-mono text-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
          >
            <Save className="size-4" />
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
          {savedAt && !dirty && (
            <span className="text-xs text-muted">Saved.</span>
          )}
          {saveMutation.isError && (
            <span className="text-xs text-accent-danger">
              {(saveMutation.error as Error).message}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function formatSecondsAgo(secs: number): string {
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs} seconds ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}
