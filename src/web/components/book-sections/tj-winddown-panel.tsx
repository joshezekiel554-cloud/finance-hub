// Torah Judaica wind-down panel (origin-split-2 spec §1). Mounted below the
// Feldart section on /chase; consumes GET /api/chase/tj-winddown (one read
// returns exposure, monthly delta, aging buckets, verifying count, and
// per-customer rows with embedded invoices, so the panel never refetches on
// expand).
//
// What it does:
//   - Header KPIs: net exposure, delta vs ~28d ago (green ↓ / red ↑),
//     verifying count; actions: sequential batch TJ chase + TJ-scoped batch
//     statements over the row selection.
//   - Aging bar + a "next" hint (count of accounts at MEDIUM tier or above).
//   - Customer rows expand inline to per-invoice dispute actions — the full
//     Wave B claims-paid loop (park → verify → email bookkeeper →
//     void-in-QBO / resume) now operable from /chase.
//   - Batch chase is a review queue, not a fan-out: each selected customer
//     gets the normal preview/edit ChaseEmailSendDialog (origin 'tj' →
//     tj_l* templates) one at a time; cancelling aborts the rest.
//   - Zero state: when no open TJ invoices remain the panel collapses to a
//     single "wind-down complete" line. The spec's "hide entirely once the
//     last TJ invoice is voided/paid and no disputes remain" can't be
//     distinguished client-side from "complete" (both are an empty
//     customers array) — the one-liner IS the end state, by design.

import { Fragment, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Mail, Send } from "lucide-react";
import ChaseEmailSendDialog from "../chase-email-send-dialog";
import ComposeModal, { type ComposeContext } from "../compose-modal";
import { DisputeActions } from "../dispute-actions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { buildBookkeeperCompose } from "../../lib/bookkeeper-compose";
import { cn } from "../../lib/cn";
import { AgingBar } from "./aging-bar";
import { BookSectionHeader, KpiChip } from "./book-section-header";

// Response shape of GET /api/chase/tj-winddown — mirrors
// src/modules/chase/winddown.ts (TjWinddown). Kept local per the chase-page
// convention for single-consumer API types.
type WinddownInvoice = {
  id: string;
  docNumber: string | null;
  balance: number;
  dueDate: string | null;
  daysOverdue: number;
  disputeState: "verifying" | "confirmed_paid" | "confirmed_unpaid" | null;
  disputeClaimedAt: string | null;
  disputeNote: string | null;
};

type WinddownCustomer = {
  customerId: string;
  customerName: string;
  primaryEmail: string | null;
  netOwed: number;
  openCount: number;
  tier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  suggestedLevel: 1 | 2 | 3;
  daysOverdue: number;
  disputeChips: Array<{
    invoiceId: string;
    docNumber: string | null;
    state: "verifying" | "confirmed_paid" | "confirmed_unpaid";
  }>;
  invoices: WinddownInvoice[];
};

type TjWinddown = {
  exposure: number;
  deltaVs28d: number | null;
  baselineDate: string | null;
  buckets: { b90: number; b180: number; bOver: number };
  verifyingCount: number;
  customers: WinddownCustomer[];
};

type BatchResultEntry = {
  customerId: string;
  status: "sent" | "skipped" | "failed";
  error?: string;
};

// Same tone mapping as the dashboard chase widget's tier pill.
const TIER_TONES: Record<WinddownCustomer["tier"], "critical" | "high" | "medium" | "neutral"> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "neutral",
};

const WINDDOWN_QUERY_KEY = ["chase", "tj-winddown"] as const;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

// 'YYYY-MM-DD' → "May 13" (UTC so the date-only value doesn't shift).
function formatBaselineDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function TjWinddownPanel() {
  const queryClient = useQueryClient();

  const { data, isPending, isError, error } = useQuery<TjWinddown>({
    queryKey: WINDDOWN_QUERY_KEY,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch("/api/chase/tj-winddown");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // App settings — for the "Email TJ bookkeeper" compose prefill
  // (tj_bookkeeper_email). Same query key + staleness as customer-detail so
  // the two surfaces share the cache entry.
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

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Sequential batch-chase queue. queue[0] is the open dialog; onSent
  // advances, cancel aborts the remainder (the operator can reselect).
  const [chaseQueue, setChaseQueue] = useState<
    Array<{ customerId: string; customerName: string; level: 1 | 2 | 3 }>
  >([]);
  const [stmtConfirmOpen, setStmtConfirmOpen] = useState(false);
  const [stmtSummary, setStmtSummary] = useState<{
    sent: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [composeContext, setComposeContext] = useState<ComposeContext | null>(
    null,
  );

  const customers = data?.customers ?? [];
  const selectedRows = useMemo(
    () => customers.filter((c) => selectedIds.has(c.customerId)),
    [customers, selectedIds],
  );
  const actionableCount = useMemo(
    () => customers.filter((c) => c.tier !== "LOW").length,
    [customers],
  );

  const statementBatch = useMutation<
    { results: BatchResultEntry[] },
    Error,
    string[]
  >({
    mutationFn: async (customerIds) => {
      const res = await fetch("/api/chase/batch-statement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Always TJ-scoped from this panel.
        body: JSON.stringify({ customerIds, origin: "tj" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ results: BatchResultEntry[] }>;
    },
    onSuccess: (response) => {
      setStmtSummary({
        sent: response.results.filter((r) => r.status === "sent").length,
        skipped: response.results.filter((r) => r.status === "skipped").length,
        failed: response.results.filter((r) => r.status === "failed").length,
      });
      setSelectedIds(new Set());
      setStmtConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: WINDDOWN_QUERY_KEY });
    },
  });

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startBatchChase() {
    // Only rows with an email can be chased; the per-row button is disabled
    // for the rest, mirror that here.
    setChaseQueue(
      selectedRows
        .filter((c) => c.primaryEmail)
        .map((c) => ({
          customerId: c.customerId,
          customerName: c.customerName,
          level: c.suggestedLevel,
        })),
    );
  }

  function onDisputeChanged() {
    void queryClient.invalidateQueries({ queryKey: WINDDOWN_QUERY_KEY });
    // Customer detail may be open in another tab; keep its invoice list in
    // step the same way the chase page does after sends.
    void queryClient.invalidateQueries({ queryKey: ["customer-invoices"] });
    // Dispute resolutions move overdue figures — keep the dashboard chase
    // widget fresh too.
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "chase"] });
  }

  function openBookkeeperCompose(
    customer: WinddownCustomer,
    inv: WinddownInvoice,
  ) {
    setComposeContext({
      customerId: customer.customerId,
      customerName: customer.customerName,
      customerEmail: tjBookkeeperEmail,
      // Server records the sent Gmail threadId on this invoice
      // (bookkeeper_thread_id) so the dispute-nudge can track the thread.
      disputeInvoiceId: inv.id,
      prefill: buildBookkeeperCompose({
        customerName: customer.customerName,
        docNumber: inv.docNumber ?? inv.id,
        balance: inv.balance,
      }),
    });
  }

  // ── Zero state: no open TJ invoices left. One muted line; this is also
  // the terminal "hidden" state (see header comment). ──────────────────────
  if (data && customers.length === 0 && data.exposure === 0 && data.verifyingCount === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-default bg-subtle px-4 py-2.5 text-sm text-muted">
        <span className="size-2 rounded-full bg-accent-warning/50" aria-hidden />
        Torah Judaica wind-down complete — $0 outstanding
      </div>
    );
  }

  const activeChase = chaseQueue[0];

  return (
    <section className="rounded-lg border border-default bg-subtle shadow-sm">
      <BookSectionHeader
        book="tj"
        title="Torah Judaica"
        subtitle="wind-down"
        kpis={
          data ? (
            <>
              <KpiChip title="Net TJ exposure (credits netted, verifying included)">
                Exposure {money(data.exposure)}
              </KpiChip>
              {data.deltaVs28d !== null && data.baselineDate !== null ? (
                data.deltaVs28d === 0 ? (
                  <KpiChip>
                    No change since {formatBaselineDate(data.baselineDate)}
                  </KpiChip>
                ) : (
                  <KpiChip
                    tone={data.deltaVs28d < 0 ? "success" : "danger"}
                    title="Exposure change vs the snapshot taken about a month ago"
                  >
                    {data.deltaVs28d < 0 ? "↓" : "↑"}{" "}
                    {money(Math.abs(data.deltaVs28d))} since{" "}
                    {formatBaselineDate(data.baselineDate)}
                  </KpiChip>
                )
              ) : null}
              {data.verifyingCount > 0 ? (
                <KpiChip
                  tone="warning"
                  title="Invoices parked for bookkeeper verification"
                >
                  Verifying {data.verifyingCount}
                </KpiChip>
              ) : null}
            </>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setStmtConfirmOpen(true)}
              disabled={selectedIds.size === 0 || statementBatch.isPending}
              loading={statementBatch.isPending}
              title="Send TJ-only open-items statements to the selected customers"
            >
              <Send className="size-3.5" />
              Statements
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={startBatchChase}
              disabled={selectedIds.size === 0 || statementBatch.isPending}
              title="Review and send a TJ chase email to each selected customer, one at a time"
            >
              <Mail className="size-3.5" />
              Send TJ chase ({selectedIds.size})
            </Button>
          </>
        }
      />

      {isPending ? (
        <div className="px-4 py-6 text-sm text-muted">
          Loading Torah Judaica wind-down…
        </div>
      ) : isError ? (
        <div className="px-4 py-6 text-sm text-accent-danger">
          {(error as Error)?.message ?? "Failed to load TJ wind-down"}
        </div>
      ) : data ? (
        <>
          <div className="space-y-2 border-b border-default px-4 py-3">
            <AgingBar buckets={data.buckets} />
            {actionableCount > 0 ? (
              <div>
                <KpiChip tone="warning" title="Accounts at MEDIUM tier or above">
                  Next: chase {actionableCount} account
                  {actionableCount === 1 ? "" : "s"}
                </KpiChip>
              </div>
            ) : null}
          </div>

          {stmtSummary ? (
            <div className="flex flex-wrap items-center gap-3 border-b border-default px-4 py-2 text-xs">
              <span>
                <span className="font-medium">Statements:</span>{" "}
                <span className="text-accent-success">
                  {stmtSummary.sent} sent
                </span>
                {stmtSummary.skipped > 0 ? (
                  <span className="text-accent-warning">
                    {" · "}
                    {stmtSummary.skipped} skipped
                  </span>
                ) : null}
                {stmtSummary.failed > 0 ? (
                  <span className="text-accent-danger">
                    {" · "}
                    {stmtSummary.failed} failed
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => setStmtSummary(null)}
                className="ml-auto text-muted hover:text-primary"
              >
                Done
              </button>
            </div>
          ) : null}

          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted [&_th]:border-b [&_th]:border-default">
              <tr>
                <th className="w-10 px-3 py-2">
                  <span className="sr-only">Select</span>
                </th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2 text-right">Net owed</th>
                <th className="px-3 py-2 text-right">Open</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => {
                const expanded = expandedIds.has(c.customerId);
                const verifyingChips = c.disputeChips.filter(
                  (chip) => chip.state === "verifying",
                );
                return (
                  <Fragment key={c.customerId}>
                    <tr className="border-b border-default align-middle last:border-b-0 hover:bg-elevated">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.customerId)}
                          onChange={() => toggleSelected(c.customerId)}
                          disabled={statementBatch.isPending}
                          className="size-4 rounded border-default"
                          aria-label={`Select ${c.customerName}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">
                        <a
                          href={`/customers/${c.customerId}`}
                          className="hover:text-accent-primary hover:underline underline-offset-2"
                        >
                          {c.customerName}
                        </a>
                        {verifyingChips.length > 0 ? (
                          <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                            {verifyingChips.map((chip) => (
                              <span
                                key={chip.invoiceId}
                                className="inline-flex items-center rounded border border-accent-warning/40 bg-accent-warning/10 px-1 text-[10px] font-medium text-accent-warning"
                                title="Parked for bookkeeper verification"
                              >
                                #{chip.docNumber ?? chip.invoiceId} verifying
                              </span>
                            ))}
                          </span>
                        ) : null}
                        {!c.primaryEmail ? (
                          <span className="ml-2 text-[11px] text-accent-warning">
                            no email
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          tone={TIER_TONES[c.tier]}
                          title={
                            c.daysOverdue > 0
                              ? `${c.daysOverdue}d overdue (oldest chaseable invoice)`
                              : undefined
                          }
                        >
                          {c.tier}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {money(c.netOwed)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {c.openCount}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!c.primaryEmail}
                            title={
                              c.primaryEmail
                                ? `Send a TJ chase email (level ${c.suggestedLevel} suggested by tier)`
                                : "Customer has no primary email"
                            }
                            onClick={() =>
                              setChaseQueue([
                                {
                                  customerId: c.customerId,
                                  customerName: c.customerName,
                                  level: c.suggestedLevel,
                                },
                              ])
                            }
                          >
                            <Mail className="size-3.5" />
                            TJ L{c.suggestedLevel}
                          </Button>
                          <button
                            type="button"
                            onClick={() => toggleExpanded(c.customerId)}
                            className="rounded p-1 text-muted hover:bg-elevated hover:text-primary"
                            aria-expanded={expanded}
                            aria-label={
                              expanded
                                ? `Collapse invoices for ${c.customerName}`
                                : `Expand invoices for ${c.customerName}`
                            }
                          >
                            {expanded ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-b border-default last:border-b-0">
                        <td colSpan={6} className="bg-elevated/50 px-4 py-2">
                          <div className="divide-y divide-default/60">
                            {c.invoices.map((inv) => (
                              <div
                                key={inv.id}
                                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
                              >
                                <div className="text-xs text-secondary">
                                  <span className="font-medium text-primary">
                                    #{inv.docNumber ?? inv.id}
                                  </span>
                                  <span className="tabular-nums">
                                    {" · "}
                                    {money(inv.balance)}
                                  </span>
                                  {" · "}
                                  {inv.daysOverdue > 0 ? (
                                    <span
                                      className={cn(
                                        inv.daysOverdue > 90 &&
                                          "text-accent-danger",
                                      )}
                                    >
                                      {inv.daysOverdue}d overdue
                                    </span>
                                  ) : (
                                    <span className="text-muted">
                                      not yet due
                                    </span>
                                  )}
                                </div>
                                <DisputeActions
                                  invoice={{
                                    id: inv.id,
                                    origin: "tj",
                                    disputeState: inv.disputeState,
                                    disputeClaimedAt: inv.disputeClaimedAt,
                                    disputeNote: inv.disputeNote,
                                    docNumber: inv.docNumber,
                                    balance: inv.balance.toFixed(2),
                                  }}
                                  onChanged={onDisputeChanged}
                                  onEmailBookkeeper={() =>
                                    openBookkeeperCompose(c, inv)
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {customers.length === 0 ? (
                // Reachable only while disputes/exposure linger without open
                // rows (defensive — the aggregation derives all three from
                // the same invoice set, so in practice the one-line zero
                // state above catches the empty case first).
                <tr>
                  <td colSpan={6} className="p-6 text-center text-sm text-muted">
                    No open Torah Judaica invoices.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </>
      ) : null}

      {/* Batch-statement confirm — mirrors the Feldart confirm dialog so a
          misclick can't fan out N emails. */}
      <Dialog
        open={stmtConfirmOpen}
        onOpenChange={(v) => {
          if (!statementBatch.isPending) setStmtConfirmOpen(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Send TJ statements to {selectedIds.size} customer
              {selectedIds.size === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Each customer receives an open-items statement covering only
              their Torah Judaica invoices.
            </DialogDescription>
          </DialogHeader>
          {statementBatch.isError ? (
            <div className="rounded-md border border-accent-danger/40 bg-accent-danger/10 p-3 text-sm text-accent-danger">
              {statementBatch.error?.message ?? "Send failed"}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStmtConfirmOpen(false)}
              disabled={statementBatch.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={statementBatch.isPending}
              disabled={statementBatch.isPending || selectedIds.size === 0}
              onClick={() =>
                statementBatch.mutate(selectedRows.map((c) => c.customerId))
              }
            >
              <Send className="size-3.5" />
              Send {selectedIds.size} statement
              {selectedIds.size === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeChase ? (
        <ChaseEmailSendDialog
          open={true}
          onOpenChange={(next) => {
            // Cancel aborts the remaining queue — predictable over trapping
            // the operator in N dialogs.
            if (!next) setChaseQueue([]);
          }}
          customerId={activeChase.customerId}
          customerName={activeChase.customerName}
          origin="tj"
          level={activeChase.level}
          onSent={() => {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.delete(activeChase.customerId);
              return next;
            });
            void queryClient.invalidateQueries({ queryKey: WINDDOWN_QUERY_KEY });
            setChaseQueue((q) => q.slice(1));
          }}
        />
      ) : null}

      {composeContext ? (
        <ComposeModal
          open={true}
          onOpenChange={(next) => {
            if (!next) setComposeContext(null);
          }}
          context={composeContext}
        />
      ) : null}
    </section>
  );
}
