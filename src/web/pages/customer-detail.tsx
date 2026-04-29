import { useState } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pause, Play, Mail } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";

type Customer = {
  id: string;
  qbCustomerId: string | null;
  displayName: string;
  primaryEmail: string | null;
  billingEmails: string[] | null;
  paymentTerms: string | null;
  holdStatus: "active" | "hold";
  shopifyCustomerId: string | null;
  customerType: "b2b" | "b2c" | null;
  balance: string;
  overdueBalance: string;
  internalNotes: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Activity = {
  id: string;
  customerId: string;
  userId: string | null;
  kind: string;
  occurredAt: string;
  subject: string | null;
  body: string | null;
  bodyHtml: string | null;
  source: string;
  refType: string | null;
  refId: string | null;
  meta: Record<string, unknown> | null;
};

type DetailResponse = {
  customer: Customer;
  recentActivities: Activity[];
};

type TabKey = "activity" | "invoices" | "orders" | "tasks" | "notes";

const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "invoices", label: "Invoices" },
  { key: "orders", label: "Orders" },
  { key: "tasks", label: "Tasks" },
  { key: "notes", label: "Notes" },
];

export default function CustomerDetailPage() {
  const { customerId } = useParams({ from: "/customers/$customerId" });
  const [tab, setTab] = useState<TabKey>("activity");
  const queryClient = useQueryClient();

  const { data, isPending, isError, error } = useQuery<DetailResponse>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const patchMutation = useMutation({
    mutationFn: async (input: Partial<Customer>) => {
      const res = await fetch(`/api/customers/${customerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
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

  const { customer, recentActivities } = data;
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
              <Badge tone="medium">
                <Pause className="mr-1 size-3" />
                On hold
              </Badge>
            ) : (
              <Badge tone="success">Active</Badge>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              patchMutation.mutate({
                holdStatus: customer.holdStatus === "hold" ? "active" : "hold",
              })
            }
            disabled={patchMutation.isPending}
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
        <StatCard
          label="Terms"
          value={customer.paymentTerms ?? "—"}
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
          <ActivityPanel activities={recentActivities} />
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

function CustomerTypeBadge({ type }: { type: "b2b" | "b2c" | null }) {
  if (type === "b2b") return <Badge tone="info">B2B</Badge>;
  if (type === "b2c") return <Badge tone="neutral">B2C</Badge>;
  return <Badge tone="medium">Untagged</Badge>;
}

// Activity panel — temporary inline implementation. Task #6 replaces this
// with the dedicated <ActivityTimeline /> component (SSE-wired, kind
// filter chips, click-to-expand).
function ActivityPanel({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-muted">
          No activity yet for this customer.
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-2 p-0">
        {activities.map((a) => (
          <div
            key={a.id}
            className="border-b border-default px-4 py-3 text-sm last:border-b-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{a.subject ?? a.kind}</span>
              <span className="text-xs text-muted">
                {new Date(a.occurredAt).toLocaleString()}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-secondary">
              <Badge tone="neutral">{a.kind}</Badge>
              <span>{a.source}</span>
            </div>
            {a.body && (
              <p className="mt-2 line-clamp-2 text-secondary">{a.body}</p>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
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
