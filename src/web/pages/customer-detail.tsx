import { useEffect, useMemo, useState } from "react";
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
  ShoppingBag,
  CreditCard,
  ExternalLink,
  Send,
  RotateCcw,
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
import RmaRowMenu from "../components/rma-row-menu";
import { EmailList } from "../components/email-list";
import { HoldBanner } from "../components/hold-banner";
import { SyncCustomerButton } from "../components/sync-customer-button";
import StatementSendDialog, {
  type StatementSendSuccess,
} from "../components/statement-send-dialog";
import InvoiceSendDialog, {
  type InvoiceSendSuccess,
} from "../components/invoice-send-dialog";
import InvoiceReminderDialog, {
  type InvoiceReminderSuccess,
} from "../components/invoice-reminder-dialog";
import { cn } from "../lib/cn";

type Customer = {
  id: string;
  qbCustomerId: string | null;
  displayName: string;
  primaryEmail: string | null;
  billingEmails: string[] | null;
  invoiceToEmails: string[] | null;
  invoiceCcEmails: string[] | null;
  invoiceBccEmails: string[] | null;
  statementToEmails: string[] | null;
  statementCcEmails: string[] | null;
  statementBccEmails: string[] | null;
  tags: string[] | null;
  phone: string | null;
  additionalPhones: Array<{ label: string; number: string }> | null;
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

// KPI rollups computed server-side in the customer GET. All counts are
// numbers and timestamps are ISO strings (mysql2 subquery normalised
// route-side). Nullable when there's nothing of that kind for the
// customer — e.g. lastContactedAt is null when no email_log row exists.
type CustomerKpi = {
  openInvoiceCount: number;
  oldestUnpaidInvoiceDueDate: string | null;
  openTaskCount: number;
  hasPendingRma: boolean;
  lastContactedAt: string | null;
  lastPaymentAt: string | null;
  lastStatementSentAt: string | null;
};

type DetailResponse = {
  customer: Customer;
  recentActivities: Activity[];
  kpi: CustomerKpi | null;
};

type TabKey = "activity" | "emails" | "invoices" | "orders" | "tasks" | "notes" | "returns";

const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "emails", label: "Emails" },
  { key: "invoices", label: "Invoices" },
  { key: "orders", label: "Orders" },
  { key: "tasks", label: "Tasks" },
  { key: "notes", label: "Notes" },
  { key: "returns", label: "Returns" },
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

  // Generic 3-way status mutation. The dialog confirms which target the
  // operator picked; the route writes the right tag set + local mirror.
  type StatusTarget = "active" | "hold" | "payment_upfront";
  const [pendingTarget, setPendingTarget] = useState<StatusTarget | null>(
    null,
  );
  const holdToggleMutation = useMutation({
    mutationFn: async (targetState: StatusTarget) => {
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
        holdStatus: StatusTarget;
        tagsAfter: string[];
      }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["shopify-tags", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setHoldDialogOpen(false);
      setPendingTarget(null);
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

  const { customer, recentActivities, kpi } = data;
  const balance = Number(customer.balance);
  const overdue = Number(customer.overdueBalance);

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
        <div className="min-w-0 flex-1">
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
            {customer.tags?.some((t) => t.toLowerCase() === "yiddy") ? (
              <Badge
                tone="info"
                title="On Yiddy's commission roster — sales@feldart.com auto-BCC'd on invoices"
              >
                Yiddy
              </Badge>
            ) : null}
            {kpi?.hasPendingRma ? (
              <Badge
                tone="high"
                title="This customer has an active RMA in progress — check the Returns tab"
              >
                <RotateCcw className="mr-1 size-3" />
                RMA in flight
              </Badge>
            ) : null}
            {kpi?.lastContactedAt ? (
              <span
                className="text-xs text-muted"
                title={new Date(kpi.lastContactedAt).toLocaleString()}
              >
                Last contacted {detailRelativeTime(kpi.lastContactedAt)}
              </span>
            ) : null}
          </div>
          <CustomerRecipientsRow
            primaryEmail={customer.primaryEmail}
            billingEmails={customer.billingEmails ?? []}
            phone={customer.phone}
            shopifyCustomerId={customer.shopifyCustomerId}
          />
          <ShopifyTagsRow tagsQuery={tagsQuery} />
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {/* Per-customer QB refresh — fast path for "I need fresh data
              before sending a statement". Doesn't touch other customers. */}
          <SyncCustomerButton customerId={customer.id} />
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
          <StatusActions
            holdStatus={customer.holdStatus}
            disabled={holdToggleMutation.isPending}
            onRequest={(target) => {
              setPendingTarget(target);
              setHoldDialogOpen(true);
            }}
          />
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

      <Dialog
        open={holdDialogOpen}
        onOpenChange={(next) => {
          setHoldDialogOpen(next);
          if (!next) setPendingTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingTarget === "hold"
                ? "Put on hold?"
                : pendingTarget === "payment_upfront"
                  ? "Set to payment upfront?"
                  : "Set to active?"}
            </DialogTitle>
            <DialogDescription>
              {pendingTarget === "hold"
                ? `This will remove ${customer.displayName} from the B2B program by removing the 'b2b' Shopify tag.`
                : pendingTarget === "payment_upfront"
                  ? `This will keep ${customer.displayName} in the B2B program but flag every order as prepay-only. The 'b2b-b2b-upfront' tag is added on Shopify (and 'b2b' ensured present).`
                  : `This will restore ${customer.displayName} to standard B2B terms. The 'b2b-b2b-upfront' tag is removed and 'b2b' ensured present.`}
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
              onClick={() => {
                setHoldDialogOpen(false);
                setPendingTarget(null);
              }}
              disabled={holdToggleMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={
                pendingTarget === "hold"
                  ? "danger"
                  : pendingTarget === "payment_upfront"
                    ? "primary"
                    : "primary"
              }
              size="sm"
              onClick={() =>
                pendingTarget && holdToggleMutation.mutate(pendingTarget)
              }
              disabled={holdToggleMutation.isPending || !pendingTarget}
              loading={holdToggleMutation.isPending}
            >
              {pendingTarget === "hold"
                ? "Put on hold"
                : pendingTarget === "payment_upfront"
                  ? "Set payment upfront"
                  : "Set active"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
        <StatCard label="Open balance" value={`$${balance.toFixed(2)}`} />
        <StatCard
          label="Overdue"
          value={overdue > 0 ? `$${overdue.toFixed(2)}` : "—"}
          tone={overdue > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Open invoices"
          value={
            kpi?.openInvoiceCount && kpi.openInvoiceCount > 0
              ? String(kpi.openInvoiceCount)
              : "—"
          }
        />
        <StatCard
          label="Open tasks"
          value={
            kpi?.openTaskCount && kpi.openTaskCount > 0
              ? String(kpi.openTaskCount)
              : "—"
          }
        />
        <StatCard
          label="RMA in flight"
          value={kpi?.hasPendingRma ? "Yes" : "—"}
          tone={kpi?.hasPendingRma ? "warning" : "neutral"}
        />
        <TermsCard
          customerId={customer.id}
          currentTerms={customer.paymentTerms}
        />
      </div>

      <RecipientsAndTagsSection customer={customer} />

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
        {tab === "invoices" && (
          <InvoicesPanel
            customerId={customer.id}
            customerName={customer.displayName}
          />
        )}
        {tab === "orders" && <PlaceholderPanel label="Orders" />}
        {tab === "tasks" && <PlaceholderPanel label="Tasks" />}
        {tab === "returns" && (
          <ReturnsPanel customerId={customer.id} />
        )}
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

// Surfaces every recipient + system link finance-hub knows for this
// customer: primary email (TO), billing emails (CC list on statements +
// chase), phone (read-only for now), and the linked Shopify customer
// id (with a deep link to the Shopify admin if the env tells us the
// store domain). Kept compact — the heading row above is dense already.
function CustomerRecipientsRow({
  primaryEmail,
  billingEmails,
  phone,
  shopifyCustomerId,
}: {
  primaryEmail: string | null;
  billingEmails: string[];
  phone: string | null;
  shopifyCustomerId: string | null;
}) {
  // Drop the primary from the billing list — it's already shown above
  // as the canonical TO. Lower-case dedup defends against QBO drift
  // (some customers have the same address in both fields, just cased
  // differently).
  const ccEmails = billingEmails.filter(
    (e) =>
      e &&
      (!primaryEmail ||
        e.trim().toLowerCase() !== primaryEmail.trim().toLowerCase()),
  );
  const shopDomain =
    typeof window !== "undefined"
      ? // The dev server doesn't know about the Shopify store domain on
        // the client side; fall back to a search URL that resolves on
        // the operator's logged-in admin tab.
        "admin.shopify.com"
      : null;
  const shopifyHref =
    shopifyCustomerId && shopDomain
      ? `https://${shopDomain}/store/feldart/customers/${encodeURIComponent(shopifyCustomerId)}`
      : null;

  if (
    ccEmails.length === 0 &&
    !phone &&
    !shopifyCustomerId
  ) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {ccEmails.length > 0 ? (
        <span className="inline-flex items-center gap-1">
          <Mail className="size-3" />
          Also sent to:{" "}
          <span className="text-secondary">
            {ccEmails.map((e, i) => (
              <span key={e}>
                {i > 0 ? ", " : ""}
                <span title={e}>{e}</span>
              </span>
            ))}
          </span>
        </span>
      ) : null}
      {phone ? (
        <span className="inline-flex items-center gap-1 text-secondary">
          <CreditCard className="size-3 text-muted" />
          {phone}
        </span>
      ) : null}
      {shopifyCustomerId ? (
        <span className="inline-flex items-center gap-1">
          <ShoppingBag className="size-3" />
          Shopify:{" "}
          {shopifyHref ? (
            <a
              href={shopifyHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-accent-primary hover:underline"
            >
              {shopifyCustomerId}
              <ExternalLink className="ml-0.5 inline size-3" />
            </a>
          ) : (
            <span className="font-mono text-secondary">
              {shopifyCustomerId}
            </span>
          )}
        </span>
      ) : null}
    </div>
  );
}

// Three-way status action buttons. The current state's button is
// hidden; the other two are shown — Hold = danger styling, others =
// secondary. Click → fires onRequest with the target which the parent
// pipes into the confirm dialog.
function StatusActions({
  holdStatus,
  disabled,
  onRequest,
}: {
  holdStatus: "active" | "hold" | "payment_upfront";
  disabled: boolean;
  onRequest: (target: "active" | "hold" | "payment_upfront") => void;
}) {
  const showActiveButton = holdStatus !== "active";
  const showUpfrontButton = holdStatus !== "payment_upfront";
  const showHoldButton = holdStatus !== "hold";
  return (
    <>
      {showActiveButton ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onRequest("active")}
          disabled={disabled}
        >
          <Play className="size-3.5" />
          Set active
        </Button>
      ) : null}
      {showUpfrontButton ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onRequest("payment_upfront")}
          disabled={disabled}
        >
          <CreditCard className="size-3.5" />
          Payment upfront
        </Button>
      ) : null}
      {showHoldButton ? (
        <Button
          variant="danger"
          size="sm"
          onClick={() => onRequest("hold")}
          disabled={disabled}
        >
          <Pause className="size-3.5" />
          Put on hold
        </Button>
      ) : null}
    </>
  );
}

// "Recipients & tags" section. Two stacked cards — one for invoice
// recipients, one for statement recipients — each editable. Plus a
// tags chip input with auto-BCC hints when a tag matches an
// email_routing_rules row. All edits hit PATCH /api/customers/:id;
// the route handles the QBO push for invoice-side fields.
function RecipientsAndTagsSection({ customer }: { customer: Customer }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <ChannelEmailsCard
        customerId={customer.id}
        title="Invoice recipients"
        helper="Where invoice emails are sent (when finance-hub sends)."
        toEmails={customer.invoiceToEmails}
        ccEmails={customer.invoiceCcEmails}
        bccEmails={customer.invoiceBccEmails}
        toField="invoiceToEmails"
        ccField="invoiceCcEmails"
        bccField="invoiceBccEmails"
        channel="invoice"
        tags={customer.tags ?? []}
      />
      <ChannelEmailsCard
        customerId={customer.id}
        title="Statement & chase recipients"
        helper="Where Statement.pdf and chase emails are sent."
        toEmails={customer.statementToEmails}
        ccEmails={customer.statementCcEmails}
        bccEmails={customer.statementBccEmails}
        toField="statementToEmails"
        ccField="statementCcEmails"
        bccField="statementBccEmails"
        channel="statement"
        tags={customer.tags ?? []}
      />
      <PhonesCard
        customerId={customer.id}
        phone={customer.phone}
        additionalPhones={customer.additionalPhones}
      />
      <TagsCard
        customerId={customer.id}
        currentTags={customer.tags ?? []}
      />
    </div>
  );
}

// One per channel (invoice / statement). Three identical chip-list
// fields: TO, CC, BCC. The values stored are the values used — no
// fallback to primary/billing magic. Tag-driven auto-BCC additions
// (e.g. "yiddy" → sales@feldart.com) are surfaced as a small read-
// only caption below the manual BCC chips so the operator sees the
// full effective recipient set. Writes via PATCH /api/customers/:id.
function ChannelEmailsCard({
  customerId,
  title,
  helper,
  toEmails,
  ccEmails,
  bccEmails,
  toField,
  ccField,
  bccField,
  channel,
  tags,
}: {
  customerId: string;
  title: string;
  helper: string;
  toEmails: string[] | null;
  ccEmails: string[] | null;
  bccEmails: string[] | null;
  toField: "invoiceToEmails" | "statementToEmails";
  ccField: "invoiceCcEmails" | "statementCcEmails";
  bccField: "invoiceBccEmails" | "statementBccEmails";
  channel: "invoice" | "statement";
  tags: string[];
}) {
  const queryClient = useQueryClient();

  // Pull the tag-driven routing rules once so we can show "auto-BCC:
  // sales@ (yiddy)" hints under the BCC field. Cached for 5 min.
  const rulesQuery = useQuery<{
    rules: Array<{ tag: string; action: string; value: string }>;
  }>({
    queryKey: ["email-routing-rules"],
    queryFn: async () => {
      const res = await fetch("/api/email-routing-rules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  const allRules = rulesQuery.data?.rules ?? [];
  const tagsLower = tags.map((t) => t.toLowerCase());
  const channelBccAction = channel === "invoice" ? "bcc_invoice" : "bcc_statement";
  const tagDerivedBccs = allRules.filter(
    (r) =>
      tagsLower.includes(r.tag.toLowerCase()) && r.action === channelBccAction,
  );

  const mutation = useMutation({
    mutationFn: async (
      patch: Partial<Record<typeof toField | typeof ccField | typeof bccField, string[] | null>>,
    ) => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
    },
  });

  return (
    <Card>
      <CardBody className="space-y-2 py-3">
        <div className="text-xs uppercase tracking-wide text-muted">
          {title}
        </div>
        <div className="text-[11px] text-muted">{helper}</div>
        <EmailChipList
          label="TO"
          values={toEmails ?? []}
          onChange={(next) =>
            mutation.mutate({
              [toField]: next.length > 0 ? next : null,
            } as never)
          }
          placeholder="add TO email and press enter"
        />
        <EmailChipList
          label="CC"
          values={ccEmails ?? []}
          onChange={(next) =>
            mutation.mutate({
              [ccField]: next.length > 0 ? next : null,
            } as never)
          }
          placeholder="add CC email and press enter"
        />
        <EmailChipList
          label="BCC"
          values={bccEmails ?? []}
          onChange={(next) =>
            mutation.mutate({
              [bccField]: next.length > 0 ? next : null,
            } as never)
          }
          placeholder="add BCC email and press enter"
        />
        {tagDerivedBccs.length > 0 ? (
          <div className="rounded-md border border-default bg-subtle px-2 py-1 text-[11px] text-secondary">
            <div className="font-medium text-accent-info">
              + auto-BCC from tags:
            </div>
            <ul className="ml-3 list-disc">
              {tagDerivedBccs.map((r, i) => (
                <li key={i}>
                  {r.value}{" "}
                  <span className="text-muted">({r.tag})</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {mutation.isError ? (
          <div className="text-[11px] text-accent-danger">
            {(mutation.error as Error)?.message ?? "save failed"}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// Reusable chip-list email input. The value is the source of truth;
// blur or Enter on the input adds; the X removes. onChange fires the
// new full list whenever entries are added/removed.
function EmailChipList({
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
  const [draft, setDraft] = useState<string[]>(values);
  const [input, setInput] = useState<string>("");

  // Re-sync from props after parent refetches.
  useEffect(() => {
    setDraft(values);
  }, [values]);

  function add() {
    const v = input.trim();
    if (!v) return;
    if (draft.some((e) => e.toLowerCase() === v.toLowerCase())) {
      setInput("");
      return;
    }
    const next = [...draft, v];
    setDraft(next);
    setInput("");
    onChange(next);
  }
  function remove(addr: string) {
    const next = draft.filter((e) => e.toLowerCase() !== addr.toLowerCase());
    setDraft(next);
    onChange(next);
  }

  return (
    <div>
      <span className="mb-0.5 block text-[11px] text-muted">{label}</span>
      {draft.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {draft.map((addr) => (
            <span
              key={addr}
              className="inline-flex items-center gap-1 rounded-md border border-default bg-subtle px-1.5 py-0.5 text-[10px]"
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

// Tags chip input. Lower-cases on save (server normalises again
// defensively). Each tag carries a small auto-BCC hint when an
// email_routing_rules row matches — populated by a side query.
function TagsCard({
  customerId,
  currentTags,
}: {
  customerId: string;
  currentTags: string[];
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string[]>(currentTags);
  const [input, setInput] = useState<string>("");

  useEffect(() => {
    setDraft(currentTags);
  }, [currentTags]);

  const rulesQuery = useQuery<{ rules: Array<{ tag: string; action: string; value: string }> }>({
    queryKey: ["email-routing-rules"],
    queryFn: async () => {
      const res = await fetch("/api/email-routing-rules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  const rules = rulesQuery.data?.rules ?? [];

  const mutation = useMutation({
    mutationFn: async (tags: string[]) => {
      const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
    },
  });

  function addTag() {
    const v = input.trim().toLowerCase();
    if (!v) return;
    if (draft.includes(v)) {
      setInput("");
      return;
    }
    const next = [...draft, v];
    setDraft(next);
    setInput("");
    mutation.mutate(next);
  }
  function removeTag(tag: string) {
    const next = draft.filter((t) => t !== tag);
    setDraft(next);
    mutation.mutate(next);
  }

  function describeRule(action: string, value: string): string {
    switch (action) {
      case "bcc_invoice":
        return `auto-BCC ${value} on invoices`;
      case "bcc_statement":
        return `auto-BCC ${value} on statements`;
      case "cc_invoice":
        return `auto-CC ${value} on invoices`;
      case "cc_statement":
        return `auto-CC ${value} on statements`;
      default:
        return `${action}: ${value}`;
    }
  }

  // Surface effects per tag — for any tag the user types that has
  // a matching rule, render a tiny caption.
  function effectsForTag(tag: string): string[] {
    return rules
      .filter((r) => r.tag.toLowerCase() === tag.toLowerCase())
      .map((r) => describeRule(r.action, r.value));
  }

  return (
    <Card>
      <CardBody className="space-y-2 py-3">
        <div className="text-xs uppercase tracking-wide text-muted">Tags</div>
        <div className="text-[11px] text-muted">
          Drives auto-routing rules. Match against Settings → Email
          routing rules.
        </div>
        {draft.length > 0 ? (
          <ul className="space-y-1">
            {draft.map((tag) => {
              const effects = effectsForTag(tag);
              return (
                <li key={tag} className="text-xs">
                  <span className="inline-flex items-center gap-1 rounded-md border border-default bg-subtle px-1.5 py-0.5 text-[10px]">
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="text-muted hover:text-accent-danger"
                      aria-label={`Remove tag ${tag}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                  {effects.length > 0 ? (
                    <ul className="ml-2 mt-0.5 list-disc text-[10px] text-accent-info">
                      {effects.map((e, i) => (
                        <li key={i} className="ml-2">
                          {e}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="flex gap-1">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="add tag (e.g. yiddy)"
            className="flex-1 rounded-md border border-default bg-base px-2 py-1 text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={addTag}
            disabled={!input.trim()}
          >
            Add
          </Button>
        </div>
        {mutation.isError ? (
          <div className="text-[11px] text-accent-danger">
            {(mutation.error as Error)?.message ?? "save failed"}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// Phones card. The "Main" line is mirrored from QBO (Customer.PrimaryPhone)
// on first sync, then locally authoritative — edits push back to QBO via
// pushCustomerPhoneToQbo (handled in the PATCH route). The labelled
// `additional_phones` list is local-only; QBO has no free-form list slot
// for "bookkeeper" / "owner" / "AR clerk" extras.
function PhonesCard({
  customerId,
  phone,
  additionalPhones,
}: {
  customerId: string;
  phone: string | null;
  additionalPhones: Array<{ label: string; number: string }> | null;
}) {
  const queryClient = useQueryClient();
  const [phoneDraft, setPhoneDraft] = useState<string>(phone ?? "");
  const [extras, setExtras] = useState<
    Array<{ label: string; number: string }>
  >(additionalPhones ?? []);
  const [newLabel, setNewLabel] = useState<string>("");
  const [newNumber, setNewNumber] = useState<string>("");

  // Re-sync from props when the parent refetches after a mutation.
  useEffect(() => {
    setPhoneDraft(phone ?? "");
  }, [phone]);
  useEffect(() => {
    setExtras(additionalPhones ?? []);
  }, [additionalPhones]);

  const mutation = useMutation({
    mutationFn: async (input: {
      phone?: string | null;
      additionalPhones?: Array<{ label: string; number: string }> | null;
    }) => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
    },
  });

  function savePhone() {
    const next = phoneDraft.trim();
    const payload = next.length > 0 ? next : null;
    if (payload === phone) return;
    mutation.mutate({ phone: payload });
  }

  function addExtra() {
    const label = newLabel.trim();
    const number = newNumber.trim();
    // Server enforces label.min(1) + number.min(3); enforce here too so
    // we don't fire a doomed PATCH and surface a confusing 400.
    if (!label || number.length < 3) return;
    if (extras.length >= 10) return;
    const next = [...extras, { label, number }];
    setExtras(next);
    setNewLabel("");
    setNewNumber("");
    mutation.mutate({ additionalPhones: next });
  }

  function removeExtra(idx: number) {
    const next = extras.filter((_, i) => i !== idx);
    setExtras(next);
    // Empty list → null so the column is clean rather than `[]`.
    mutation.mutate({ additionalPhones: next.length > 0 ? next : null });
  }

  function updateExtra(
    idx: number,
    patch: Partial<{ label: string; number: string }>,
  ) {
    setExtras((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)),
    );
  }

  function saveExtras() {
    // Skip empty/short rows — the server would 400 anyway.
    if (
      extras.some(
        (e) => !e.label.trim() || e.number.trim().length < 3,
      )
    ) {
      return;
    }
    mutation.mutate({ additionalPhones: extras.length > 0 ? extras : null });
  }

  return (
    <Card>
      <CardBody className="space-y-2 py-3">
        <div className="text-xs uppercase tracking-wide text-muted">Phones</div>
        <div className="text-[11px] text-muted">
          Main syncs to QuickBooks. Additional lines are local-only.
        </div>
        <label className="block">
          <span className="mb-0.5 block text-[11px] text-muted">Main</span>
          <input
            type="tel"
            value={phoneDraft}
            onChange={(e) => setPhoneDraft(e.target.value)}
            onBlur={savePhone}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="(555) 123-4567"
            className="w-full rounded-md border border-default bg-base px-2 py-1 text-xs"
          />
        </label>
        <div>
          <span className="mb-0.5 block text-[11px] text-muted">
            Additional ({extras.length}/10)
          </span>
          {extras.length > 0 ? (
            <ul className="mb-1 space-y-1">
              {extras.map((e, i) => (
                <li key={i} className="flex gap-1">
                  <input
                    type="text"
                    value={e.label}
                    onChange={(ev) =>
                      updateExtra(i, { label: ev.target.value })
                    }
                    onBlur={saveExtras}
                    placeholder="Label"
                    className="w-20 rounded-md border border-default bg-base px-1.5 py-0.5 text-[11px]"
                  />
                  <input
                    type="tel"
                    value={e.number}
                    onChange={(ev) =>
                      updateExtra(i, { number: ev.target.value })
                    }
                    onBlur={saveExtras}
                    placeholder="Number"
                    className="flex-1 rounded-md border border-default bg-base px-1.5 py-0.5 text-[11px]"
                  />
                  <button
                    type="button"
                    onClick={() => removeExtra(i)}
                    className="rounded p-1 text-muted hover:text-accent-danger"
                    aria-label={`Remove ${e.label || "phone"}`}
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {extras.length < 10 ? (
            <div className="flex gap-1">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label"
                className="w-20 rounded-md border border-default bg-base px-1.5 py-0.5 text-[11px]"
              />
              <input
                type="tel"
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExtra();
                  }
                }}
                placeholder="Number"
                className="flex-1 rounded-md border border-default bg-base px-1.5 py-0.5 text-[11px]"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={addExtra}
                disabled={!newLabel.trim() || newNumber.trim().length < 3}
              >
                Add
              </Button>
            </div>
          ) : null}
        </div>
        {mutation.isError ? (
          <div className="text-[11px] text-accent-danger">
            {(mutation.error as Error)?.message ?? "save failed"}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// Invoices tab. Lists the customer's invoices newest-first (max 100)
// from the local invoices table. Each row carries a Send button —
// finance-hub PATCHes BillEmail/Cc/Bcc on the QBO Invoice with the
// resolved recipients, then calls /send. Sent rows show a sent-at
// pill instead of a button.
// Unified row type — invoices + credit memos. The docType
// discriminator drives the "type" pill, the Send dialog body
// (different /send endpoint per type) and a couple of small
// rendering branches (no due date on credit memos, etc).
type InvoiceRow = {
  docType: "invoice" | "credit_memo";
  id: string | null;
  qbId: string;
  docNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  total: string;
  balance: string;
  status: string | null;
  customerMemo: string | null;
  sentAt: string | null;
  sentVia: string | null;
};

type StatusFilter = "all" | "open" | "paid" | "overdue" | "sent" | "void";
type TypeFilter = "all" | "invoice" | "credit_memo";
type SortKey = "issueDate" | "docNumber" | "total" | "balance";
type SortDir = "asc" | "desc";

function InvoicesPanel({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { data, isPending, isError, error } = useQuery<{
    invoices: InvoiceRow[];
    creditMemoError: string | null;
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

  const [sending, setSending] = useState<InvoiceRow | null>(null);
  const [sentSuccess, setSentSuccess] =
    useState<InvoiceSendSuccess | null>(null);
  const [reminding, setReminding] = useState<InvoiceRow | null>(null);
  const [reminderSuccess, setReminderSuccess] =
    useState<InvoiceReminderSuccess | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("issueDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Selection — keyed by docType:qbId so invoices and credit memos
  // with overlapping QBO ids don't collide.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPdfPending, setBulkPdfPending] = useState<boolean>(false);
  const [bulkPdfError, setBulkPdfError] = useState<string | null>(null);

  function rowKey(r: InvoiceRow): string {
    return `${r.docType}:${r.qbId}`;
  }
  function toggleRow(r: InvoiceRow) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(r);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }

  useEffect(() => {
    if (!sentSuccess) return;
    const t = setTimeout(() => setSentSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [sentSuccess]);

  useEffect(() => {
    if (!reminderSuccess) return;
    const t = setTimeout(() => setReminderSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [reminderSuccess]);

  const allRows = data?.invoices ?? [];

  const filteredRows = useMemo<InvoiceRow[]>(() => {
    const q = search.trim().toLowerCase();
    return allRows
      .filter((r: InvoiceRow) => typeFilter === "all" || r.docType === typeFilter)
      .filter((r: InvoiceRow) => {
        if (statusFilter === "all") return true;
        const balance = Number(r.balance);
        const isPaid =
          r.status === "paid" ||
          r.status === "applied" ||
          balance <= 0;
        if (statusFilter === "open") return balance > 0;
        if (statusFilter === "paid") return isPaid;
        if (statusFilter === "overdue") return r.status === "overdue";
        if (statusFilter === "sent") return r.status === "sent";
        if (statusFilter === "void") return r.status === "void";
        return true;
      })
      .filter((r: InvoiceRow) => {
        if (!q) return true;
        return (r.docNumber ?? "").toLowerCase().includes(q);
      })
      .sort((a: InvoiceRow, b: InvoiceRow) => {
        const cmp = compareRows(a, b, sortKey);
        return sortDir === "asc" ? cmp : -cmp;
      });
  }, [allRows, statusFilter, typeFilter, search, sortKey, sortDir]);

  const totals = useMemo(() => {
    let totalSum = 0;
    let openSum = 0;
    for (const r of filteredRows) {
      totalSum += Number(r.total);
      if (Number(r.balance) > 0) openSum += Number(r.balance);
    }
    return { totalSum, openSum };
  }, [filteredRows]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  // True when every currently-visible (filtered) row is selected;
  // drives the header checkbox's tri-state look.
  const allVisibleSelected =
    filteredRows.length > 0 &&
    filteredRows.every((r) => selected.has(rowKey(r)));
  const someVisibleSelected =
    !allVisibleSelected &&
    filteredRows.some((r) => selected.has(rowKey(r)));

  function toggleSelectAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        // Deselect just the visible ones (preserve any selection
        // outside the current filter).
        const next = new Set(prev);
        for (const r of filteredRows) next.delete(rowKey(r));
        return next;
      }
      const next = new Set(prev);
      for (const r of filteredRows) next.add(rowKey(r));
      return next;
    });
  }

  // Selected rows materialised — used by the bulk-action bar's
  // count + the bulk download payload.
  const selectedRows = useMemo<InvoiceRow[]>(
    () => allRows.filter((r) => selected.has(rowKey(r))),
    [allRows, selected],
  );

  async function downloadSelectedPdfs(): Promise<void> {
    if (selectedRows.length === 0) return;
    setBulkPdfPending(true);
    setBulkPdfError(null);
    try {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/invoices/bulk-pdf`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            docs: selectedRows.map((r) => ({
              docType: r.docType,
              qbId: r.qbId,
            })),
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      // Trigger a browser download of the streamed ZIP. Filename
      // comes from the server's Content-Disposition header but
      // browsers honour the <a download> attr too.
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m?.[1] ?? `documents-${customerId}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setBulkPdfError(
        err instanceof Error ? err.message : "download failed",
      );
    } finally {
      setBulkPdfPending(false);
    }
  }

  if (isPending) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-muted">
          Loading documents…
        </CardBody>
      </Card>
    );
  }
  if (isError) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-accent-danger">
          {(error as Error)?.message ?? "Failed to load documents"}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      {sentSuccess ? (
        <div
          role="status"
          className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-accent-success/30 bg-accent-success/10 px-3 py-2 text-sm text-accent-success"
        >
          <CheckCircle2 className="size-4" />
          <span>
            Sent
            {sentSuccess.docNumber ? ` ${sentSuccess.docNumber}` : ""} ·{" "}
            TO {sentSuccess.to.join(", ")}
            {sentSuccess.cc.length > 0
              ? ` · CC ${sentSuccess.cc.length}`
              : ""}
            {sentSuccess.bcc.length > 0
              ? ` · BCC ${sentSuccess.bcc.length}`
              : ""}
          </span>
        </div>
      ) : null}
      {reminderSuccess ? (
        <div
          role="status"
          className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-accent-success/30 bg-accent-success/10 px-3 py-2 text-sm text-accent-success"
        >
          <CheckCircle2 className="size-4" />
          <span>
            Reminder sent
            {reminderSuccess.docNumber
              ? ` for invoice ${reminderSuccess.docNumber}`
              : ""}
          </span>
        </div>
      ) : null}

      <CardBody className="space-y-3 py-3">
        {/* Filter + search row */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <FilterChip
            label="All"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          <FilterChip
            label="Open"
            active={statusFilter === "open"}
            onClick={() => setStatusFilter("open")}
          />
          <FilterChip
            label="Paid"
            active={statusFilter === "paid"}
            onClick={() => setStatusFilter("paid")}
          />
          <FilterChip
            label="Overdue"
            active={statusFilter === "overdue"}
            onClick={() => setStatusFilter("overdue")}
          />
          <FilterChip
            label="Sent"
            active={statusFilter === "sent"}
            onClick={() => setStatusFilter("sent")}
          />
          <FilterChip
            label="Void"
            active={statusFilter === "void"}
            onClick={() => setStatusFilter("void")}
          />
          <span className="mx-1 h-4 w-px bg-default" />
          <FilterChip
            label="All types"
            active={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
          />
          <FilterChip
            label="Invoices"
            active={typeFilter === "invoice"}
            onClick={() => setTypeFilter("invoice")}
          />
          <FilterChip
            label="Credit memos"
            active={typeFilter === "credit_memo"}
            onClick={() => setTypeFilter("credit_memo")}
          />
          <div className="ml-auto">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search doc#…"
              className="w-40 rounded-md border border-default bg-base px-2 py-1 text-xs"
            />
          </div>
        </div>

        {data?.creditMemoError ? (
          <div className="rounded-md border border-accent-warning/30 bg-accent-warning/10 px-3 py-2 text-xs text-accent-warning">
            Couldn't load credit memos from QuickBooks:{" "}
            {data.creditMemoError}. Showing invoices only.
          </div>
        ) : null}

        {selectedRows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-primary/30 bg-accent-primary/10 px-3 py-2 text-sm">
            <div>
              <span className="font-medium text-accent-primary">
                {selectedRows.length} selected
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="ml-2 text-xs text-muted hover:text-accent-danger"
              >
                clear
              </button>
            </div>
            <div className="flex items-center gap-2">
              {bulkPdfError ? (
                <span className="text-[11px] text-accent-danger">
                  {bulkPdfError}
                </span>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={downloadSelectedPdfs}
                disabled={bulkPdfPending}
                loading={bulkPdfPending}
              >
                <FileText className="size-3.5" />
                Download {selectedRows.length} PDF
                {selectedRows.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        ) : null}

        {filteredRows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted">
            {allRows.length === 0
              ? "No documents on file."
              : "No documents match the current filters."}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-default">
            <table className="w-full text-sm">
              <thead className="bg-elevated text-left text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        // tri-state: indeterminate when partial.
                        if (el) el.indeterminate = someVisibleSelected;
                      }}
                      onChange={toggleSelectAllVisible}
                      aria-label={
                        allVisibleSelected
                          ? "Deselect all visible"
                          : "Select all visible"
                      }
                      className="cursor-pointer"
                    />
                  </th>
                  <SortHeader
                    label="Doc #"
                    sortKey="docNumber"
                    activeKey={sortKey}
                    activeDir={sortDir}
                    onClick={toggleSort}
                  />
                  <th className="px-3 py-2 font-medium">Type</th>
                  <SortHeader
                    label="Issued"
                    sortKey="issueDate"
                    activeKey={sortKey}
                    activeDir={sortDir}
                    onClick={toggleSort}
                  />
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Memo</th>
                  <SortHeader
                    label="Total"
                    sortKey="total"
                    activeKey={sortKey}
                    activeDir={sortDir}
                    onClick={toggleSort}
                    align="right"
                  />
                  <SortHeader
                    label="Balance"
                    sortKey="balance"
                    activeKey={sortKey}
                    activeDir={sortDir}
                    onClick={toggleSort}
                    align="right"
                  />
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <InvoiceTableRow
                    key={`${row.docType}:${row.qbId}`}
                    row={row}
                    selected={selected.has(rowKey(row))}
                    onToggle={() => toggleRow(row)}
                    onSend={() => setSending(row)}
                    onRemind={() => setReminding(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filteredRows.length > 0 ? (
          <div className="flex items-center justify-between text-xs text-muted">
            <div>
              Showing {filteredRows.length} of {allRows.length}
            </div>
            <div className="flex items-center gap-3 tabular-nums">
              <span>
                Total{" "}
                <span className="text-primary">
                  ${totals.totalSum.toFixed(2)}
                </span>
              </span>
              <span>
                Open{" "}
                <span
                  className={
                    totals.openSum > 0
                      ? "text-accent-warning"
                      : "text-muted"
                  }
                >
                  ${totals.openSum.toFixed(2)}
                </span>
              </span>
            </div>
          </div>
        ) : null}
      </CardBody>

      {sending ? (
        <InvoiceSendDialog
          open={true}
          onOpenChange={(next) => {
            if (!next) setSending(null);
          }}
          customerId={customerId}
          customerName={customerName}
          invoice={{
            qbInvoiceId: sending.qbId,
            docNumber: sending.docNumber,
            total: sending.total,
            balance: sending.balance,
            issueDate: sending.issueDate,
            dueDate: sending.dueDate,
          }}
          docType={sending.docType}
          onSent={(result) => {
            setSentSuccess(result);
            setSending(null);
          }}
        />
      ) : null}

      {reminding ? (
        <InvoiceReminderDialog
          open={true}
          onOpenChange={(next) => {
            if (!next) setReminding(null);
          }}
          customerId={customerId}
          customerName={customerName}
          invoice={{
            qbInvoiceId: reminding.qbId,
            docNumber: reminding.docNumber,
            total: reminding.total,
            balance: reminding.balance,
            issueDate: reminding.issueDate,
            dueDate: reminding.dueDate,
          }}
          onSent={(result) => {
            setReminderSuccess(result);
            setReminding(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function compareRows(a: InvoiceRow, b: InvoiceRow, key: SortKey): number {
  switch (key) {
    case "issueDate":
      return (a.issueDate ?? "").localeCompare(b.issueDate ?? "");
    case "docNumber":
      return (a.docNumber ?? "").localeCompare(b.docNumber ?? "");
    case "total":
      return Number(a.total) - Number(b.total);
    case "balance":
      return Number(a.balance) - Number(b.balance);
    default:
      return 0;
  }
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-1 text-xs transition-colors",
        active
          ? "border-accent-primary bg-accent-primary/10 font-medium text-accent-primary"
          : "border-default text-secondary hover:bg-elevated hover:text-primary",
      )}
    >
      {label}
    </button>
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  activeDir,
  onClick,
  align,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  activeDir: SortDir;
  onClick: (k: SortKey) => void;
  align?: "right";
}) {
  const isActive = activeKey === sortKey;
  return (
    <th
      className={cn(
        "px-3 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          "inline-flex items-center gap-0.5 hover:text-primary",
          isActive && "text-primary",
        )}
      >
        {label}
        {isActive ? (
          <span className="text-[9px]">
            {activeDir === "asc" ? "▲" : "▼"}
          </span>
        ) : null}
      </button>
    </th>
  );
}

function InvoiceTableRow({
  row,
  selected,
  onToggle,
  onSend,
  onRemind,
}: {
  row: InvoiceRow;
  selected: boolean;
  onToggle: () => void;
  onSend: () => void;
  onRemind: () => void;
}) {
  const total = Number(row.total);
  const balance = Number(row.balance);
  const isPaid =
    row.status === "paid" ||
    row.status === "applied" ||
    balance <= 0;
  // /api/qb-pdf/{kind}/{qbId} — mounted in src/server/routes/qb-pdf.ts.
  const pdfHref = `/api/qb-pdf/${row.docType === "credit_memo" ? "creditmemo" : "invoice"}/${encodeURIComponent(row.qbId)}`;
  // Has this doc been sent before? Drives the "sent" caption +
  // Send→Re-send label flip. Three signals can flag it:
  //   - finance-hub stamped sent_at after a local send
  //   - the credit-memo path tagged sent_at = "(sent)" because QBO's
  //     EmailStatus = "EmailSent"
  //   - for invoices, any non-draft non-void status implies the doc
  //     has been sent at least once (paid/partial/sent/overdue all
  //     started life as a Send)
  const wasSent =
    row.sentAt !== null ||
    row.status === "sent" ||
    row.status === "partial" ||
    row.status === "paid" ||
    row.status === "overdue";
  return (
    <tr
      className={cn(
        "border-t border-default",
        selected && "bg-accent-primary/5",
      )}
    >
      <td className="w-8 px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${row.docNumber ?? row.qbId}`}
          className="cursor-pointer"
        />
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {row.docNumber ?? "—"}
      </td>
      <td className="px-3 py-2">
        {row.docType === "credit_memo" ? (
          <Badge tone="info">Credit memo</Badge>
        ) : (
          <Badge tone="neutral">Invoice</Badge>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-secondary">
        {row.issueDate ?? "—"}
      </td>
      <td className="px-3 py-2 text-xs text-secondary">
        {row.dueDate ?? "—"}
      </td>
      <td className="px-3 py-2 max-w-[220px] text-xs text-secondary">
        {row.customerMemo ? (
          <span
            className="block truncate"
            title={row.customerMemo}
          >
            {row.customerMemo}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs">
        ${total.toFixed(2)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs">
        {balance > 0 ? (
          <span
            className={
              row.docType === "credit_memo"
                ? "text-accent-info"
                : "text-accent-warning"
            }
            title={
              row.docType === "credit_memo"
                ? "Unapplied credit memo balance — still available to apply against an invoice"
                : "Open invoice balance"
            }
          >
            ${balance.toFixed(2)}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        <InvoiceStatusBadge status={row.status} isPaid={isPaid} />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex flex-col items-end gap-0.5">
          <div className="flex items-center justify-end gap-2">
            <a
              href={pdfHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-default bg-base px-2 text-xs font-medium text-secondary hover:bg-elevated hover:text-primary"
              title={`Open ${row.docType === "credit_memo" ? "credit memo" : "invoice"} PDF`}
            >
              <FileText className="size-3.5" />
              PDF
            </a>
            {row.docType === "invoice" && balance > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={onRemind}
                title="Send a custom reminder email with the invoice attached"
              >
                <Mail className="size-3.5" />
                Remind
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={onSend}>
              <Send className="size-3.5" />
              {wasSent ? "Re-send" : "Send"}
            </Button>
          </div>
          {wasSent ? (
            <span
              className="text-[10px] text-muted"
              title={
                row.sentVia
                  ? `Last sent via ${row.sentVia}`
                  : "Sent at some point"
              }
            >
              {row.sentAt && row.sentAt !== "(sent)"
                ? `sent ${new Date(row.sentAt).toLocaleDateString()}`
                : "sent"}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function InvoiceStatusBadge({
  status,
  isPaid,
}: {
  status: string | null;
  isPaid: boolean;
}) {
  if (isPaid) return <Badge tone="success">Paid</Badge>;
  if (status === "overdue") return <Badge tone="critical">Overdue</Badge>;
  if (status === "partial") return <Badge tone="high">Partial</Badge>;
  if (status === "sent") return <Badge tone="info">Sent</Badge>;
  if (status === "void") return <Badge tone="medium">Void</Badge>;
  if (status === "draft") return <Badge tone="medium">Draft</Badge>;
  if (status === "open") return <Badge tone="info">Open</Badge>;
  if (status === "applied") return <Badge tone="success">Applied</Badge>;
  return <Badge tone="medium">—</Badge>;
}

// ─── Returns tab ─────────────────────────────────────────────────────────────

type RmaStatus =
  | "draft"
  | "approved"
  | "awaiting_warehouse_number"
  | "sent_to_warehouse"
  | "received"
  | "completed"
  | "denied"
  | "cancelled";

type RmaReturnType = "damage" | "seasonal" | "non_seasonal";

type RmaRow = {
  id: string;
  rmaNumber: string | null;
  returnType: RmaReturnType;
  status: RmaStatus;
  totalValue: string;
  createdAt: string;
  completedAt: string | null;
  // Used to compute "stuck N days" badges for awaiting-return rows.
  sentToWarehouseAt: string | null;
  approvedAt: string | null;
  trackingNumber: string | null;
};

type RmaListResponse = { rmas: RmaRow[] };

const RMA_STATUS_LABELS: Record<RmaStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting warehouse #",
  sent_to_warehouse: "Awaiting return",
  received: "Received",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
};

type BadgeTone = "critical" | "high" | "medium" | "low" | "neutral" | "info" | "success";

const RMA_STATUS_TONES: Record<RmaStatus, BadgeTone> = {
  draft: "neutral",
  approved: "success",
  awaiting_warehouse_number: "high",
  sent_to_warehouse: "info",
  received: "info",
  completed: "success",
  denied: "critical",
  cancelled: "neutral",
};

const RMA_TYPE_LABELS: Record<RmaReturnType, string> = {
  damage: "Damage",
  seasonal: "Seasonal",
  non_seasonal: "Non-seasonal",
};

// Statuses that are considered "open" (in-flight / pending resolution).
const OPEN_STATUSES = new Set<RmaStatus>([
  "draft",
  "approved",
  "awaiting_warehouse_number",
  "sent_to_warehouse",
  "received",
]);

// "Stuck" = approved / awaiting_warehouse_number / sent_to_warehouse status
// that's been sitting longer than expected without forward progress. We use
// the most relevant timestamp (sentToWarehouseAt for "Awaiting return",
// approvedAt for the others) so the count reflects time since the operator
// last took action — not just how long the RMA has existed. Returns 0 when
// the RMA isn't in a stuckable state.
function stuckDays(r: {
  status: RmaStatus;
  sentToWarehouseAt: string | null;
  approvedAt: string | null;
}): number {
  let anchor: string | null;
  switch (r.status) {
    case "sent_to_warehouse":
      anchor = r.sentToWarehouseAt ?? r.approvedAt;
      break;
    case "awaiting_warehouse_number":
    case "approved":
      anchor = r.approvedAt;
      break;
    default:
      return 0;
  }
  if (!anchor) return 0;
  const ms = Date.now() - new Date(anchor).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function ReturnsPanel({ customerId }: { customerId: string }) {
  const [statusFilter, setStatusFilter] = useState<RmaStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<RmaReturnType | "all">("all");

  const { data, isPending, isError, error } = useQuery<RmaListResponse>({
    queryKey: ["customer-rmas", customerId],
    queryFn: async () => {
      const res = await fetch(
        `/api/rmas?customerId=${encodeURIComponent(customerId)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const allRows = data?.rmas ?? [];

  // Summary stats derived from the full (unfiltered) list.
  const summary = useMemo(() => {
    const currentYearStart = new Date(new Date().getFullYear(), 0, 1);
    let open = 0;
    let inFlight = 0;
    let completedYtd = 0;
    let stuck = 0;
    for (const r of allRows) {
      if (OPEN_STATUSES.has(r.status)) {
        open++;
        inFlight += Number(r.totalValue);
      }
      if (stuckDays(r) >= 7) stuck++;
      if (
        r.status === "completed" &&
        r.completedAt &&
        new Date(r.completedAt) >= currentYearStart
      ) {
        completedYtd++;
      }
    }
    return { open, inFlight, completedYtd, stuck };
  }, [allRows]);

  const filteredRows = useMemo(() => {
    return allRows
      .filter((r) => statusFilter === "all" || r.status === statusFilter)
      .filter((r) => typeFilter === "all" || r.returnType === typeFilter);
  }, [allRows, statusFilter, typeFilter]);

  const anyFilterActive = statusFilter !== "all" || typeFilter !== "all";

  return (
    <div className="space-y-3">
      {/* Header row: summary + create button */}
      <div className="flex items-start justify-between gap-4">
        <div className="text-sm text-secondary">
          <span className="font-medium text-primary">{summary.open}</span> open
          {" · "}
          <span className="font-medium text-primary">
            ${summary.inFlight.toFixed(2)}
          </span>{" "}
          in flight
          {" · "}
          <span className="font-medium text-primary">{summary.completedYtd}</span>{" "}
          completed YTD
          {summary.stuck > 0 && (
            <>
              {" · "}
              <span className="font-medium text-accent-warning">
                {summary.stuck} stuck &gt;7d
              </span>
            </>
          )}
        </div>
        <Link
          to="/returns/new"
          search={{ customerId } as never}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-default bg-base px-3 py-1.5 text-xs font-medium text-secondary hover:bg-elevated hover:text-primary"
        >
          <RotateCcw className="size-3.5" />
          Create return
        </Link>
      </div>

      {/* Filter chips: status + type */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Status:</span>
          <ReturnFilterChip
            label="All"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          {(Object.keys(RMA_STATUS_LABELS) as RmaStatus[]).map((s) => (
            <ReturnFilterChip
              key={s}
              label={RMA_STATUS_LABELS[s]}
              active={statusFilter === s}
              onClick={() =>
                setStatusFilter((prev) => (prev === s ? "all" : s))
              }
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Type:</span>
          <ReturnFilterChip
            label="All"
            active={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
          />
          {(Object.keys(RMA_TYPE_LABELS) as RmaReturnType[]).map((t) => (
            <ReturnFilterChip
              key={t}
              label={RMA_TYPE_LABELS[t]}
              active={typeFilter === t}
              onClick={() =>
                setTypeFilter((prev) => (prev === t ? "all" : t))
              }
            />
          ))}
        </div>
        {anyFilterActive && (
          <button
            type="button"
            onClick={() => {
              setStatusFilter("all");
              setTypeFilter("all");
            }}
            className="text-xs text-muted hover:text-primary"
          >
            Clear filters
          </button>
        )}
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-secondary">
            {isPending
              ? "Loading…"
              : `${filteredRows.length} RMA${filteredRows.length === 1 ? "" : "s"}`}
          </h2>
        </CardHeader>
        <CardBody className="p-0">
          {isError && (
            <div className="p-4 text-sm text-accent-danger">
              {(error as Error)?.message ?? "Failed to load returns"}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">RMA #</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-default last:border-b-0 hover:bg-elevated"
                >
                  <td className="px-3 py-2 font-medium">
                    <Link
                      to="/returns/$rmaId"
                      params={{ rmaId: r.id }}
                      className="font-mono text-xs hover:text-accent-primary hover:underline underline-offset-2"
                    >
                      {r.rmaNumber ?? `Draft ${r.id.slice(0, 6)}…`}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-secondary">
                    {RMA_TYPE_LABELS[r.returnType]}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={RMA_STATUS_TONES[r.status]}>
                        {RMA_STATUS_LABELS[r.status]}
                      </Badge>
                      {(() => {
                        const days = stuckDays(r);
                        if (days < 7) return null;
                        const tone: BadgeTone = days >= 14 ? "critical" : "high";
                        return (
                          <Badge tone={tone}>
                            stuck {days}d
                          </Badge>
                        );
                      })()}
                      {r.trackingNumber && r.status === "sent_to_warehouse" && (
                        <Badge tone="info">tracked</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span
                      className={cn(
                        "font-medium",
                        Number(r.totalValue) > 0
                          ? "text-primary"
                          : "text-muted",
                      )}
                    >
                      ${Number(r.totalValue).toFixed(2)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-secondary">
                    {new Date(r.createdAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <RmaRowMenu
                      rmaId={r.id}
                      status={r.status}
                      // Mirror the keys invalidateAfterRmaChange touches so
                      // the customer-detail KPI strip ("hasPendingRma"),
                      // activity timeline, customers list flag, and chase
                      // RMA pill all refresh after cancel/delete from this
                      // menu. The menu accepts plain query keys, so we
                      // duplicate the helper's set here. (The ["rma", id]
                      // detail key is omitted — operator is on the customer
                      // page, not the detail.)
                      invalidateKeys={[
                        ["returns-list"],
                        ["rmas"],
                        ["customer-rmas", customerId],
                        ["customer", customerId],
                        ["customers"],
                        ["chase", "customers"],
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!isPending && filteredRows.length === 0 && (
                <tr>
                  <td
                    className="p-8 text-center text-sm text-muted"
                    colSpan={6}
                  >
                    No RMAs match the current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

// Short relative-time formatter for the "Last contacted N ago" chip in
// the customer header. Mirrors the chase-page relativeTime() shape but
// kept local — the chase helper isn't a public export and the customer
// detail file already has its own helper section.
function detailRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks <= 6) return `${weeks}w ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : "numeric",
  });
}

function ReturnFilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 transition-colors",
        active
          ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
          : "border-default text-secondary hover:bg-elevated hover:text-primary",
      )}
    >
      {label}
    </button>
  );
}
