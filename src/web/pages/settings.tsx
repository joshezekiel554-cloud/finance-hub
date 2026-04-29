import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2, Variable } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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
    </div>
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
