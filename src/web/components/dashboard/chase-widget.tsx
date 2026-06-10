import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Button } from "../ui/button";
import { WidgetHeader } from "./widget-header";

type AutopilotProposal = {
  id: string;
  customerId: string;
  customerName: string;
  tier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: "pending" | "drafted" | "approved" | "rejected" | "sent";
  category: string;
  reason: string;
};

type ChaseRow = {
  customerId: string;
  customerName: string;
  tier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  daysOverdue: number;
  // Per-book overdue (origin-split-2 spec §5) — ranking stays blended
  // server-side but no blended money figure is ever rendered.
  feldartOverdue: number;
  tjOverdue: number;
  oldestUnpaidDate: string | null;
  primaryEmail: string | null;
};

const TIER_STYLES: Record<ChaseRow["tier"], string> = {
  CRITICAL: "bg-accent-danger/15 text-accent-danger",
  HIGH: "bg-accent-warning/15 text-accent-warning",
  MEDIUM: "bg-accent-info/15 text-accent-info",
  LOW: "bg-subtle text-muted",
};

function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function ChaseWidget() {
  const queryClient = useQueryClient();
  const [showAiSuggestions, setShowAiSuggestions] = useState(false);

  const { data, isPending, isError } = useQuery<{ rows: ChaseRow[] }>({
    queryKey: ["dashboard", "chase"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/chase");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const dismissMutation = useMutation({
    mutationFn: async (customerId: string) => {
      const res = await fetch(
        `/api/dashboard/chase/${encodeURIComponent(customerId)}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onMutate: async (customerId: string) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard", "chase"] });
      const prev = queryClient.getQueryData<{ rows: ChaseRow[] }>([
        "dashboard",
        "chase",
      ]);
      if (prev) {
        queryClient.setQueryData(["dashboard", "chase"], {
          rows: prev.rows.filter((r) => r.customerId !== customerId),
        });
      }
      return { prev };
    },
    onError: (_err, _customerId, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(["dashboard", "chase"], ctx.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", "chase"] });
      // Also bust the customer detail caches so the Undismiss badge flips
      // to visible if the operator navigates to a dismissed customer.
      queryClient.invalidateQueries({ queryKey: ["customer"] });
    },
  });

  const { data: proposalsData } = useQuery<{ proposals: AutopilotProposal[] }>({
    queryKey: ["autopilot", "proposals"],
    queryFn: async () => {
      const res = await fetch("/api/autopilot/proposals");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const draftMutation = useMutation({
    mutationFn: async (proposalIds: string[]) => {
      const res = await fetch("/api/autopilot/proposals/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalIds }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["autopilot"] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await fetch(
        `/api/autopilot/proposals/${encodeURIComponent(proposalId)}/approve`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["autopilot"] });
    },
  });

  const aiSuggestions = (proposalsData?.proposals ?? []).filter(
    (p) =>
      (p.status === "pending" || p.status === "drafted") &&
      (p.category === "chase_next" || p.category === "cadence_cold"),
  );

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader
          title="Chase queue"
          count={rows.length}
          link="/chase"
        />
        {aiSuggestions.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAiSuggestions((v) => !v)}
            className="mt-1 flex items-center gap-1 text-xs text-accent-info hover:underline"
          >
            {aiSuggestions.length} AI suggestion{aiSuggestions.length !== 1 ? "s" : ""}
            {showAiSuggestions ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
          </button>
        )}
      </CardHeader>
      <CardBody>
        {showAiSuggestions && aiSuggestions.length > 0 && (
          <div className="mb-3 rounded border border-accent-info/20 bg-accent-info/5 p-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-info">
              AI suggestions
            </div>
            <ul className="divide-y divide-default">
              {aiSuggestions.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0"
                >
                  <span
                    className={`text-[10px] font-semibold rounded px-1.5 py-0.5 shrink-0 ${TIER_STYLES[p.tier]}`}
                  >
                    {p.tier}
                  </span>
                  <Link
                    to="/customers/$customerId"
                    params={{ customerId: p.customerId }}
                    className="flex-1 min-w-0 text-sm hover:text-accent-info"
                  >
                    <div className="font-medium text-primary truncate">{p.customerName}</div>
                    <div className="text-xs text-muted">
                      {p.category === "chase_next" ? "Chase next" : "Cadence cold"}
                    </div>
                  </Link>
                  {p.status === "pending" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => draftMutation.mutate([p.id])}
                      disabled={draftMutation.isPending}
                      className="text-xs"
                    >
                      Draft
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => approveMutation.mutate(p.id)}
                      disabled={approveMutation.isPending}
                      className="text-xs text-accent-info"
                    >
                      Approve &amp; Send
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load chase.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">Nothing to chase.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li
                key={r.customerId}
                className="flex items-center gap-2 py-2 first:pt-0 last:pb-0"
              >
                <span
                  className={`text-[10px] font-semibold rounded px-1.5 py-0.5 shrink-0 ${TIER_STYLES[r.tier]}`}
                >
                  {r.tier}
                </span>
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: r.customerId }}
                  className="flex-1 min-w-0 text-sm hover:text-accent-info"
                >
                  <div className="font-medium text-primary truncate">
                    {r.customerName}
                  </div>
                  <div className="text-xs text-muted">
                    {/* Per-book amounts, color-keyed (indigo Feldart / amber
                        TJ) — never a blended figure. Feldart shown when > 0;
                        a pure-TJ row shows only the TJ part. */}
                    {r.feldartOverdue > 0 && (
                      <span className="font-medium text-accent-primary">
                        {formatMoney(r.feldartOverdue)}
                      </span>
                    )}
                    {r.tjOverdue > 0 && (
                      <span className="font-medium text-accent-warning">
                        {r.feldartOverdue > 0 ? " · " : ""}TJ{" "}
                        {formatMoney(r.tjOverdue)}
                      </span>
                    )}
                    {" · "}
                    {r.daysOverdue}d overdue
                  </div>
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dismissMutation.mutate(r.customerId)}
                  title="Dismiss — permanent until manually undismissed"
                  disabled={dismissMutation.isPending}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
