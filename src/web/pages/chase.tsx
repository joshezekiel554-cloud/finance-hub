// Chase list page. Backs /chase. Surfaces every B2B customer with an
// overdue balance, lets the user multi-select + batch-send open-items
// statements, and shows per-row outcomes once the batch lands.
//
// Key UX choices:
//   - Default filters: holdStatus=All, customerType=B2B. The "All"
//     hold default is intentional — chasing a customer who happens to
//     be on hold is still a real workflow. The B2B default mirrors
//     the customers list and matches who actually receives statements.
//   - The "Send statements" button is gated by selection count. A
//     confirm modal interposes between click and fan-out so misclicks
//     don't fire 50 emails.
//   - Per-row Send mini-button bypasses the confirm modal: clicking
//     the row's button IS the confirm. We surface in-line spinner +
//     toast/error in that flow.
//   - In-flight progress: while the batch is running, the table
//     freezes (selection locked, send button shows spinner). When the
//     batch completes we render a result column per row instead of
//     navigating away — the operator usually wants to read the
//     skipped/failed list before doing anything else. Results cleared
//     by clicking "Done" on the result banner.
//   - 150-row worst case: this page renders 150 plain table rows.
//     Tested to be smooth without virtualization. Sorting is server-
//     driven so the table stays snappy.

import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Mail, Pause, Send, AlertCircle, CheckCircle2 } from "lucide-react";
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
import { cn } from "../lib/cn";

// API result types — kept local because the chase page is the only
// consumer. If a second consumer turns up, lift these into a shared
// `web/types` file.
type ChaseRow = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  balance: string;
  overdueBalance: string;
  holdStatus: "active" | "hold";
  customerType: "b2b" | "b2c" | null;
  paymentTerms: string | null;
  daysSinceOldestUnpaid: number | null;
  lastActivityAt: string | null;
};

type ListResponse = {
  rows: ChaseRow[];
  total: number;
};

type BatchResultEntry = {
  customerId: string;
  status: "sent" | "skipped" | "failed";
  error?: string;
  statementSendId?: string;
};

type BatchResponse = {
  results: BatchResultEntry[];
};

type CustomerTypeFilter = "b2b" | "b2c" | "all";
type HoldFilter = "active" | "hold" | "all";
type SortKey =
  | "overdueBalance"
  | "daysOverdue"
  | "displayName"
  | "lastActivityAt";

const HOLD_LABELS: Record<HoldFilter, string> = {
  active: "Active",
  hold: "Hold",
  all: "All",
};

const CUSTOMER_TYPE_LABELS: Record<CustomerTypeFilter, string> = {
  b2b: "B2B",
  b2c: "B2C",
  all: "All",
};

export default function ChasePage() {
  const [customerTypeFilter, setCustomerTypeFilter] =
    useState<CustomerTypeFilter>("b2b");
  const [holdFilter, setHoldFilter] = useState<HoldFilter>("all");
  const [sort, setSort] = useState<SortKey>("overdueBalance");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Per-customer outcome map indexed by customerId. Populated when a
  // batch (or a per-row send) completes; rendered inline as a status
  // pill on the row. Cleared via the "Done" button on the result
  // banner.
  const [resultsById, setResultsById] = useState<
    Record<string, BatchResultEntry>
  >({});
  // Tracks in-flight per-row sends (the mini-button on each row). The
  // batch flow uses a single boolean (mutation.isPending) but per-row
  // needs per-id state so we don't lock the whole table for a single
  // customer's send.
  const [rowSendingIds, setRowSendingIds] = useState<Set<string>>(new Set());

  const queryClient = useQueryClient();

  const queryKey = [
    "chase",
    "customers",
    { customerTypeFilter, holdFilter, sort, dir },
  ] as const;

  const { data, isPending, isError, error } = useQuery<ListResponse>({
    queryKey,
    // 60s stale time per spec — overdue balances don't move minute-to-
    // minute and the page is heavyweight enough that thrashing on
    // window focus would feel jumpy.
    staleTime: 60_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        customerType: customerTypeFilter,
        holdStatus: holdFilter,
        sort,
        dir,
      });
      const res = await fetch(`/api/chase/customers?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];

  const batchMutation = useMutation<BatchResponse, Error, string[]>({
    mutationFn: async (customerIds) => {
      const res = await fetch("/api/chase/batch-statement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerIds }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<BatchResponse>;
    },
    onSuccess: (response) => {
      // Build a lookup so the table can render per-row outcomes.
      const next: Record<string, BatchResultEntry> = { ...resultsById };
      for (const r of response.results) {
        next[r.customerId] = r;
      }
      setResultsById(next);
      setSelectedIds(new Set());
      setConfirmOpen(false);
      // The list itself doesn't change shape (overdue balances haven't
      // moved), but the "last activity" column will pick up a new
      // qbo_statement_sent activity for every customer that succeeded.
      // Invalidate so the next refetch reflects that.
      queryClient.invalidateQueries({ queryKey: ["chase", "customers"] });
    },
    onError: () => {
      // Leave the modal open so the user can retry. The error is
      // surfaced in-modal via batchMutation.error.
    },
  });

  function toggleId(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  function toggleSelectAll() {
    if (rows.length > 0 && rows.every((r) => selectedIds.has(r.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  }

  // Total overdue across the current selection. Used in the toolbar
  // banner so the operator knows the dollar value they're about to
  // chase. parseFloat is safe — overdueBalance is server-validated as a
  // decimal string.
  const selectedTotalOverdue = useMemo(() => {
    let sum = 0;
    for (const row of rows) {
      if (selectedIds.has(row.id)) sum += parseFloat(row.overdueBalance) || 0;
    }
    return sum;
  }, [rows, selectedIds]);

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));

  function clearResults() {
    setResultsById({});
  }

  // Per-row send. Reuses the existing single-customer endpoint so we
  // don't double up logic — the batch endpoint is for fan-out, not for
  // single-row work. Failures show up in the row outcome map; success
  // populates with a synthetic entry that mirrors the batch response
  // shape so the result rendering code path stays uniform.
  async function sendOneRow(customerId: string) {
    setRowSendingIds((prev) => {
      const next = new Set(prev);
      next.add(customerId);
      return next;
    });
    try {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerId)}/statement-send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string; code?: string };
          if (body.error)
            errMsg = body.code ? `${body.code}: ${body.error}` : body.error;
        } catch {
          // ignore — keep generic message
        }
        setResultsById((prev) => ({
          ...prev,
          [customerId]: {
            customerId,
            status: "failed",
            error: errMsg,
          },
        }));
      } else {
        const body = (await res.json()) as { statementSendId?: string };
        setResultsById((prev) => ({
          ...prev,
          [customerId]: {
            customerId,
            status: "sent",
            statementSendId: body.statementSendId,
          },
        }));
        queryClient.invalidateQueries({ queryKey: ["chase", "customers"] });
      }
    } finally {
      setRowSendingIds((prev) => {
        const next = new Set(prev);
        next.delete(customerId);
        return next;
      });
    }
  }

  const resultSummary = useMemo(() => {
    const values = Object.values(resultsById);
    return {
      total: values.length,
      sent: values.filter((v) => v.status === "sent").length,
      skipped: values.filter((v) => v.status === "skipped").length,
      failed: values.filter((v) => v.status === "failed").length,
    };
  }, [resultsById]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Chase list</h1>
        <p className="mt-1 text-sm text-secondary">
          B2B customers with overdue balances. Send open-items statements
          to selected.
        </p>
      </div>

      <FilterBar
        customerTypeFilter={customerTypeFilter}
        onCustomerTypeChange={(v) => {
          setCustomerTypeFilter(v);
          setSelectedIds(new Set());
        }}
        holdFilter={holdFilter}
        onHoldChange={(v) => {
          setHoldFilter(v);
          setSelectedIds(new Set());
        }}
      />

      {resultSummary.total > 0 && (
        <ResultBanner summary={resultSummary} onClear={clearResults} />
      )}

      {isError && (
        <Card>
          <CardBody className="text-sm text-accent-danger">
            {(error as Error)?.message ?? "Failed to load chase list"}
          </CardBody>
        </Card>
      )}

      <Toolbar
        selectedCount={selectedIds.size}
        selectedTotalOverdue={selectedTotalOverdue}
        allSelected={allSelected}
        rowsPresent={rows.length > 0}
        onToggleSelectAll={toggleSelectAll}
        onClickSend={() => setConfirmOpen(true)}
        sending={batchMutation.isPending}
      />

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-secondary">
            {isPending
              ? "Loading…"
              : `${rows.length} customer${rows.length === 1 ? "" : "s"} with overdue balance`}
          </h2>
        </CardHeader>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="size-4 rounded border-default"
                    aria-label="Select all"
                    disabled={rows.length === 0 || batchMutation.isPending}
                  />
                </th>
                <SortableTh
                  label="Customer"
                  active={sort === "displayName"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("displayName", sort, setSort, dir, setDir)
                  }
                />
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <SortableTh
                  label="Overdue"
                  active={sort === "overdueBalance"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("overdueBalance", sort, setSort, dir, setDir)
                  }
                  align="right"
                />
                <SortableTh
                  label="Days since oldest"
                  active={sort === "daysOverdue"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("daysOverdue", sort, setSort, dir, setDir)
                  }
                  align="right"
                />
                <SortableTh
                  label="Last activity"
                  active={sort === "lastActivityAt"}
                  dir={dir}
                  onClick={() =>
                    toggleSort("lastActivityAt", sort, setSort, dir, setDir)
                  }
                />
                <th className="px-3 py-2">Terms</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const checked = selectedIds.has(row.id);
                const onHold = row.holdStatus === "hold";
                const overdue = parseFloat(row.overdueBalance) || 0;
                const balance = parseFloat(row.balance) || 0;
                const result = resultsById[row.id];
                const sending = rowSendingIds.has(row.id);
                const days = row.daysSinceOldestUnpaid;
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      "border-b border-default last:border-b-0 align-middle",
                      onHold
                        ? "bg-accent-danger/10 hover:bg-accent-danger/15"
                        : "hover:bg-elevated",
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleId(row.id)}
                        disabled={batchMutation.isPending}
                        className="size-4 rounded border-default"
                        aria-label={`Select ${row.displayName}`}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <a
                        href={`/customers/${row.id}`}
                        className="hover:text-accent-primary hover:underline underline-offset-2"
                      >
                        {row.displayName}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {row.primaryEmail ?? (
                        <span className="text-accent-warning">— no email</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {balance > 0 ? (
                        <span>${balance.toFixed(2)}</span>
                      ) : (
                        <span className="text-muted">$0.00</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className="font-bold text-accent-danger">
                        ${overdue.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {days === null ? (
                        <span className="text-muted">—</span>
                      ) : days > 0 ? (
                        <span className="font-medium">{days}d</span>
                      ) : (
                        <span className="text-muted">{days}d</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {row.lastActivityAt ? (
                        relativeTime(row.lastActivityAt)
                      ) : (
                        <span className="text-muted">never</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {row.paymentTerms ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {onHold ? (
                        <Badge tone="critical">
                          <Pause className="mr-1 size-3" />
                          Hold
                        </Badge>
                      ) : (
                        <Badge tone="success">Active</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {result ? (
                        <ResultPill result={result} />
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => sendOneRow(row.id)}
                          disabled={
                            sending ||
                            batchMutation.isPending ||
                            !row.primaryEmail
                          }
                          loading={sending}
                          title={
                            !row.primaryEmail
                              ? "Customer has no primary email"
                              : "Send statement now"
                          }
                        >
                          <Mail className="size-3.5" />
                          Send
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!isPending && rows.length === 0 && (
                <tr>
                  <td className="p-8 text-center text-sm text-muted" colSpan={10}>
                    No customers match these filters. 🎉
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          // Don't close the modal mid-mutation — the user already
          // confirmed, results land via onSuccess.
          if (!batchMutation.isPending) setConfirmOpen(v);
        }}
        count={selectedIds.size}
        totalOverdue={selectedTotalOverdue}
        sending={batchMutation.isPending}
        error={
          batchMutation.isError
            ? (batchMutation.error as Error | null)?.message ?? "Send failed"
            : null
        }
        onConfirm={() => batchMutation.mutate(Array.from(selectedIds))}
      />
    </div>
  );
}

function FilterBar({
  customerTypeFilter,
  onCustomerTypeChange,
  holdFilter,
  onHoldChange,
}: {
  customerTypeFilter: CustomerTypeFilter;
  onCustomerTypeChange: (v: CustomerTypeFilter) => void;
  holdFilter: HoldFilter;
  onHoldChange: (v: HoldFilter) => void;
}) {
  return (
    <Card>
      <CardBody className="flex flex-wrap items-center gap-4 py-3">
        <ChipGroup label="Hold status">
          {(["active", "hold", "all"] as HoldFilter[]).map((v) => (
            <Chip
              key={v}
              active={holdFilter === v}
              onClick={() => onHoldChange(v)}
            >
              {HOLD_LABELS[v]}
            </Chip>
          ))}
        </ChipGroup>
        <ChipGroup label="Customer type">
          {(["b2b", "b2c", "all"] as CustomerTypeFilter[]).map((v) => (
            <Chip
              key={v}
              active={customerTypeFilter === v}
              onClick={() => onCustomerTypeChange(v)}
            >
              {CUSTOMER_TYPE_LABELS[v]}
            </Chip>
          ))}
        </ChipGroup>
      </CardBody>
    </Card>
  );
}

function Toolbar({
  selectedCount,
  selectedTotalOverdue,
  allSelected,
  rowsPresent,
  onToggleSelectAll,
  onClickSend,
  sending,
}: {
  selectedCount: number;
  selectedTotalOverdue: number;
  allSelected: boolean;
  rowsPresent: boolean;
  onToggleSelectAll: () => void;
  onClickSend: () => void;
  sending: boolean;
}) {
  return (
    <Card>
      <CardBody className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <span className="text-secondary">
          <span className="font-medium text-primary">{selectedCount}</span>{" "}
          customer{selectedCount === 1 ? "" : "s"} selected
          {selectedCount > 0 && (
            <>
              {" · "}
              <span>
                total overdue:{" "}
                <span className="font-medium text-accent-danger">
                  ${selectedTotalOverdue.toFixed(2)}
                </span>
              </span>
            </>
          )}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={onToggleSelectAll}
          disabled={!rowsPresent || sending}
        >
          {allSelected ? "Clear selection" : "Select all"}
        </Button>
        <div className="ml-auto">
          <Button
            variant="primary"
            size="sm"
            onClick={onClickSend}
            disabled={selectedCount === 0 || sending}
            loading={sending}
          >
            <Send className="size-3.5" />
            {sending ? "Sending…" : "Send statements"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function ResultBanner({
  summary,
  onClear,
}: {
  summary: { total: number; sent: number; skipped: number; failed: number };
  onClear: () => void;
}) {
  const tone =
    summary.failed > 0
      ? "border-accent-danger/40 bg-accent-danger/10"
      : summary.skipped > 0
        ? "border-accent-warning/40 bg-accent-warning/10"
        : "border-accent-success/40 bg-accent-success/10";
  return (
    <Card className={cn(tone)}>
      <CardBody className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <CheckCircle2 className="size-4 text-accent-success" />
        <span>
          <span className="font-medium">Batch complete:</span>{" "}
          <span className="text-accent-success">{summary.sent} sent</span>
          {summary.skipped > 0 && (
            <>
              {" · "}
              <span className="text-accent-warning">
                {summary.skipped} skipped
              </span>
            </>
          )}
          {summary.failed > 0 && (
            <>
              {" · "}
              <span className="text-accent-danger">
                {summary.failed} failed
              </span>
            </>
          )}
        </span>
        <span className="text-muted">
          See per-row status in the Actions column.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="ml-auto"
        >
          Done
        </Button>
      </CardBody>
    </Card>
  );
}

function ResultPill({ result }: { result: BatchResultEntry }) {
  if (result.status === "sent") {
    return (
      <Badge tone="success" title={result.statementSendId ?? undefined}>
        <CheckCircle2 className="mr-1 size-3" />
        Sent
      </Badge>
    );
  }
  if (result.status === "skipped") {
    return (
      <Badge tone="high" title={result.error ?? undefined}>
        Skipped
      </Badge>
    );
  }
  return (
    <Badge tone="critical" title={result.error ?? undefined}>
      <AlertCircle className="mr-1 size-3" />
      Failed
    </Badge>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  count,
  totalOverdue,
  sending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  count: number;
  totalOverdue: number;
  sending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send statements to {count} customers?</DialogTitle>
          <DialogDescription>
            Each customer will receive an Open-Items Statement with all
            their open invoice PDFs attached. The total overdue across this
            selection is{" "}
            <span className="font-medium text-accent-danger">
              ${totalOverdue.toFixed(2)}
            </span>
            .
          </DialogDescription>
        </DialogHeader>
        {sending && (
          <div className="rounded-md border border-default bg-subtle p-3 text-sm text-secondary">
            Sending {count} statement{count === 1 ? "" : "s"}… this may take
            a minute. Each statement fans out PDF fetches + a Gmail send.
          </div>
        )}
        {error && (
          <div className="rounded-md border border-accent-danger/40 bg-accent-danger/10 p-3 text-sm text-accent-danger">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
            loading={sending}
            disabled={sending || count === 0}
          >
            <Send className="size-3.5" />
            Send {count} statement{count === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-muted">{label}:</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
          : "border-default text-secondary hover:border-strong hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "cursor-pointer select-none px-3 py-2 hover:text-primary",
        align === "right" && "text-right",
      )}
    >
      {label}
      {active && <span className="ml-1">{dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}

function toggleSort(
  col: SortKey,
  current: SortKey,
  setSort: (s: SortKey) => void,
  currentDir: "asc" | "desc",
  setDir: (d: "asc" | "desc") => void,
): void {
  if (current === col) {
    setDir(currentDir === "asc" ? "desc" : "asc");
  } else {
    setSort(col);
    // Sensible default direction by column type. Numerical columns
    // (overdue, days-overdue) start desc; alphanumeric (name) starts
    // asc; lastActivityAt starts asc so "longest unattended" surfaces
    // first.
    setDir(
      col === "overdueBalance" || col === "daysOverdue" ? "desc" : "asc",
    );
  }
}

// Relative-time formatter, mirroring the helper inside
// activity-timeline.tsx so the chase row "last activity" column reads
// in the same vocabulary as the customer detail timeline. Lifted into
// its own helper because the timeline file isn't a public component
// export and the spec locks customer-detail.
function relativeTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: diffDay > 365 ? "numeric" : undefined,
  });
}
