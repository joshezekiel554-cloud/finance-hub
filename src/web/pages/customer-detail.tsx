import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams, Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import { useFilterNavigate } from "../lib/use-filter-navigate";
import { useFilterPersistence } from "../lib/use-filter-persistence";
import type { CustomerDetailSearch } from "../lib/search-schemas/customer-detail";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Pause,
  Mail,
  FileText,
  CheckCircle2,
  Pencil,
  X,
  Send,
  RotateCcw,
  Plus,
  Trash2,
  ClipboardList,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { CollapsibleCard } from "../components/ui/collapsible-card";
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
import type { Activity } from "../components/activity-timeline";
import RmaRowMenu from "../components/rma-row-menu";
import { EmailList } from "../components/email-list";
import { CallsSmsTab } from "../components/calls-sms-tab";
import { HoldBanner } from "../components/hold-banner";
import { SyncCustomerButton } from "../components/sync-customer-button";
import StatementSendDialog, {
  type StatementSendSuccess,
} from "../components/statement-send-dialog";
import ChaseEmailSendDialog, {
  type ChaseSendSuccess,
} from "../components/chase-email-send-dialog";
import ComposeModal, {
  type ComposeContext,
} from "../components/compose-modal";
import CustomerAiCard, {
  type CardAction as AiCardAction,
} from "../components/customer-ai-card";
import { DisputeActions } from "../components/dispute-actions";
import {
  TaskDetailDrawer,
  type DrawerMode as TaskDrawerMode,
} from "../components/task-detail-drawer";
import { TaskList } from "../components/task-list";
import type { TaskCardData } from "../components/task-card";
import InvoiceSendDialog, {
  type InvoiceSendSuccess,
} from "../components/invoice-send-dialog";
import InvoiceReminderDialog, {
  type InvoiceReminderSuccess,
} from "../components/invoice-reminder-dialog";
import { buildBookkeeperCompose } from "../lib/bookkeeper-compose";
import {
  BookSectionHeader,
  KpiChip,
  type Book,
} from "../components/book-sections/book-section-header";
import { cn } from "../lib/cn";

const customerDetailRouteApi = getRouteApi("/customers/$customerId");

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
  agentModeExcluded: boolean;
  shopifyCustomerId: string | null;
  customerType: "b2b" | "b2c" | null;
  balance: string;
  overdueBalance: string;
  unappliedCreditBalance: string;
  internalNotes: string | null;
  aiCustomerContext: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// KPI rollups computed server-side in the customer GET. All counts are
// numbers and timestamps are ISO strings (mysql2 subquery normalised
// route-side). Nullable when there's nothing of that kind for the
// customer — e.g. lastContactedAt is null when no email_log row exists.
type CustomerKpi = {
  openInvoiceCount: number;
  oldestUnpaidInvoiceDueDate: string | null;
  openTaskCount: number;
  hasPendingRma: boolean;
  hasChaseDismissal: boolean;
  lastContactedAt: string | null;
  lastPaymentAt: string | null;
  lastStatementSentAt: string | null;
  // Two-track exposure, netted server-side. Feldart = we supplied it;
  // TJ = Torah Judaica legacy wind-down. All amounts are 2dp strings.
  feldartBalance: string;
  feldartOverdue: string;
  feldartOpenCount: number;
  // Days overdue of the oldest past-due open Feldart invoice; null when
  // nothing Feldart is overdue. Drives the header pill's "· oldest Nd".
  feldartOldestDays: number | null;
  tjBalance: string;
  tjOverdue: string;
  tjOpenCount: number;
  // Open TJ invoices parked at disputeState='verifying' (claims-paid
  // loop). Drives the header TJ pill + TJ panel chip.
  tjVerifyingCount: number;
};

type DetailResponse = {
  customer: Customer;
  recentActivities: Activity[];
  kpi: CustomerKpi | null;
};

type TabKey =
  | "activity"
  | "emails"
  | "invoices"
  | "orders"
  | "tasks"
  | "returns"
  | "calls_sms";

// Notes are no longer a tab — they live in the always-visible context rail
// (and every manual note still appears in the Activity timeline).
const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "emails", label: "Emails" },
  { key: "calls_sms", label: "Calls & SMS" },
  { key: "invoices", label: "Invoices" },
  { key: "orders", label: "Orders" },
  { key: "tasks", label: "Tasks" },
  { key: "returns", label: "Returns" },
];

// Plain text from the AI card's action args → TipTap-friendly HTML.
// Blank-line-separated paragraphs become <p>; intra-paragraph newlines
// become <br/>. Matches the compose-modal's plainTextToHtml helper.
function aiBodyToHtml(text: string): string {
  if (!text) return "";
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>") || "<br/>"}</p>`)
    .join("");
}

export default function CustomerDetailPage() {
  const { customerId } = useParams({ from: "/customers/$customerId" });
  const search = customerDetailRouteApi.useSearch();
  const navigate = useNavigate();
  const { setFilter } = useFilterNavigate<CustomerDetailSearch>("/customers/$customerId");
  useFilterPersistence("/customers/$customerId");

  const tab = search.tab;
  const setTab = (next: CustomerDetailSearch["tab"]) =>
    setFilter("tab", next, { history: "push" });

  // Invoices tab filter aliases
  const invStatus = search.invStatus;
  const invType = search.invType;
  const invSearch = search.invSearch;
  const invSort = search.invSort;
  const invDir = search.invDir;

  // Emails tab filter aliases
  const emailDirection = search.emailDirection;
  const emailActioned = search.emailActioned;

  // Returns tab filter aliases
  const rmaStatus = search.rmaStatus;
  const rmaType = search.rmaType;
  const [holdDialogOpen, setHoldDialogOpen] = useState(false);
  // Statement dialog state — null when closed, else the book scope the
  // triggering surface owns (Feldart panel → 'feldart', TJ batch lives
  // on /chase). Origin rides the send POST so the statement only
  // covers that book's invoices.
  const [statementDialog, setStatementDialog] = useState<{
    origin: "feldart" | "tj";
  } | null>(null);
  const [statementSuccess, setStatementSuccess] =
    useState<StatementSendSuccess | null>(null);
  // Chase email dialog state. invoiceIds is undefined when chasing all
  // open invoices of `origin` (the per-book panel buttons); populated
  // when chasing a selected subset (the Invoices tab bulk-action
  // button — single-book selections only; mixed-book selections are
  // blocked panel-side so one chase email never blends books).
  const [chaseDialog, setChaseDialog] = useState<{
    invoiceIds?: string[];
    origin: "feldart" | "tj";
  } | null>(null);
  const [chaseSuccess, setChaseSuccess] = useState<{
    level: 1 | 2 | 3;
    invoiceCount: number;
  } | null>(null);
  // Compose dialog state. The context shape carries everything the
  // ComposeModal needs to render in either "fresh outbound" (just
  // customer info) or "AI draft reply" (with draftReplyForEmailLogId)
  // mode. Null = closed. The various entry points (header "Email
  // customer" button, AI-card actions, ?draftReplyFor query param)
  // all set this state shape.
  const [composeContext, setComposeContext] =
    useState<ComposeContext | null>(null);
  // Task drawer state — null when closed, else { mode: "create"|"edit", ...}.
  // Reused across the header "+ New task" button, the Tasks tab, and
  // any future entry points (email-row, RMA detail). Always opened
  // with `customerId` pre-filled in defaults so the resulting task
  // links back to this customer automatically.
  const [taskDrawer, setTaskDrawer] = useState<TaskDrawerMode | null>(null);
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

  // Same auto-dismiss pattern for the chase-sent pill.
  useEffect(() => {
    if (!chaseSuccess) return;
    const t = setTimeout(() => setChaseSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [chaseSuccess]);

  const { data, isPending, isError, error } = useQuery<DetailResponse>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // ?draftReplyFor=<emailLogId> — dashboard "Draft reply" button deep-links
  // here. On first read we open compose in AI-draft mode then clear the
  // param so refreshes don't re-open. Tolerates the customer query being
  // mid-flight by waiting until we have the row.
  useEffect(() => {
    const draftFor = search.draftReplyFor;
    if (!draftFor || !data) return;
    setComposeContext({
      customerId: data.customer.id,
      customerName: data.customer.displayName,
      customerEmail: data.customer.primaryEmail ?? undefined,
      draftReplyForEmailLogId: draftFor,
    });
    setFilter("draftReplyFor", undefined, { history: "replace" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.draftReplyFor, data?.customer.id]);

  // Current authenticated operator — used by TaskDetailDrawer for
  // mention resolution + watcher self-attribution. Same query the
  // /tasks page uses; cached for 5 min so hopping between customer
  // pages doesn't re-fetch /api/me on every nav.
  const meQuery = useQuery<{
    user: { id: string; name: string | null; email: string; image: string | null };
  }>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const currentUser = meQuery.data?.user ?? null;

  // App settings — only needed for the TJ dispute flow's "Email TJ
  // bookkeeper" prefill (key tj_bookkeeper_email). Cached for 5 min;
  // an empty value still opens compose with no recipient.
  const appSettingsQuery = useQuery<{ settings: Record<string, string> }>({
    queryKey: ["app-settings"],
    queryFn: async () => {
      const res = await fetch("/api/app-settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const tjBookkeeperEmail =
    appSettingsQuery.data?.settings.tj_bookkeeper_email?.trim() || undefined;

  // Customer-scoped task list. Used by:
  //   - The Tasks tab (renders the list + an Add task button)
  //   - The KPI strip's "open tasks" count (already in customer GET kpi
  //     rollup but the tasks tab needs the actual rows)
  //   - The drawer's listQueryKey for invalidation after mutations
  const tasksQueryKey = useMemo(
    () => ["customer-tasks", customerId] as const,
    [customerId],
  );
  const tasksQuery = useQuery<{ rows: TaskCardData[]; hasMore: boolean }>({
    queryKey: tasksQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        customerId,
        // Default to "all" assignees here — the tasks tab on a customer
        // page is about the customer, not "my tasks." Operator can
        // filter inside the drawer if needed.
        assignee: "all",
        sort: "position",
        dir: "asc",
        limit: "200",
      });
      const res = await fetch(`/api/tasks?${params.toString()}`);
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
  const undismissChaseMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/dashboard/chase/${encodeURIComponent(customerId)}/dismiss`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "chase"] });
    },
  });

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

  const agentModeMutation = useMutation({
    mutationFn: async (excluded: boolean) => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentModeExcluded: excluded }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
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
  // Per-book figures only — the blended customers.balance/overdueBalance
  // fields stay server-side for sync bookkeeping but are never rendered
  // (origin-split-2 spec §5).
  const feldartBalance = Number(kpi?.feldartBalance ?? "0");
  const feldartOldestDays = kpi?.feldartOldestDays ?? null;
  const tjBalance = Number(kpi?.tjBalance ?? "0");
  const tjOverdue = Number(kpi?.tjOverdue ?? "0");
  const tjVerifyingCount = kpi?.tjVerifyingCount ?? 0;
  const tjOpenCount = kpi?.tjOpenCount ?? 0;
  // "No TJ history" — hides the TJ pill (and, with a rows-on-file
  // escape hatch, the TJ panel). Locked predicate from the Wave 1 plan.
  const hasTjHistory =
    tjBalance !== 0 ||
    tjOverdue !== 0 ||
    tjVerifyingCount !== 0 ||
    tjOpenCount !== 0;

  // AI card action handler. Each kind maps to an existing surface — no
  // parallel autopilot logic. send_* opens the compose modal pre-filled;
  // view_* navigates to the relevant detail page. Unknown args shapes
  // degrade gracefully (compose opens blank if the model omitted body).
  function handleAiCardAction(action: AiCardAction): void {
    switch (action.kind) {
      case "send_chase_email":
      case "send_check_in_email": {
        const subject =
          typeof action.args.subject === "string" ? action.args.subject : "";
        const bodyText =
          typeof action.args.body === "string" ? action.args.body : "";
        setComposeContext({
          customerId: customer.id,
          customerName: customer.displayName,
          customerEmail: customer.primaryEmail ?? undefined,
          prefill:
            subject || bodyText
              ? { subject, bodyHtml: aiBodyToHtml(bodyText) }
              : undefined,
        });
        return;
      }
      case "send_statement":
        // W2 T5: actions are origin-aware — prefer the model's normalized
        // origin; fall back to the Wave 1 smart default (the book that
        // actually carries a balance, Feldart wins ties) for cached
        // pre-Wave-2 cards whose actions have no origin yet.
        setStatementDialog({
          origin:
            action.origin === "tj" || action.origin === "feldart"
              ? action.origin
              : feldartBalance > 0
                ? "feldart"
                : tjBalance > 0
                  ? "tj"
                  : "feldart",
        });
        return;
      case "view_rma": {
        const rmaId =
          typeof action.args.rmaId === "string"
            ? action.args.rmaId
            : typeof action.args.id === "string"
              ? (action.args.id as string)
              : null;
        if (rmaId) {
          void navigate({ to: `/returns/${rmaId}` });
        }
        return;
      }
      case "view_cron_failure":
        void navigate({ to: "/settings" });
        return;
    }
  }

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

      {kpi?.hasChaseDismissal && (
        <div className="flex items-center justify-between gap-2 rounded border border-default bg-subtle px-3 py-2 text-xs">
          <span className="text-secondary">
            Dismissed from chase queue — won't surface on the dashboard
            until undismissed.
          </span>
          <button
            type="button"
            onClick={() => undismissChaseMutation.mutate()}
            disabled={undismissChaseMutation.isPending}
            className="text-accent-info hover:underline disabled:opacity-50"
          >
            {undismissChaseMutation.isPending ? "Undismissing…" : "Undismiss"}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-default bg-base px-4 py-4 shadow-sm md:px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
            {customer.displayName}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm text-secondary">
            {customer.primaryEmail && (
              <span className="inline-flex items-center gap-1">
                <Mail className="size-3.5 text-muted" />
                {customer.primaryEmail}
              </span>
            )}
            {customer.phone && (
              <span className="text-muted">· {customer.phone}</span>
            )}
            <CustomerTypeBadge type={customer.customerType} />
            {customer.paymentTerms && (
              <Badge tone="neutral">{customer.paymentTerms}</Badge>
            )}
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
            {kpi?.openTaskCount && kpi.openTaskCount > 0 ? (
              <Badge
                tone="neutral"
                title="Open tasks for this customer — see the Tasks tab"
              >
                {kpi.openTaskCount} open task{kpi.openTaskCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {kpi?.lastContactedAt ? (
              <span
                className="text-xs text-muted"
                title={new Date(kpi.lastContactedAt).toLocaleString()}
              >
                · last contacted {detailRelativeTime(kpi.lastContactedAt)}
              </span>
            ) : null}
          </div>
          {/* Per-book exposure pills — the only money figures in the
              header. Feldart always renders (living book, even $0); TJ
              only when the customer has TJ history. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <HeaderBookPill
              book="feldart"
              title="Open Feldart balance, net of Feldart credits"
            >
              Feldart owes ${feldartBalance.toFixed(2)}
              {feldartOldestDays != null ? (
                <span
                  className="font-normal opacity-80"
                  title={`Oldest overdue Feldart invoice is ${feldartOldestDays} day${feldartOldestDays === 1 ? "" : "s"} past due`}
                >
                  {" "}
                  · oldest {feldartOldestDays}d
                </span>
              ) : null}
            </HeaderBookPill>
            {hasTjHistory ? (
              <HeaderBookPill
                book="tj"
                title="Open Torah Judaica balance, net of TJ credits"
              >
                TJ owes ${tjBalance.toFixed(2)}
                {tjVerifyingCount > 0 ? (
                  <span className="font-normal opacity-80">
                    {" "}
                    · {tjVerifyingCount} verifying
                  </span>
                ) : null}
              </HeaderBookPill>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          {/* Account-state row: refresh + hold toggle + a "more" menu for the
              less-frequent state changes (payment-upfront, autopilot). */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SyncCustomerButton customerId={customer.id} />
            {/* Split button: the main face toggles hold; the caret opens a
                menu of the less-frequent state changes (payment-upfront,
                autopilot). */}
            <div className="inline-flex items-stretch">
              <Button
                variant="secondary"
                size="sm"
                disabled={holdToggleMutation.isPending}
                onClick={() => {
                  setPendingTarget(
                    customer.holdStatus === "hold" ? "active" : "hold",
                  );
                  setHoldDialogOpen(true);
                }}
                className="rounded-r-none"
              >
                <Pause className="size-3.5" />
                {customer.holdStatus === "hold"
                  ? "Take off hold"
                  : "Put on hold"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="More account actions"
                    className="rounded-l-none border-l-0 px-1.5"
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {customer.holdStatus !== "hold" && (
                    <DropdownMenuItem
                      onSelect={() => {
                        setPendingTarget(
                          customer.holdStatus === "payment_upfront"
                            ? "active"
                            : "payment_upfront",
                        );
                        setHoldDialogOpen(true);
                      }}
                    >
                      {customer.holdStatus === "payment_upfront"
                        ? "Set to active"
                        : "Set to payment upfront"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={agentModeMutation.isPending}
                    onSelect={() =>
                      agentModeMutation.mutate(!customer.agentModeExcluded)
                    }
                  >
                    {customer.agentModeExcluded
                      ? "Autopilot: turn on"
                      : "Autopilot: turn off"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {/* Messaging row. Statement + Chase moved into the per-book
              invoice panels (origin-split-2) so every send is book-
              scoped; the header keeps the book-agnostic actions. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setComposeContext({
                  customerId: customer.id,
                  customerName: customer.displayName,
                  customerEmail: customer.primaryEmail ?? undefined,
                })
              }
              title="Compose a new email to this customer (attachments optional)"
              disabled={!customer.primaryEmail}
            >
              <Mail className="size-3.5" />
              New email
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                setTaskDrawer({
                  mode: "create",
                  defaults: { customerId },
                })
              }
              title="Create a task linked to this customer"
            >
              <Plus className="size-3.5" />
              New task
            </Button>
          </div>
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
      {chaseSuccess && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-accent-success/30 bg-accent-success/10 px-3 py-2 text-sm text-accent-success"
        >
          <CheckCircle2 className="size-4" />
          <span>
            Chase L{chaseSuccess.level} sent · {chaseSuccess.invoiceCount}{" "}
            invoice{chaseSuccess.invoiceCount === 1 ? "" : "s"} chased
          </span>
        </div>
      )}

      {/* Mounted conditionally so `origin` is always concrete (required
          prop since origin-split-2 W1 T5) and the preview query only
          fires for the book the operator picked. */}
      {statementDialog ? (
        <StatementSendDialog
          open={true}
          onOpenChange={(next) => {
            if (!next) setStatementDialog(null);
          }}
          customerId={customer.id}
          customerName={customer.displayName}
          origin={statementDialog.origin}
          onSent={(result) => setStatementSuccess(result)}
        />
      ) : null}

      {/* Chase email dialog. Mounted conditionally so the
          previewQuery only fires when the operator opens it.
          chaseDialog.invoiceIds === undefined → chase all open;
          === [] → also chase all open (defence-in-depth);
          === [...] → chase that subset (set by the Invoices tab
          bulk action). */}
      {/* Reusable task drawer — same component the /tasks page uses.
          Mounted unconditionally so create + edit transitions
          (post-create the parent flips drawer to edit mode) animate
          smoothly. The drawer self-handles open/close styling; we
          just supply mode + defaults + currentUser. */}
      <TaskDetailDrawer
        open={taskDrawer !== null}
        onClose={() => setTaskDrawer(null)}
        drawer={taskDrawer ?? { mode: "create", defaults: { customerId } }}
        currentUser={currentUser}
        listQueryKey={tasksQueryKey}
        onCreated={(taskId) =>
          setTaskDrawer({ mode: "edit", taskId })
        }
      />

      {/* Compose modal — opens from: header "Email customer" button,
          AI-card action buttons (with prefill), or the ?draftReplyFor
          query param (which seeds an AI draft panel for replying to a
          specific inbound from the dashboard). Closed = state is null. */}
      {composeContext ? (
        <ComposeModal
          open={true}
          onOpenChange={(next) => {
            if (!next) setComposeContext(null);
          }}
          context={composeContext}
        />
      ) : null}

      {chaseDialog ? (
        <ChaseEmailSendDialog
          open={true}
          onOpenChange={(next) => {
            if (!next) setChaseDialog(null);
          }}
          customerId={customer.id}
          customerName={customer.displayName}
          // Always a single book — panel buttons pass theirs; the
          // bulk-selection action derives the selection's (single)
          // book, so the dialog gets the right templates either way.
          origin={chaseDialog.origin}
          level={1}
          invoiceIds={chaseDialog.invoiceIds}
          onSent={(_result: ChaseSendSuccess) => {
            // The dialog already invalidates the right cache keys.
            // We just stash the success metadata so the auto-fading
            // pill above renders. invoiceCount is the number of
            // invoices the dialog scope covered — for "all open"
            // (undefined invoiceIds) we approximate from the kpi's
            // per-book open count; for a subset we know exactly.
            const count =
              chaseDialog.invoiceIds?.length ??
              (chaseDialog.origin === "feldart"
                ? kpi?.feldartOpenCount
                : kpi?.tjOpenCount) ??
              0;
            setChaseSuccess({ level: _result.level, invoiceCount: count });
            setChaseDialog(null);
          }}
        />
      ) : null}

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

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {/* Main work column — the section tabs + active tab content. */}
        <div className="min-w-0 flex-1">
          <div className="border-b border-default">
            <nav
              className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
              aria-label="Customer sections"
            >
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
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

          <div className="mt-4">
            {tab === "activity" && (
              <ActivityTimeline
                customerId={customer.id}
                activities={recentActivities}
                queryKey={["customer", customerId]}
                onJumpToCallsSms={() => setTab("calls_sms")}
              />
            )}
            {tab === "emails" && (
              <EmailList
                customerId={customer.id}
                customerName={customer.displayName}
                customerEmail={customer.primaryEmail}
                onTaskCreated={(taskId) =>
                  setTaskDrawer({ mode: "edit", taskId })
                }
                direction={emailDirection}
                actioned={emailActioned}
                onDirectionChange={(v) => setFilter("emailDirection", v, { history: "push" })}
                onActionedChange={(v) => setFilter("emailActioned", v, { history: "push" })}
              />
            )}
            {tab === "invoices" && (
              <InvoicesPanel
                customerId={customer.id}
                customerName={customer.displayName}
                kpi={kpi}
                hasTjHistory={hasTjHistory}
                onChase={(origin) => setChaseDialog({ origin })}
                onStatement={(origin) => setStatementDialog({ origin })}
                onBulkChase={(invoiceIds, origin) =>
                  setChaseDialog({ invoiceIds, origin })
                }
                onDisputeChanged={() => {
                  void queryClient.invalidateQueries({
                    queryKey: ["customer-invoices", customer.id],
                  });
                  void queryClient.invalidateQueries({
                    queryKey: ["customer", customerId],
                  });
                }}
                onEmailBookkeeper={(inv) => {
                  setComposeContext({
                    customerId: customer.id,
                    customerName: customer.displayName,
                    customerEmail: tjBookkeeperEmail,
                    // Both paths land here: per-invoice dispute buttons pass
                    // their row; the panel-header Bookkeeper button passes the
                    // oldest verifying invoice. Server records the sent Gmail
                    // threadId on it (bookkeeper_thread_id) for the
                    // dispute-nudge. id is null for rows not yet synced
                    // locally — skip linkage rather than send a bogus id.
                    disputeInvoiceId: inv.id ?? undefined,
                    prefill: buildBookkeeperCompose({
                      customerName: customer.displayName,
                      docNumber: inv.docNumber ?? inv.qbId,
                      balance: inv.balance,
                    }),
                  });
                }}
                invStatus={invStatus}
                invType={invType}
                invSearch={invSearch}
                invSort={invSort}
                invDir={invDir}
                onSetInvStatus={(v) => setFilter("invStatus", v, { history: "push" })}
                onSetInvType={(v) => setFilter("invType", v, { history: "push" })}
                onSetInvSearch={(v) => setFilter("invSearch", v)}
                onSetInvSort={(v) => setFilter("invSort", v, { history: "push" })}
                onSetInvDir={(v) => setFilter("invDir", v, { history: "push" })}
              />
            )}
            {tab === "orders" && <PlaceholderPanel label="Orders" />}
            {tab === "tasks" && (
              <TasksPanel
                tasks={tasksQuery.data?.rows ?? []}
                isPending={tasksQuery.isPending}
                isError={tasksQuery.isError}
                error={tasksQuery.error}
                onAdd={() =>
                  setTaskDrawer({
                    mode: "create",
                    defaults: { customerId },
                  })
                }
                onOpen={(taskId) =>
                  setTaskDrawer({ mode: "edit", taskId })
                }
              />
            )}
            {tab === "returns" && (
              <ReturnsPanel
                customerId={customer.id}
                rmaStatus={rmaStatus}
                rmaType={rmaType}
                onRmaStatusChange={(v) => setFilter("rmaStatus", v, { history: "push" })}
                onRmaTypeChange={(v) => setFilter("rmaType", v, { history: "push" })}
              />
            )}
            {tab === "calls_sms" && (
              <CallsSmsTab
                customerId={customer.id}
                primaryPhone={customer.phone}
                additionalPhones={customer.additionalPhones}
              />
            )}
          </div>
        </div>

        {/* Persistent context rail. Stacks below the main column on mobile. */}
        <CustomerContextRail
          customer={customer}
          notes={recentActivities.filter((a) => a.kind === "manual_note")}
          onAction={handleAiCardAction}
        />
      </div>
    </div>
  );
}

// Compact per-book exposure pill for the header — indigo for Feldart,
// amber for Torah Judaica (same palette as the book panels' accents).
function HeaderBookPill({
  book,
  title,
  children,
}: {
  book: Book;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums",
        book === "feldart"
          ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-500"
          : "border-accent-warning/30 bg-accent-warning/10 text-accent-warning",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          book === "feldart" ? "bg-indigo-500" : "bg-accent-warning",
        )}
        aria-hidden
      />
      <span>{children}</span>
    </span>
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

function AiContextCard({
  customerId,
  initial,
}: {
  customerId: string;
  initial: string | null;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aiCustomerContext: draft }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  // Renders as inner content only — the rail wraps it in a collapsible
  // <details> whose summary provides the "AI context" title.
  return (
    <div className="space-y-2">
      <p className="text-xs text-secondary">
        What autopilot should know/do for this customer (tone, "don't
        auto-chase", payment quirks). Sent to the AI — keep secrets out;
        human-only notes go in the activity timeline.
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="e.g. Pays late but always pays — stay warm, don't escalate."
        className="w-full rounded-md border border-default bg-base px-3 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
      />
      <div className="flex items-center justify-end gap-2">
        {error ? (
          <span className="text-xs text-accent-danger">{error}</span>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

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

// Tasks tab on the customer-detail page. Renders the customer's open
// + closed tasks via the shared <TaskList>. Add button opens the same
// <TaskDetailDrawer> the parent header button does, with customerId
// already in defaults so the new task links back automatically. Click
// any row → drawer flips to edit mode for that task.
function TasksPanel({
  tasks,
  isPending,
  isError,
  error,
  onAdd,
  onOpen,
}: {
  tasks: TaskCardData[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onAdd: () => void;
  onOpen: (taskId: string) => void;
}) {
  if (isPending) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-muted">
          Loading tasks…
        </CardBody>
      </Card>
    );
  }
  if (isError) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-accent-danger">
          {(error as Error)?.message ?? "Failed to load tasks"}
        </CardBody>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-secondary">
          {tasks.length === 0
            ? "No tasks for this customer yet."
            : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
        </div>
        <Button variant="primary" size="sm" onClick={onAdd}>
          <Plus className="size-3.5" />
          Add task
        </Button>
      </div>
      {tasks.length > 0 ? (
        <TaskList
          tasks={tasks}
          onRowClick={onOpen}
          hideCustomerColumn
        />
      ) : (
        <Card>
          <CardBody className="flex flex-col items-center gap-2 py-10 text-sm text-muted">
            <ClipboardList className="size-6 text-muted" />
            <span>No tasks yet — click "Add task" to create one.</span>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// Notes tab on the customer-detail page. Renders the customer's
// existing manual_note activities (filtered from recentActivities by
// the parent) and offers an inline create form. Posts to
// POST /api/customers/:id/notes which writes a new manual_note
// activity via the standard recordActivity path; on success we
// invalidate ["customer", customerId] so the new note appears in
// recentActivities → flows back into this panel.
// A single note in the rail. Owns its edit / delete / read-more state.
// Edit → PATCH /api/customers/:id/notes/:activityId (subject preserved so a
// body-only edit doesn't wipe it). Delete is a two-step inline confirm (no
// native dialog). Both invalidate the customer query so the list + timeline
// refresh. Bodies longer than NOTE_PREVIEW_CHARS collapse to "Read more".
const NOTE_PREVIEW_CHARS = 220;

function NoteItem({
  customerId,
  note,
}: {
  customerId: string;
  note: Activity;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body ?? "");
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["customer", customerId] });

  const editMutation = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/notes/${encodeURIComponent(note.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body, subject: note.subject }),
        },
      );
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setEditing(false);
      setError(null);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Failed to save note"),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/notes/${encodeURIComponent(note.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: invalidate,
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to delete note");
      setConfirmingDelete(false);
    },
  });

  const body = note.body ?? "";
  const isLong = body.length > NOTE_PREVIEW_CHARS;
  const shown = isLong && !expanded ? `${body.slice(0, NOTE_PREVIEW_CHARS)}…` : body;

  if (editing) {
    return (
      <div className="border-t border-accent-warning/20 pt-2.5 first:border-t-0 first:pt-0">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          autoFocus
          className="w-full rounded-md border border-accent-warning/40 bg-base px-2.5 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-warning/40"
        />
        {error ? (
          <div className="mt-1 text-xs text-accent-danger">{error}</div>
        ) : null}
        <div className="mt-1.5 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false);
              setDraft(note.body ?? "");
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={editMutation.isPending}
            disabled={
              draft.trim().length === 0 ||
              draft.trim() === (note.body ?? "").trim() ||
              editMutation.isPending
            }
            onClick={() => editMutation.mutate(draft.trim())}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group border-t border-accent-warning/20 pt-2.5 first:border-t-0 first:pt-0">
      <div className="whitespace-pre-wrap text-sm text-primary">{shown}</div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[11px] font-medium text-accent-warning hover:underline"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
      <div className="mt-0.5 flex items-center justify-between">
        <span className="text-[11px] text-muted">
          {new Date(note.occurredAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
        {confirmingDelete ? (
          <span className="flex items-center gap-2 text-[11px]">
            <span className="text-muted">Delete?</span>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="font-medium text-accent-danger hover:underline"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="text-secondary hover:underline"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              aria-label="Edit note"
              onClick={() => {
                setDraft(note.body ?? "");
                setEditing(true);
              }}
              className="text-secondary hover:text-primary"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Delete note"
              onClick={() => setConfirmingDelete(true)}
              className="text-secondary hover:text-accent-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      {error ? (
        <div className="mt-1 text-xs text-accent-danger">{error}</div>
      ) : null}
    </div>
  );
}

// Prominent, always-visible notes card for the context rail. Reuses the
// manual-note POST path; shows the most recent notes (the rest stay in the
// Activity timeline). Replaces the old standalone Notes tab.
function NotesRailCard({
  customerId,
  notes,
}: {
  customerId: string;
  notes: Activity[];
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      return res.json() as Promise<{ activityId: string | null }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      setDraft("");
      setAdding(false);
      setError(null);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Failed to save note"),
  });

  const recent = notes.slice(0, 3);

  return (
    <div className="rounded-xl border-[1.5px] border-accent-warning/40 bg-accent-warning/5 p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-accent-warning">
          Notes
        </span>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs font-medium text-accent-warning hover:underline"
          >
            + Add
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-3 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Internal note — visible to the team in the activity timeline."
            className="w-full rounded-md border border-accent-warning/40 bg-base px-2.5 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-warning/40"
          />
          {error ? (
            <div className="text-xs text-accent-danger">{error}</div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                setDraft("");
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={createMutation.isPending}
              disabled={draft.trim().length === 0 || createMutation.isPending}
              onClick={() => createMutation.mutate(draft.trim())}
            >
              Save note
            </Button>
          </div>
        </div>
      )}

      {recent.length === 0 ? (
        !adding && (
          <p className="text-xs text-secondary">No notes yet — add the first.</p>
        )
      ) : (
        <div className="space-y-2.5">
          {recent.map((n) => (
            <NoteItem key={n.id} customerId={customerId} note={n} />
          ))}
          {notes.length > recent.length && (
            <div className="text-[11px] text-muted">
              +{notes.length - recent.length} more in the Activity timeline
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The persistent context rail: AI summary → Notes → AI context
// (collapsible) → recipients/terms. The per-book KPI cards that used to
// lead the rail are superseded by the header pills + panel KPI chips
// (origin-split-2 — no triple display of the same figures).
function CustomerContextRail({
  customer,
  notes,
  onAction,
}: {
  customer: Customer;
  notes: Activity[];
  onAction: (action: AiCardAction) => void;
}) {
  return (
    <aside className="flex w-full flex-col gap-3 md:w-[330px] md:shrink-0">
      <CustomerAiCard customerId={customer.id} onAction={onAction} />
      <NotesRailCard customerId={customer.id} notes={notes} />
      <details className="rounded-xl border border-default bg-subtle">
        <summary className="cursor-pointer list-none px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide text-secondary [&::-webkit-details-marker]:hidden">
          AI context for autopilot
        </summary>
        <div className="px-3.5 pb-3.5">
          <AiContextCard
            customerId={customer.id}
            initial={customer.aiCustomerContext}
          />
        </div>
      </details>
      <RecipientsAndTagsSection customer={customer} />
      <TermsCard customerId={customer.id} currentTerms={customer.paymentTerms} />
    </aside>
  );
}

// Surfaces every recipient + system link finance-hub knows for this
// customer: primary email (TO), billing emails (CC list on statements +
// chase), phone (read-only for now), and the linked Shopify customer
// id (with a deep link to the Shopify admin if the env tells us the
// store domain). Kept compact — the heading row above is dense already.
// "Recipients & tags" section. Two stacked cards — one for invoice
// recipients, one for statement recipients — each editable. Plus a
// tags chip input with auto-BCC hints when a tag matches an
// email_routing_rules row. All edits hit PATCH /api/customers/:id;
// the route handles the QBO push for invoice-side fields.
function RecipientsAndTagsSection({ customer }: { customer: Customer }) {
  // Collapsed-state summaries — short, glanceable, so the operator
  // can tell at a glance whether a card has content worth expanding.
  const invoiceSummary = summariseEmailCounts(
    customer.invoiceToEmails,
    customer.invoiceCcEmails,
    customer.invoiceBccEmails,
  );
  const statementSummary = summariseEmailCounts(
    customer.statementToEmails,
    customer.statementCcEmails,
    customer.statementBccEmails,
  );
  const phoneCount =
    (customer.phone ? 1 : 0) + (customer.additionalPhones?.length ?? 0);
  const phoneSummary =
    phoneCount === 0
      ? "no numbers set"
      : `${phoneCount} number${phoneCount === 1 ? "" : "s"}`;
  const tagCount = customer.tags?.length ?? 0;
  const tagSummary =
    tagCount === 0
      ? "no tags"
      : (customer.tags ?? []).slice(0, 3).join(", ") +
        (tagCount > 3 ? ` (+${tagCount - 3})` : "");
  return (
    <div className="flex flex-col gap-3">
      <CollapsibleCard
        title="Invoice recipients"
        summary={invoiceSummary}
      >
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
      </CollapsibleCard>
      <CollapsibleCard
        title="Statement & chase recipients"
        summary={statementSummary}
      >
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
      </CollapsibleCard>
      <CollapsibleCard title="Phones" summary={phoneSummary}>
        <PhonesCard
          customerId={customer.id}
          phone={customer.phone}
          additionalPhones={customer.additionalPhones}
        />
      </CollapsibleCard>
      <CollapsibleCard title="Tags" summary={tagSummary}>
        <TagsCard
          customerId={customer.id}
          currentTags={customer.tags ?? []}
        />
      </CollapsibleCard>
    </div>
  );
}

// One-line summary of (TO / CC / BCC) counts for the recipient cards'
// collapsed state. "no recipients set" when all three are empty so
// the operator can tell at a glance the card needs setup.
function summariseEmailCounts(
  toEmails: string[] | null,
  ccEmails: string[] | null,
  bccEmails: string[] | null,
): string {
  const to = toEmails?.length ?? 0;
  const cc = ccEmails?.length ?? 0;
  const bcc = bccEmails?.length ?? 0;
  if (to === 0 && cc === 0 && bcc === 0) return "no recipients set";
  const parts: string[] = [];
  parts.push(`${to} TO`);
  if (cc > 0) parts.push(`${cc} CC`);
  if (bcc > 0) parts.push(`${bcc} BCC`);
  return parts.join(" · ");
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

  // Inner content only — title + Card wrapper provided by the parent
  // CollapsibleCard. `title` prop kept on the function signature for
  // call-site clarity even though it's no longer rendered here.
  void title;
  return (
    <div className="space-y-2">
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
    </div>
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

  // Inner content only — Card + title bar provided by parent
  // CollapsibleCard.
  return (
    <div className="space-y-2">
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
    </div>
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

  // Inner content only — Card + title bar provided by parent
  // CollapsibleCard.
  return (
    <div className="space-y-2">
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
          <ul className="mb-1 space-y-2">
            {extras.map((e, i) => (
              <li key={i} className="space-y-1">
                <input
                  type="text"
                  value={e.label}
                  onChange={(ev) =>
                    updateExtra(i, { label: ev.target.value })
                  }
                  onBlur={saveExtras}
                  placeholder="Label"
                  className="w-full rounded-md border border-default bg-base px-1.5 py-0.5 text-[11px]"
                />
                <div className="flex gap-1">
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
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {extras.length < 10 ? (
          <div className="space-y-1">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label"
              className="w-full rounded-md border border-default bg-base px-1.5 py-0.5 text-[11px]"
            />
            <div className="flex gap-1">
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
          </div>
        ) : null}
      </div>
      {mutation.isError ? (
        <div className="text-[11px] text-accent-danger">
          {(mutation.error as Error)?.message ?? "save failed"}
        </div>
      ) : null}
    </div>
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
  // Who supplied the goods: 'feldart' (current) vs 'tj' (Torah Judaica
  // legacy wind-down). Set server-side on every row.
  origin: "feldart" | "tj";
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
  // TJ dispute lifecycle (TJ invoices only; null elsewhere + on credit
  // memos). Drives the per-row DisputeActions UI.
  disputeState: "verifying" | "confirmed_paid" | "confirmed_unpaid" | null;
  disputeClaimedAt: string | null;
  disputeNote: string | null;
  // Last chase email that touched this invoice. Always null for
  // credit memos (chase tracking is invoice-only). Drives the
  // sortable "Last chased" column + the bulk-action target picker.
  lastChasedAt: string | null;
  lastChasedLevel: number | null;
};

// Selection key — docType-qualified so invoices and credit memos with
// overlapping QBO ids don't collide. Module-scoped so the per-book
// sections share it with the panel.
function rowKey(r: InvoiceRow): string {
  return `${r.docType}:${r.qbId}`;
}

type StatusFilter = "all" | "open" | "paid" | "overdue" | "sent" | "void";
type TypeFilter = "all" | "invoice" | "credit_memo";
type SortKey =
  | "issueDate"
  | "docNumber"
  | "total"
  | "balance"
  | "lastChasedAt";
type SortDir = "asc" | "desc";

function InvoicesPanel({
  customerId,
  customerName,
  kpi,
  hasTjHistory,
  onChase,
  onStatement,
  onBulkChase,
  onDisputeChanged,
  onEmailBookkeeper,
  invStatus,
  invType,
  invSearch,
  invSort,
  invDir,
  onSetInvStatus,
  onSetInvType,
  onSetInvSearch,
  onSetInvSort,
  onSetInvDir,
}: {
  customerId: string;
  customerName: string;
  // Per-book rollups for the panel KPI chips (server-computed, net of
  // that book's credits).
  kpi: CustomerKpi | null;
  // Locked TJ-history predicate from the parent — the TJ panel hides
  // for customers with no TJ exposure at all.
  hasTjHistory: boolean;
  // Panel header actions — parent owns the chase/statement dialogs and
  // threads the book through to them.
  onChase: (origin: "feldart" | "tj") => void;
  onStatement: (origin: "feldart" | "tj") => void;
  // Operator clicked "Send chase email" with N invoices selected.
  // The parent owns the dialog state; we just hand it the ids of
  // the selected invoice rows (credit memos filtered out — chase is
  // invoice-only) plus the selection's single book (mixed-book
  // selections disable the button — one chase email never blends
  // books). Chase tracking + invalidation is the dialog's job after
  // send succeeds.
  onBulkChase: (invoiceIds: string[], origin: "feldart" | "tj") => void;
  // A TJ dispute action succeeded — parent invalidates the invoices +
  // customer queries so balances/badges refresh.
  onDisputeChanged: () => void;
  // Open the bookkeeper compose for a TJ invoice under verification.
  onEmailBookkeeper: (inv: InvoiceRow) => void;
  invStatus: StatusFilter;
  invType: TypeFilter;
  invSearch: string;
  invSort: SortKey;
  invDir: SortDir;
  onSetInvStatus: (v: StatusFilter) => void;
  onSetInvType: (v: TypeFilter) => void;
  onSetInvSearch: (v: string) => void;
  onSetInvSort: (v: SortKey) => void;
  onSetInvDir: (v: SortDir) => void;
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
  // filter state lifted to page-level URL params (invStatus, invType, invSearch, invSort, invDir)
  const statusFilter = invStatus;
  const typeFilter = invType;
  const search = invSearch;
  const sortKey = invSort;
  const sortDir = invDir;
  // Selection — keyed by docType:qbId so invoices and credit memos
  // with overlapping QBO ids don't collide.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPdfPending, setBulkPdfPending] = useState<boolean>(false);
  const [bulkPdfError, setBulkPdfError] = useState<string | null>(null);

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
        // Void invoices carry balance 0, so they must be excluded BEFORE the
        // `balance <= 0` test — otherwise they'd be classed as Paid and leak
        // into the Paid tab (they belong only under the Void tab).
        const isPaid =
          r.status !== "void" &&
          (r.status === "paid" || r.status === "applied" || balance <= 0);
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

  // Filters apply across both books, THEN rows split by origin — each
  // per-book panel renders its slice (already sorted via filteredRows).
  const feldartRows = useMemo(
    () => filteredRows.filter((r) => r.origin === "feldart"),
    [filteredRows],
  );
  const tjRows = useMemo(
    () => filteredRows.filter((r) => r.origin === "tj"),
    [filteredRows],
  );
  // Unfiltered per-book doc counts — drive the panels' "no documents
  // on file" vs "no matching invoices" empty states + the TJ panel's
  // paid-history escape hatch.
  const feldartDocCount = useMemo(
    () => allRows.filter((r) => r.origin === "feldart").length,
    [allRows],
  );
  const tjDocCount = useMemo(
    () => allRows.filter((r) => r.origin === "tj").length,
    [allRows],
  );
  // Customer-level bookkeeper action targets the OLDEST verifying TJ
  // invoice (by due date, issue-date fallback). Computed from the
  // unfiltered rows so the button doesn't vanish under filters; null →
  // button omitted.
  const oldestVerifying = useMemo<InvoiceRow | null>(() => {
    const verifying = allRows.filter(
      (r) =>
        r.origin === "tj" &&
        r.docType === "invoice" &&
        r.disputeState === "verifying",
    );
    if (verifying.length === 0) return null;
    return verifying
      .slice()
      .sort((a, b) =>
        (a.dueDate ?? a.issueDate ?? "9999-12-31").localeCompare(
          b.dueDate ?? b.issueDate ?? "9999-12-31",
        ),
      )[0] ?? null;
  }, [allRows]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      onSetInvDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      onSetInvSort(key);
      onSetInvDir("desc");
    }
  }

  // Per-section select-all: toggles just that book's visible rows
  // (preserving any selection outside the section / current filter).
  function toggleSelectRows(rows: InvoiceRow[]) {
    setSelected((prev) => {
      const allSelected =
        rows.length > 0 && rows.every((r) => prev.has(rowKey(r)));
      const next = new Set(prev);
      if (allSelected) {
        for (const r of rows) next.delete(rowKey(r));
      } else {
        for (const r of rows) next.add(rowKey(r));
      }
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

  const feldartBalance = Number(kpi?.feldartBalance ?? "0");
  const feldartOverdue = Number(kpi?.feldartOverdue ?? "0");
  const tjBalance = Number(kpi?.tjBalance ?? "0");
  const tjVerifyingCount = kpi?.tjVerifyingCount ?? 0;
  // Locked predicate hides the TJ panel for no-TJ-history customers —
  // plus an escape hatch: if TJ docs exist on file (e.g. all paid,
  // wind-down complete), keep the panel so that history stays
  // browsable under the Paid/Void filters.
  const showTjPanel = hasTjHistory || tjDocCount > 0;

  return (
    <div className="space-y-3">
      {sentSuccess ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-accent-success/30 bg-accent-success/10 px-3 py-2 text-sm text-accent-success"
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
          className="flex items-center gap-2 rounded-md border border-accent-success/30 bg-accent-success/10 px-3 py-2 text-sm text-accent-success"
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

      <div className="space-y-3">
        {/* Filter + search row — applies across BOTH book panels below. */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <FilterChip
            label="All"
            active={statusFilter === "all"}
            onClick={() => onSetInvStatus("all")}
          />
          <FilterChip
            label="Open"
            active={statusFilter === "open"}
            onClick={() => onSetInvStatus("open")}
          />
          <FilterChip
            label="Paid"
            active={statusFilter === "paid"}
            onClick={() => onSetInvStatus("paid")}
          />
          <FilterChip
            label="Overdue"
            active={statusFilter === "overdue"}
            onClick={() => onSetInvStatus("overdue")}
          />
          <FilterChip
            label="Sent"
            active={statusFilter === "sent"}
            onClick={() => onSetInvStatus("sent")}
          />
          <FilterChip
            label="Void"
            active={statusFilter === "void"}
            onClick={() => onSetInvStatus("void")}
          />
          <span className="mx-1 h-4 w-px bg-default" />
          <FilterChip
            label="All types"
            active={typeFilter === "all"}
            onClick={() => onSetInvType("all")}
          />
          <FilterChip
            label="Invoices"
            active={typeFilter === "invoice"}
            onClick={() => onSetInvType("invoice")}
          />
          <FilterChip
            label="Credit memos"
            active={typeFilter === "credit_memo"}
            onClick={() => onSetInvType("credit_memo")}
          />
          <div className="ml-auto">
            <input
              type="text"
              value={search}
              onChange={(e) => onSetInvSearch(e.target.value)}
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
            <div className="flex flex-wrap items-center gap-2">
              {bulkPdfError ? (
                <span className="text-[11px] text-accent-danger">
                  {bulkPdfError}
                </span>
              ) : null}
              {/* Chase only the selected INVOICES (credit memos
                  excluded — chase tracking is invoice-only and the
                  template renders invoice rows). Disabled when zero
                  invoices are selected (only CMs) OR when the
                  selection spans both books — one chase email uses
                  one book's templates, so a mixed set would blend
                  TJ invoices into a Feldart-toned email. */}
              {(() => {
                const chaseableRows = selectedRows.filter(
                  (r) => r.docType === "invoice" && r.id,
                );
                const invoiceLocalIds = chaseableRows.map(
                  (r) => r.id as string,
                );
                const origins = new Set(chaseableRows.map((r) => r.origin));
                const spansBothBooks = origins.size > 1;
                const chaseDisabled =
                  invoiceLocalIds.length === 0 || spansBothBooks;
                const selectionOrigin: "feldart" | "tj" = origins.has("tj")
                  ? "tj"
                  : "feldart";
                return (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (chaseDisabled) return;
                      onBulkChase(invoiceLocalIds, selectionOrigin);
                      // Don't clear selection here — operator can
                      // cancel the dialog and re-fire. Selection
                      // clears via the explicit "clear" link or on
                      // dialog success (parent clears via key).
                    }}
                    disabled={chaseDisabled}
                    title={
                      spansBothBooks
                        ? "Selection spans both books — chase each book separately."
                        : invoiceLocalIds.length === 0
                          ? "Select at least one invoice (credit memos can't be chased)"
                          : `Send a ${selectionOrigin === "tj" ? "TJ " : ""}chase email covering the ${invoiceLocalIds.length} selected invoice${invoiceLocalIds.length === 1 ? "" : "s"} (L1 by default — switch level inside the dialog)`
                    }
                  >
                    <Send className="size-3.5" />
                    Send chase email
                    {invoiceLocalIds.length > 0
                      ? ` (${invoiceLocalIds.length})`
                      : ""}
                  </Button>
                );
              })()}
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

        {/* ── Feldart panel — the living book, always rendered. ──────── */}
        <BookInvoiceSection
          book="feldart"
          title="Feldart"
          kpis={
            <>
              <KpiChip>
                {kpi?.feldartOpenCount ?? 0} open
              </KpiChip>
              <KpiChip title="Open Feldart balance, net of Feldart credits">
                ${feldartBalance.toFixed(2)}
              </KpiChip>
              <KpiChip
                tone={feldartOverdue > 0 ? "danger" : "neutral"}
                title="Feldart balance past its due date"
              >
                ${feldartOverdue.toFixed(2)} overdue
              </KpiChip>
            </>
          }
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onChase("feldart")}
                disabled={!(feldartBalance > 0)}
                title={
                  feldartBalance > 0
                    ? "Send a chase email covering all open Feldart invoices (L1 by default — switch level inside the dialog)"
                    : "No open Feldart balance — nothing to chase"
                }
              >
                <Send className="size-3.5" />
                Chase
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onStatement("feldart")}
                disabled={!(feldartBalance > 0)}
                title={
                  feldartBalance > 0
                    ? "Send a statement of open Feldart invoices to this customer"
                    : "No open Feldart balance — nothing to send"
                }
              >
                <FileText className="size-3.5" />
                Statement
              </Button>
            </>
          }
          rows={feldartRows}
          bookDocCount={feldartDocCount}
          selected={selected}
          onToggleRow={toggleRow}
          onToggleAllRows={toggleSelectRows}
          sortKey={sortKey}
          sortDir={sortDir}
          onToggleSort={toggleSort}
          onSend={setSending}
          onRemind={setReminding}
          onDisputeChanged={onDisputeChanged}
          onEmailBookkeeper={onEmailBookkeeper}
        />

        {/* ── Torah Judaica panel — legacy wind-down book. ───────────── */}
        {showTjPanel ? (
          <BookInvoiceSection
            book="tj"
            title="Torah Judaica"
            kpis={
              <>
                <KpiChip title="Net TJ exposure (TJ credits netted)">
                  ${tjBalance.toFixed(2)} net
                </KpiChip>
                {tjVerifyingCount > 0 ? (
                  <KpiChip
                    tone="warning"
                    title="Invoices parked while the customer's payment claim is verified with the TJ bookkeeper"
                  >
                    {tjVerifyingCount} verifying
                  </KpiChip>
                ) : null}
              </>
            }
            actions={
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onChase("tj")}
                  disabled={!(tjBalance > 0)}
                  title={
                    tjBalance > 0
                      ? "Send a TJ-toned chase email covering open Torah Judaica invoices (verifying invoices excluded)"
                      : "No open TJ balance — nothing to chase"
                  }
                >
                  <Send className="size-3.5" />
                  TJ chase
                </Button>
                {oldestVerifying ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onEmailBookkeeper(oldestVerifying)}
                    title={`Email the TJ bookkeeper about ${oldestVerifying.docNumber ?? oldestVerifying.qbId} (oldest invoice under verification)`}
                  >
                    <Mail className="size-3.5" />
                    Bookkeeper
                  </Button>
                ) : null}
              </>
            }
            rows={tjRows}
            bookDocCount={tjDocCount}
            selected={selected}
            onToggleRow={toggleRow}
            onToggleAllRows={toggleSelectRows}
            sortKey={sortKey}
            sortDir={sortDir}
            onToggleSort={toggleSort}
            onSend={setSending}
            onRemind={setReminding}
            onDisputeChanged={onDisputeChanged}
            onEmailBookkeeper={onEmailBookkeeper}
          />
        ) : null}
      </div>

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
    </div>
  );
}

// One per-book invoice section: bordered card with a BookSectionHeader
// (accent band, dot, KPI chips, actions) over the shared invoice table.
// Both panels render through this — only header content, tint and row
// slice differ. The TJ variant carries a light amber wash so the
// legacy book reads visually distinct (mirrors the /chase wind-down
// panel's treatment).
function BookInvoiceSection({
  book,
  title,
  kpis,
  actions,
  rows,
  bookDocCount,
  selected,
  onToggleRow,
  onToggleAllRows,
  sortKey,
  sortDir,
  onToggleSort,
  onSend,
  onRemind,
  onDisputeChanged,
  onEmailBookkeeper,
}: {
  book: Book;
  title: string;
  kpis: ReactNode;
  actions: ReactNode;
  // This book's slice of the (already filtered + sorted) rows.
  rows: InvoiceRow[];
  // Unfiltered doc count for this book — distinguishes "no documents on
  // file" from "filters match nothing".
  bookDocCount: number;
  selected: Set<string>;
  onToggleRow: (row: InvoiceRow) => void;
  onToggleAllRows: (rows: InvoiceRow[]) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onToggleSort: (key: SortKey) => void;
  onSend: (row: InvoiceRow) => void;
  onRemind: (row: InvoiceRow) => void;
  onDisputeChanged: () => void;
  onEmailBookkeeper: (row: InvoiceRow) => void;
}) {
  const allSelected =
    rows.length > 0 && rows.every((r) => selected.has(rowKey(r)));
  const someSelected =
    !allSelected && rows.some((r) => selected.has(rowKey(r)));
  // Per-book footer sums over the visible (filtered) slice — never a
  // blended figure.
  let totalSum = 0;
  let openSum = 0;
  for (const r of rows) {
    totalSum += Number(r.total);
    if (Number(r.balance) > 0) openSum += Number(r.balance);
  }
  return (
    <section
      className={cn(
        "rounded-lg border shadow-sm",
        book === "tj"
          ? "border-accent-warning/30 bg-accent-warning/[0.04]"
          : "border-default bg-subtle",
      )}
    >
      <BookSectionHeader book={book} title={title} kpis={kpis} actions={actions} />
      <div className="space-y-3 px-4 py-3">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted">
            {bookDocCount === 0
              ? `No ${title} documents on file.`
              : "No matching invoices."}
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-md border border-default">
              <table className="w-full text-sm">
                <thead className="bg-elevated text-left text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          // tri-state: indeterminate when partial.
                          if (el) el.indeterminate = someSelected;
                        }}
                        onChange={() => onToggleAllRows(rows)}
                        aria-label={
                          allSelected
                            ? `Deselect all visible ${title} documents`
                            : `Select all visible ${title} documents`
                        }
                        className="cursor-pointer"
                      />
                    </th>
                    <SortHeader
                      label="Doc #"
                      sortKey="docNumber"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onClick={onToggleSort}
                    />
                    <th className="px-3 py-2 font-medium">Type</th>
                    <SortHeader
                      label="Issued"
                      sortKey="issueDate"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onClick={onToggleSort}
                    />
                    <th className="px-3 py-2 font-medium">Due</th>
                    <th className="px-3 py-2 font-medium">Memo</th>
                    <SortHeader
                      label="Total"
                      sortKey="total"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onClick={onToggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Balance"
                      sortKey="balance"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onClick={onToggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Last chased"
                      sortKey="lastChasedAt"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onClick={onToggleSort}
                    />
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <InvoiceTableRow
                      key={rowKey(row)}
                      row={row}
                      selected={selected.has(rowKey(row))}
                      onToggle={() => onToggleRow(row)}
                      onSend={() => onSend(row)}
                      onRemind={() => onRemind(row)}
                      onDisputeChanged={onDisputeChanged}
                      onEmailBookkeeper={() => onEmailBookkeeper(row)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-xs text-muted">
              <div>
                Showing {rows.length} of {bookDocCount}
              </div>
              <div className="flex items-center gap-3 tabular-nums">
                <span>
                  Total{" "}
                  <span className="text-primary">${totalSum.toFixed(2)}</span>
                </span>
                <span>
                  Open{" "}
                  <span
                    className={
                      openSum > 0 ? "text-accent-warning" : "text-muted"
                    }
                  >
                    ${openSum.toFixed(2)}
                  </span>
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
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
    case "lastChasedAt": {
      // Nulls (never-chased) sort to the END in ascending order so
      // "haven't chased recently" surfaces at the top when the
      // operator clicks asc → asc means oldest-chase-first AND
      // never-chased-first share the front of the list, which is
      // the actionable target. Tiny lie: empty string < anything
      // non-empty, so we use a guard instead of "".
      const aVal = a.lastChasedAt ?? "";
      const bVal = b.lastChasedAt ?? "";
      if (aVal === bVal) return 0;
      if (aVal === "") return -1;
      if (bVal === "") return 1;
      return aVal.localeCompare(bVal);
    }
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
  onDisputeChanged,
  onEmailBookkeeper,
}: {
  row: InvoiceRow;
  selected: boolean;
  onToggle: () => void;
  onSend: () => void;
  onRemind: () => void;
  onDisputeChanged: () => void;
  onEmailBookkeeper: () => void;
}) {
  // TJ invoices parked for verification render visually muted.
  const isVerifying = row.origin === "tj" && row.disputeState === "verifying";
  // Only show the dispute affordance on TJ invoices (never credit memos).
  const showDispute = row.origin === "tj" && row.docType === "invoice";
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
        // Parked-for-verification TJ invoices read muted so they don't
        // compete with active items in the list.
        isVerifying && "opacity-60",
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
      {/* No origin chip — the row's book is implied by which panel it
          lives in (origin-split-2). */}
      <td className="px-3 py-2 font-mono text-xs">{row.docNumber ?? "—"}</td>
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
      <td className="px-3 py-2 text-xs">
        <LastChasedCell
          docType={row.docType}
          lastChasedAt={row.lastChasedAt}
          lastChasedLevel={row.lastChasedLevel}
        />
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
          {showDispute ? (
            <DisputeActions
              invoice={{
                id: row.id,
                origin: row.origin,
                disputeState: row.disputeState,
                disputeClaimedAt: row.disputeClaimedAt,
                disputeNote: row.disputeNote,
                docNumber: row.docNumber,
                balance: row.balance,
              }}
              onChanged={onDisputeChanged}
              onEmailBookkeeper={onEmailBookkeeper}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// "Chased Nd ago (L1)" cell content. Credit memos always render dash
// (chase tracking is invoice-only). Never-chased invoices render a
// muted dash so the column reads clean. Tooltip shows the absolute
// timestamp for operators who want the exact date.
function LastChasedCell({
  docType,
  lastChasedAt,
  lastChasedLevel,
}: {
  docType: "invoice" | "credit_memo";
  lastChasedAt: string | null;
  lastChasedLevel: number | null;
}) {
  if (docType === "credit_memo" || !lastChasedAt) {
    return <span className="text-muted">—</span>;
  }
  const ago = detailRelativeTime(lastChasedAt);
  const absolute = new Date(lastChasedAt).toLocaleString();
  const level =
    lastChasedLevel === 1 || lastChasedLevel === 2 || lastChasedLevel === 3
      ? `L${lastChasedLevel}`
      : "L?";
  // Recency tone: < 7d ago = neutral (recently chased — don't re-chase
  // yet); 7-30d ago = info (chase candidate); 30d+ = warning (long
  // overdue chase). Same tone vocabulary used by other badges.
  const diffMs = Date.now() - new Date(lastChasedAt).getTime();
  const days = diffMs / (1000 * 60 * 60 * 24);
  const tone =
    days < 7
      ? "text-muted"
      : days < 30
        ? "text-secondary"
        : "text-accent-warning";
  return (
    <span className={tone} title={`Chased L${lastChasedLevel} on ${absolute}`}>
      {ago}{" "}
      <span className="text-[9px] uppercase tracking-wide">{level}</span>
    </span>
  );
}

function InvoiceStatusBadge({
  status,
  isPaid,
}: {
  status: string | null;
  isPaid: boolean;
}) {
  // Void first: a void invoice has balance 0 → isPaid would otherwise win and
  // render a green "Paid" badge, making the Void state unreachable.
  if (status === "void") return <Badge tone="medium">Void</Badge>;
  if (isPaid) return <Badge tone="success">Paid</Badge>;
  if (status === "overdue") return <Badge tone="critical">Overdue</Badge>;
  if (status === "partial") return <Badge tone="high">Partial</Badge>;
  if (status === "sent") return <Badge tone="info">Sent</Badge>;
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

function ReturnsPanel({
  customerId,
  rmaStatus,
  rmaType,
  onRmaStatusChange,
  onRmaTypeChange,
}: {
  customerId: string;
  rmaStatus: RmaStatus | "all";
  rmaType: RmaReturnType | "all";
  onRmaStatusChange: (v: RmaStatus | "all") => void;
  onRmaTypeChange: (v: RmaReturnType | "all") => void;
}) {
  const statusFilter = rmaStatus;
  const typeFilter = rmaType;

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
            onClick={() => onRmaStatusChange("all")}
          />
          {(Object.keys(RMA_STATUS_LABELS) as RmaStatus[]).map((s) => (
            <ReturnFilterChip
              key={s}
              label={RMA_STATUS_LABELS[s]}
              active={statusFilter === s}
              onClick={() =>
                onRmaStatusChange(statusFilter === s ? "all" : s)
              }
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Type:</span>
          <ReturnFilterChip
            label="All"
            active={typeFilter === "all"}
            onClick={() => onRmaTypeChange("all")}
          />
          {(Object.keys(RMA_TYPE_LABELS) as RmaReturnType[]).map((t) => (
            <ReturnFilterChip
              key={t}
              label={RMA_TYPE_LABELS[t]}
              active={typeFilter === t}
              onClick={() =>
                onRmaTypeChange(typeFilter === t ? "all" : t)
              }
            />
          ))}
        </div>
        {anyFilterActive && (
          <button
            type="button"
            onClick={() => {
              onRmaStatusChange("all");
              onRmaTypeChange("all");
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
