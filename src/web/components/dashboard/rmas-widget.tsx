import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type RmaRow = {
  id: string;
  rmaNumber: string | null;
  status: string;
  totalValue: string;
  updatedAt: string;
  customerId: string;
  customerName: string;
};

type AutopilotProposal = {
  id: string;
  category: string;
  status: "pending" | "drafted" | "approved" | "rejected";
  rmaNumber: string | null;
  customerName: string;
  stalledState: string;
  stalledDays: number;
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting WH#",
  sent_to_warehouse: "At warehouse",
  received: "Received",
};

export function RmasWidget() {
  const [showAiSuggestions, setShowAiSuggestions] = useState(false);
  const queryClient = useQueryClient();

  const { data, isPending, isError } = useQuery<{ rows: RmaRow[] }>({
    queryKey: ["dashboard", "rmas"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/rmas");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
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
    mutationFn: async (proposalId: string) => {
      const res = await fetch("/api/autopilot/proposals/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalIds: [proposalId] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["autopilot"] }),
  });

  const approveMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await fetch(`/api/autopilot/proposals/${proposalId}/approve`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["autopilot"] }),
  });

  const rows = data?.rows ?? [];
  const aiSuggestions = (proposalsData?.proposals ?? []).filter(
    (p) =>
      (p.status === "pending" || p.status === "drafted") &&
      p.category === "ops_rma_stalled",
  );

  return (
    <Card>
      <CardHeader>
        <WidgetHeader
          title="RMAs in flight"
          count={rows.length}
          link="/returns"
        />
      </CardHeader>
      <CardBody>
        {aiSuggestions.length > 0 && (
          <div className="mb-3">
            <button
              type="button"
              onClick={() => setShowAiSuggestions((v) => !v)}
              className="text-xs text-accent-info hover:underline flex items-center gap-1"
            >
              {aiSuggestions.length} AI suggestion{aiSuggestions.length !== 1 ? "s" : ""}{" "}
              {showAiSuggestions ? "▲" : "▼"}
            </button>
            {showAiSuggestions && (
              <ul className="mt-2 space-y-2">
                {aiSuggestions.map((p) => (
                  <li
                    key={p.id}
                    className="rounded border border-accent-info/30 bg-accent-info/5 px-3 py-2 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-primary truncate">
                          {p.rmaNumber ?? p.id.slice(0, 8)} · {p.customerName}
                        </div>
                        <div className="text-muted mt-0.5">
                          stalled in {p.stalledState} {p.stalledDays}d
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {p.status === "pending" && (
                          <button
                            type="button"
                            disabled={draftMutation.isPending}
                            onClick={() => draftMutation.mutate(p.id)}
                            className="rounded bg-subtle px-2 py-0.5 text-muted hover:text-primary disabled:opacity-50"
                          >
                            Draft
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={approveMutation.isPending}
                          onClick={() => approveMutation.mutate(p.id)}
                          className="rounded bg-accent-info/20 px-2 py-0.5 text-accent-info hover:bg-accent-info/30 disabled:opacity-50"
                        >
                          Approve
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {isPending ? (
          <div className="h-6 rounded bg-subtle animate-pulse" />
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load RMAs.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">No RMAs in flight.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li key={r.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/returns"
                  className="flex items-center justify-between gap-2 text-sm hover:text-accent-info"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-primary truncate">
                      {r.rmaNumber ?? r.id.slice(0, 8)} · {r.customerName}
                    </div>
                  </div>
                  <span className="text-xs rounded bg-subtle px-1.5 py-0.5 text-muted shrink-0">
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
