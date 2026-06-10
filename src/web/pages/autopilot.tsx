import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  ProposalCard,
  categoryLabel,
  type Proposal,
} from "../components/autopilot/proposal-card";
import ComposeModal, {
  type ComposeContext,
} from "../components/compose-modal";
import {
  BookSectionHeader,
  KpiChip,
} from "../components/book-sections/book-section-header";

const CHASE_ALIAS = "accounts@feldart.com";

// Categories that don't need an AI draft step.
const NO_DRAFT_CATEGORIES = new Set([
  "cadence_statement",
  "ops_cron_fail",
]);

// Rough estimate per AI draft, in USD. Refined from real cost-tracker data
// in a follow-up.
const ESTIMATED_DRAFT_COST_USD = 0.05;

type SortKey = "urgency" | "name" | "oldest" | "newest";

// Tier rank for urgency sort. Proposals without a tier (cadence_*, ops_*)
// fall to 0 — they sort below tiered chase proposals. daysOverdue acts as
// the within-tier tiebreaker.
const TIER_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function urgencyScore(p: Proposal): number {
  const sum = p.candidateSummary as Record<string, unknown>;
  const tier = typeof sum.tier === "string" ? (TIER_RANK[sum.tier] ?? 0) : 0;
  const days =
    typeof sum.daysOverdue === "number" ? sum.daysOverdue : 0;
  const daysInState =
    typeof sum.daysInState === "number" ? sum.daysInState : 0;
  // Tier dominates; days metrics tiebreak.
  return tier * 10_000 + days + daysInState;
}

function customerName(p: Proposal): string {
  return (
    (p.candidateSummary as { customerName?: string }).customerName ??
    p.entityId
  );
}

// Group customer-typed proposals by entityId; non-customer kept separate.
// The OUTER customer groups are sorted by the active sort key — within a
// group, proposals stay in API order (no within-group sort yet). Runs once
// per book section (origin-split-2 §3): the split happens before grouping,
// the grouping + sort behaviour inside a section is unchanged.
function groupAndSort(
  rows: Proposal[],
  sortKey: SortKey,
): { customerEntries: [string, Proposal[]][]; nonCustomer: Proposal[] } {
  const byCustomer = new Map<string, Proposal[]>();
  const nonCustomer: Proposal[] = [];
  for (const p of rows) {
    if (p.entityType === "customer") {
      const list = byCustomer.get(p.entityId) ?? [];
      list.push(p);
      byCustomer.set(p.entityId, list);
    } else {
      nonCustomer.push(p);
    }
  }
  const entries = Array.from(byCustomer.entries());
  const compareByKey = (
    a: [string, Proposal[]],
    b: [string, Proposal[]],
  ): number => {
    if (sortKey === "name") {
      return customerName(a[1][0]!).localeCompare(customerName(b[1][0]!));
    }
    if (sortKey === "oldest") {
      const minA = Math.min(...a[1].map((p) => Date.parse(p.createdAt)));
      const minB = Math.min(...b[1].map((p) => Date.parse(p.createdAt)));
      return minA - minB;
    }
    if (sortKey === "newest") {
      const maxA = Math.max(...a[1].map((p) => Date.parse(p.createdAt)));
      const maxB = Math.max(...b[1].map((p) => Date.parse(p.createdAt)));
      return maxB - maxA;
    }
    // urgency (default): group score = max urgencyScore in the group
    const scoreA = Math.max(...a[1].map(urgencyScore));
    const scoreB = Math.max(...b[1].map(urgencyScore));
    return scoreB - scoreA;
  };
  entries.sort(compareByKey);
  return { customerEntries: entries, nonCustomer };
}

export default function AutopilotPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("urgency");

  // Compose-modal edit-and-send state.
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeContext, setComposeContext] = useState<ComposeContext | null>(
    null,
  );
  const [editingProposalId, setEditingProposalId] = useState<string | null>(
    null,
  );

  // Open the full composer pre-filled with a proposal's AI draft. Fetches
  // the customer's primary email (not in the candidate summary) so the To
  // field is seeded.
  const openEditAndSend = async (proposal: Proposal) => {
    const args = (proposal.draftedAction?.args ?? {}) as Record<
      string,
      unknown
    >;
    const subject = typeof args.subject === "string" ? args.subject : "";
    const bodyHtml = typeof args.body === "string" ? args.body : "";
    const customerName =
      (proposal.candidateSummary as { customerName?: string }).customerName ??
      "";

    let customerEmail = "";
    try {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(proposal.entityId)}`,
      );
      if (res.ok) {
        const json = (await res.json()) as {
          customer?: { primaryEmail?: string | null };
        };
        customerEmail = json.customer?.primaryEmail ?? "";
      }
    } catch {
      // Non-fatal — operator can fill the To field manually.
    }

    setEditingProposalId(proposal.id);
    setComposeContext({
      customerId: proposal.entityType === "customer" ? proposal.entityId : undefined,
      customerName,
      customerEmail,
      aiProposalId: proposal.id,
      prefill: { subject, bodyHtml, alias: CHASE_ALIAS },
    });
    setComposeOpen(true);
  };

  const { data, isPending } = useQuery<{ rows: Proposal[] }>({
    queryKey: ["autopilot", "proposals"],
    queryFn: async () => {
      const res = await fetch("/api/autopilot/proposals");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/autopilot/scan", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["autopilot"] }),
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/autopilot/proposals/clear", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ ok: boolean; deleted: number }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autopilot"] });
      setSelected(new Set());
    },
  });

  const draftMutation = useMutation({
    mutationFn: async (proposalIds: string[]) => {
      const res = await fetch("/api/autopilot/proposals/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalIds }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autopilot"] });
      setSelected(new Set());
    },
  });

  const rows = data?.rows ?? [];

  // Per-book split (origin-split-2 §3): origin='tj' proposals get their own
  // amber section; everything else (feldart + NULL book-agnostic ops/cadence)
  // stays in the main Feldart section. Grouping + sort runs per section.
  const { feldart, tj } = useMemo(() => {
    const tjRows = rows.filter((p) => p.origin === "tj");
    const feldartRows = rows.filter((p) => p.origin !== "tj");
    return {
      feldart: groupAndSort(feldartRows, sortKey),
      tj: groupAndSort(tjRows, sortKey),
    };
  }, [rows, sortKey]);
  const feldartCount =
    feldart.customerEntries.reduce((n, [, ps]) => n + ps.length, 0) +
    feldart.nonCustomer.length;
  const tjCount =
    tj.customerEntries.reduce((n, [, ps]) => n + ps.length, 0) +
    tj.nonCustomer.length;

  const pendingCount = rows.filter((r) => r.status === "pending").length;
  const draftedCount = rows.filter((r) => r.status === "drafted").length;

  const toggleSelected = (id: string, yes: boolean) => {
    const next = new Set(selected);
    if (yes) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setSelected(next);
  };

  // One book section's contents: per-customer cards (sorted by the active
  // key) followed by an Operational card for non-customer proposals. Shared
  // by both the Feldart and TJ sections.
  const renderSectionBody = ({
    customerEntries,
    nonCustomer,
  }: ReturnType<typeof groupAndSort>) => (
    <>
      {customerEntries.map(([custId, props]) => {
        const name =
          (props[0]!.candidateSummary as { customerName?: string })
            .customerName ?? custId;
        return (
          <Card key={custId}>
            <CardHeader>
              <div>
                <h3 className="text-sm font-medium">{name}</h3>
                <p className="text-xs text-muted">
                  {props.map((p) => categoryLabel(p.category)).join(" · ")}
                </p>
              </div>
            </CardHeader>
            <CardBody className="space-y-2">
              {props.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  selected={selected.has(p.id)}
                  onSelect={(yes) => toggleSelected(p.id, yes)}
                  onEditAndSend={openEditAndSend}
                />
              ))}
            </CardBody>
          </Card>
        );
      })}
      {nonCustomer.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-medium">Operational</h3>
          </CardHeader>
          <CardBody className="space-y-2">
            {nonCustomer.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                selected={selected.has(p.id)}
                onSelect={(yes) => toggleSelected(p.id, yes)}
                onEditAndSend={openEditAndSend}
              />
            ))}
          </CardBody>
        </Card>
      )}
    </>
  );

  const selectedAiCount = Array.from(selected)
    .map((id) => rows.find((r) => r.id === id))
    .filter(
      (p): p is Proposal =>
        !!p && p.status === "pending" && !NO_DRAFT_CATEGORIES.has(p.category),
    ).length;
  const estimatedCost = (selectedAiCount * ESTIMATED_DRAFT_COST_USD).toFixed(2);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Autopilot</h1>
          <p className="text-sm text-secondary">
            {pendingCount} pending · {draftedCount} drafted
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-secondary">
            Sort
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-8 rounded-md border border-default bg-base px-2 text-xs text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
            >
              <option value="urgency">Most urgent</option>
              <option value="name">Customer name</option>
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
            </select>
          </label>
          <Button
            variant="secondary"
            onClick={() => {
              if (
                window.confirm(
                  "Clear all current autopilot suggestions? Executed (already-sent) ones are kept. A fresh scan will repopulate.",
                )
              ) {
                clearMutation.mutate();
              }
            }}
            loading={clearMutation.isPending}
          >
            Clear suggestions
          </Button>
          <Button
            variant="primary"
            onClick={() => scanMutation.mutate()}
            loading={scanMutation.isPending}
          >
            <RefreshCw className="size-3.5" /> Run autopilot now
          </Button>
        </div>
      </div>

      {selected.size > 0 && (
        <Card className="border-accent-info/40 bg-accent-info/5">
          <CardBody className="flex items-center justify-between gap-2">
            <span className="text-sm">
              {selected.size} selected
              {selectedAiCount > 0
                ? ` · ${selectedAiCount} need AI draft (~$${estimatedCost})`
                : ""}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
              {selectedAiCount > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => draftMutation.mutate(Array.from(selected))}
                  loading={draftMutation.isPending}
                >
                  Draft for selected (~${estimatedCost})
                </Button>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {isPending ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <Card>
          <CardBody>
            <div className="text-sm text-muted">
              No pending proposals. Run a scan or check back later — autopilot
              runs every 4 hours.
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* ── Feldart section: feldart + book-agnostic proposals ────── */}
          {feldartCount > 0 && (
            <section className="rounded-lg border border-default bg-subtle shadow-sm">
              <BookSectionHeader
                book="feldart"
                title="Feldart"
                kpis={
                  <KpiChip>
                    {feldartCount} proposal{feldartCount === 1 ? "" : "s"}
                  </KpiChip>
                }
              />
              <div className="space-y-3 px-4 py-3">
                {renderSectionBody(feldart)}
              </div>
            </section>
          )}

          {/* ── TJ section: hidden entirely when no TJ proposals ──────── */}
          {tjCount > 0 && (
            <section className="rounded-lg border border-accent-warning/30 bg-accent-warning/[0.04] shadow-sm">
              <BookSectionHeader
                book="tj"
                title="Torah Judaica"
                kpis={
                  <KpiChip tone="warning">
                    {tjCount} proposal{tjCount === 1 ? "" : "s"}
                  </KpiChip>
                }
              />
              <div className="space-y-3 px-4 py-3">
                {renderSectionBody(tj)}
              </div>
            </section>
          )}
        </>
      )}

      {composeContext && (
        <ComposeModal
          open={composeOpen}
          onOpenChange={(o) => {
            setComposeOpen(o);
            if (!o) {
              setComposeContext(null);
              setEditingProposalId(null);
            }
          }}
          context={composeContext}
          onSent={async () => {
            // Composer already sent the email via /api/send. Close out the
            // proposal (marks executed + writes chase_log for dedup).
            if (editingProposalId) {
              await fetch(
                `/api/autopilot/proposals/${encodeURIComponent(editingProposalId)}/mark-executed`,
                { method: "POST" },
              ).catch(() => {});
              queryClient.invalidateQueries({ queryKey: ["autopilot"] });
            }
          }}
        />
      )}
    </div>
  );
}
