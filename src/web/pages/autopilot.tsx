import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  ProposalCard,
  type Proposal,
} from "../components/autopilot/proposal-card";

// Categories that don't need an AI draft step.
const NO_DRAFT_CATEGORIES = new Set([
  "cadence_statement",
  "ops_cron_fail",
]);

// Rough estimate per AI draft, in USD. Refined from real cost-tracker data
// in a follow-up.
const ESTIMATED_DRAFT_COST_USD = 0.05;

export default function AutopilotPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  // Group customer-typed proposals by entityId; non-customer kept separate.
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

  const pendingCount = rows.filter((r) => r.status === "pending").length;
  const draftedCount = rows.filter((r) => r.status === "drafted").length;

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
        <Button
          variant="primary"
          onClick={() => scanMutation.mutate()}
          loading={scanMutation.isPending}
        >
          <RefreshCw className="size-3.5" /> Run autopilot now
        </Button>
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
          {Array.from(byCustomer.entries()).map(([custId, props]) => {
            const customerName =
              (props[0]!.candidateSummary as { customerName?: string })
                .customerName ?? custId;
            return (
              <Card key={custId}>
                <CardHeader>
                  <div>
                    <h2 className="text-sm font-medium">{customerName}</h2>
                    <p className="text-xs text-muted">
                      {props
                        .map((p) => p.category.replace(/_/g, " "))
                        .join(" · ")}
                    </p>
                  </div>
                </CardHeader>
                <CardBody className="space-y-2">
                  {props.map((p) => (
                    <ProposalCard
                      key={p.id}
                      proposal={p}
                      selected={selected.has(p.id)}
                      onSelect={(yes) => {
                        const next = new Set(selected);
                        if (yes) {
                          next.add(p.id);
                        } else {
                          next.delete(p.id);
                        }
                        setSelected(next);
                      }}
                    />
                  ))}
                </CardBody>
              </Card>
            );
          })}
          {nonCustomer.length > 0 && (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-medium">Operational</h2>
              </CardHeader>
              <CardBody className="space-y-2">
                {nonCustomer.map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    selected={selected.has(p.id)}
                    onSelect={(yes) => {
                      const next = new Set(selected);
                      if (yes) {
                        next.add(p.id);
                      } else {
                        next.delete(p.id);
                      }
                      setSelected(next);
                    }}
                  />
                ))}
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
