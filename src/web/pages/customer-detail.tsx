import { useEffect, useState } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Pause,
  Play,
  Mail,
  FileText,
  CheckCircle2,
  Pencil,
  X,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { ActivityTimeline } from "../components/activity-timeline";
import { EmailList } from "../components/email-list";
import { HoldBanner } from "../components/hold-banner";
import StatementSendDialog, {
  type StatementSendSuccess,
} from "../components/statement-send-dialog";
import { cn } from "../lib/cn";

type Customer = {
  id: string;
  qbCustomerId: string | null;
  displayName: string;
  primaryEmail: string | null;
  billingEmails: string[] | null;
  paymentTerms: string | null;
  holdStatus: "active" | "hold" | "payment_upfront";
  shopifyCustomerId: string | null;
  customerType: "b2b" | "b2c" | null;
  balance: string;
  overdueBalance: string;
  internalNotes: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Activity type imported from the timeline component so the meta shape
// stays in sync with what it renders (amount, currency, qbId, etc.).
import type { Activity } from "../components/activity-timeline";

type DetailResponse = {
  customer: Customer;
  recentActivities: Activity[];
};

type TabKey = "activity" | "emails" | "invoices" | "orders" | "tasks" | "notes";

const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "emails", label: "Emails" },
  { key: "invoices", label: "Invoices" },
  { key: "orders", label: "Orders" },
  { key: "tasks", label: "Tasks" },
  { key: "notes", label: "Notes" },
];

type ShopifyTagsResponse = {
  matched: boolean;
  shopifyCustomerId?: string;
  tags: string[];
};

export default function CustomerDetailPage() {
  const { customerId } = useParams({ from: "/customers/$customerId" });
  const [tab, setTab] = useState<TabKey>("activity");
  const [holdDialogOpen, setHoldDialogOpen] = useState(false);
  const [statementDialogOpen, setStatementDialogOpen] = useState(false);
  const [statementSuccess, setStatementSuccess] =
    useState<StatementSendSuccess | null>(null);
  const queryClient = useQueryClient();

  // Auto-dismiss the "statement sent" pill after ~6s. We don't have a
  // ToastProvider mounted on this page (only /tasks does) and the
  // confirmation is non-essential, so an inline auto-fading pill is
  // simpler than retrofitting toast plumbing here.
  useEffect(() => {
    if (!statementSuccess) return;
    const t = setTimeout(() => setStatementSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [statementSuccess]);

  const { data, isPending, isError, error } = useQuery<DetailResponse>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const tagsQuery = useQuery<ShopifyTagsResponse>({
    queryKey: ["shopify-tags", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}/shopify-tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const holdToggleMutation = useMutation({
    mutationFn: async (targetState: "hold" | "active") => {
      const res = await fetch(`/api/customers/${customerId}/hold-toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetState }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json() as Promise<{
        holdStatus: "active" | "hold" | "payment_upfront";
        tagsAfter: string[];
      }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["shopify-tags", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setHoldDialogOpen(false);
    },
  });

  if (isPending) {
    return <div className="text-sm text-muted">Loading…</div>;
  }
  if (isError) {
    return (
      <div className="text-sm text-accent-danger">
        {(error as Error)?.message ?? "Failed to load customer"}
      </div>
    );
  }
  if (!data) return null;

  const { customer, recentActivities } = data;
  const balance = Number(customer.balance);
  const overdue = Number(customer.overdueBalance);

  const targetHoldState: "hold" | "active" =
    customer.holdStatus === "hold" ? "active" : "hold";

  return (
    <div className="space-y-4">
      <Link
        to="/customers"
        className="inline-flex items-center gap-1 text-xs text-secondary hover:text-primary"
      >
        <ArrowLeft className="size-3.5" />
        All customers
      </Link>

      <HoldBanner
        customerId={customer.id}
        customerName={customer.displayName}
        holdStatus={customer.holdStatus}
      />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {customer.displayName}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-secondary">
            {customer.primaryEmail && (
              <span className="inline-flex items-center gap-1">
                <Mail className="size-3.5" />
                {customer.primaryEmail}
              </span>
            )}
            {customer.paymentTerms && (
              <span>Terms: {customer.paymentTerms}</span>
            )}
            <CustomerTypeBadge type={customer.customerType} />
            {customer.holdStatus === "hold" ? (
              <Badge tone="critical">
                <Pause className="mr-1 size-3" />
                On hold
              </Badge>
            ) : customer.holdStatus === "payment_upfront" ? (
              <Badge tone="high">Payment upfront</Badge>
            ) : (
              <Badge tone="success">Active</Badge>
            )}
          </div>
          <ShopifyTagsRow tagsQuery={tagsQuery} />
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {/* Statements only make sense when there's something to chase
              for. balance comes back as a string from MySQL DECIMAL —
              Number(...) > 0 weeds out "0.00" and the rare unparseable
              edge case (NaN > 0 is false). Held customers are still
              chase-able, so holdStatus is intentionally not gating. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setStatementDialogOpen(true)}
            disabled={!(balance > 0)}
            title={
              balance > 0
                ? "Send a statement of open invoices to this customer"
                : "No open balance — nothing to send"
            }
          >
            <FileText className="size-3.5" />
            Send statement
          </Button>
          <Button
            variant={customer.holdStatus === "hold" ? "secondary" : "danger"}
            size="sm"
            onClick={() => setHoldDialogOpen(true)}
            disabled={holdToggleMutation.isPending}
          >
            {customer.holdStatus === "hold" ? (
              <>
                <Play className="size-3.5" />
                Release hold
              </>
            ) : (
              <>
                <Pause className="size-3.5" />
                Put on hold
              </>
            )}
          </Button>
        </div>
      </div>

      {statementSuccess && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-accent-success/30 bg-accent-success/10 px-3 py-2 text-sm text-accent-success"
        >
          <CheckCircle2 className="size-4" />
          <span>
            Sent to {statementSuccess.to} ·{" "}
            {statementSuccess.invoiceCount} invoice
            {statementSuccess.invoiceCount === 1 ? "" : "s"} ·{" "}
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(statementSuccess.totalOpenBalance)}
          </span>
        </div>
      )}

      <StatementSendDialog
        open={statementDialogOpen}
        onOpenChange={setStatementDialogOpen}
        customerId={customer.id}
        customerName={customer.displayName}
        onSent={(result) => setStatementSuccess(result)}
      />

      <Dialog open={holdDialogOpen} onOpenChange={setHoldDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {targetHoldState === "hold" ? "Put on hold?" : "Release hold?"}
            </DialogTitle>
            <DialogDescription>
              {targetHoldState === "hold"
                ? `This will remove ${customer.displayName} from the B2B program by removing the 'b2b' Shopify tag. Continue?`
                : `This will restore ${customer.displayName} to the B2B program by re-adding the 'b2b' Shopify tag. Continue?`}
            </DialogDescription>
          </DialogHeader>
          {holdToggleMutation.isError && (
            <div className="mt-2 text-sm text-accent-danger">
              {(holdToggleMutation.error as Error)?.message ?? "Toggle failed"}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHoldDialogOpen(false)}
              disabled={holdToggleMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={targetHoldState === "hold" ? "danger" : "primary"}
              size="sm"
              onClick={() => holdToggleMutation.mutate(targetHoldState)}
              disabled={holdToggleMutation.isPending}
              loading={holdToggleMutation.isPending}
            >
              {targetHoldState === "hold" ? "Put on hold" : "Release hold"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Open balance" value={`$${balance.toFixed(2)}`} />
        <StatCard
          label="Overdue"
          value={overdue > 0 ? `$${overdue.toFixed(2)}` : "—"}
          tone={overdue > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Type"
          value={
            customer.customerType
              ? customer.customerType.toUpperCase()
              : "Untagged"
          }
        />
        <TermsCard
          customerId={customer.id}
          currentTerms={customer.paymentTerms}
        />
      </div>

      <div className="border-b border-default">
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "border-b-2 px-3 py-2 text-sm transition-colors",
                tab === t.key
                  ? "border-accent-primary font-medium text-primary"
                  : "border-transparent text-secondary hover:text-primary",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div>
        {tab === "activity" && (
          <ActivityTimeline
            customerId={customer.id}
            activities={recentActivities}
            queryKey={["customer", customerId]}
          />
        )}
        {tab === "emails" && (
          <EmailList
            customerId={customer.id}
            customerName={customer.displayName}
            customerEmail={customer.primaryEmail}
          />
        )}
        {tab === "invoices" && <PlaceholderPanel label="Invoices" />}
        {tab === "orders" && <PlaceholderPanel label="Orders" />}
        {tab === "tasks" && <PlaceholderPanel label="Tasks" />}
        {tab === "notes" && (
          <NotesPanel
            customerId={customer.id}
            notes={recentActivities.filter((a) => a.kind === "manual_note")}
          />
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning" | "neutral";
}) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
        <div
          className={cn(
            "mt-0.5 text-lg font-semibold tabular-nums",
            tone === "warning" && "text-accent-warning",
          )}
        >
          {value}
        </div>
      </CardBody>
    </Card>
  );
}

// Editable terms card. Click the pencil to open inline editor: presets
// for the common Net X values + "Due on Receipt" + a custom text input
// + clear. Save fires PATCH /api/customers/:id { paymentTerms } and
// invalidates the detail query so the parent page picks up the new
// value. Optimistic update would be nicer but the round trip is fast
// enough that the small "saving…" pause is fine.
const TERMS_PRESETS = [
  "Net 15",
  "Net 30",
  "Net 45",
  "Net 60",
  "Net 90",
  "Due on Receipt",
];

function TermsCard({
  customerId,
  currentTerms,
}: {
  customerId: string;
  currentTerms: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation<unknown, Error, string | null>({
    mutationFn: async (next) => {
      const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentTerms: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      setEditing(false);
      setCustom("");
    },
  });

  function pick(v: string | null) {
    if (mutation.isPending) return;
    if (v === currentTerms) {
      setEditing(false);
      return;
    }
    mutation.mutate(v);
  }

  return (
    <Card>
      <CardBody className="py-3">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-muted">Terms</div>
          {!editing ? (
            <button
              type="button"
              aria-label="Edit terms"
              onClick={() => setEditing(true)}
              className="rounded p-1 text-muted hover:bg-elevated hover:text-primary"
            >
              <Pencil className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Cancel"
              onClick={() => {
                setEditing(false);
                setCustom("");
              }}
              className="rounded p-1 text-muted hover:bg-elevated hover:text-primary"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {!editing ? (
          <div className="mt-0.5 text-lg font-semibold tabular-nums">
            {currentTerms ?? "—"}
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1">
              {TERMS_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => pick(p)}
                  className={cn(
                    "rounded-md border border-default px-2 py-1 text-xs",
                    p === currentTerms
                      ? "bg-elevated font-medium"
                      : "text-secondary hover:bg-elevated",
                  )}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                disabled={mutation.isPending || currentTerms === null}
                onClick={() => pick(null)}
                className="rounded-md border border-default px-2 py-1 text-xs text-secondary hover:bg-elevated disabled:opacity-50"
              >
                Clear
              </button>
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="Custom (e.g., Net 7)"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && custom.trim()) {
                    pick(custom.trim());
                  }
                }}
                className="flex-1 rounded-md border border-default bg-base px-2 py-1 text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!custom.trim() || mutation.isPending}
                onClick={() => pick(custom.trim())}
              >
                Save
              </Button>
            </div>
            {mutation.isError ? (
              <div className="text-xs text-accent-danger">
                {String(mutation.error?.message ?? "save failed")}
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function CustomerTypeBadge({ type }: { type: "b2b" | "b2c" | null }) {
  if (type === "b2b") return <Badge tone="info">B2B</Badge>;
  if (type === "b2c") return <Badge tone="neutral">B2C</Badge>;
  return <Badge tone="medium">Untagged</Badge>;
}

// Read-only Shopify tag chips. Renders below the badge row so the page
// always shows the source-of-truth tag set for the matched Shopify
// customer. The "b2b" tag is highlighted with the info tone so it's
// visually distinct from the other (neutral) tags — that's the tag
// hold/release toggles, so it deserves emphasis.
function ShopifyTagsRow({
  tagsQuery,
}: {
  tagsQuery: ReturnType<typeof useQuery<ShopifyTagsResponse>>;
}) {
  if (tagsQuery.isPending) {
    return (
      <div className="mt-2 text-xs text-muted">Loading Shopify tags…</div>
    );
  }
  if (tagsQuery.isError || !tagsQuery.data) {
    return null;
  }
  const { matched, tags } = tagsQuery.data;
  if (!matched) {
    return (
      <div className="mt-2 text-xs text-muted">No matched Shopify customer</div>
    );
  }
  if (tags.length === 0) {
    return (
      <div className="mt-2 text-xs text-muted">
        Shopify customer matched, no tags set
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs uppercase tracking-wide text-muted">
        Shopify tags:
      </span>
      {tags.map((t) => (
        <Badge key={t} tone={t === "b2b" ? "info" : "neutral"}>
          {t}
        </Badge>
      ))}
    </div>
  );
}

function PlaceholderPanel({ label }: { label: string }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">{label}</h2>
      </CardHeader>
      <CardBody className="py-8 text-center text-sm text-muted">
        {label} panel — coming next.
      </CardBody>
    </Card>
  );
}

function NotesPanel({
  customerId,
  notes,
}: {
  customerId: string;
  notes: Activity[];
}) {
  // Stubbed for now — full add-note + @mentions land with Task #7
  // (comments/mentions architecture). For the moment we just render
  // any existing manual_note activities.
  const _ = customerId;
  if (notes.length === 0) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-muted">
          No notes yet. Add one — coming next.
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-3">
        {notes.map((n) => (
          <div key={n.id} className="border-b border-default pb-3 last:border-b-0">
            <div className="text-xs text-muted">
              {new Date(n.occurredAt).toLocaleString()}
            </div>
            {n.subject && <div className="mt-1 font-medium">{n.subject}</div>}
            {n.body && <p className="mt-1 text-sm text-secondary">{n.body}</p>}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
