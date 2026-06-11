// /agent — the deep-work surface (spec §6): conversation list + the
// docked chat (the overlay hides on this route; same store, same
// conversation). Reports library, memory browser and spend dashboard
// join this page in Wave C.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, MessageSquarePlus, Sparkles, Trash2 } from "lucide-react";
import { cn } from "../lib/cn.js";
import { AgentChat } from "../agent/agent-chat.js";
import { useAgent } from "../agent/agent-store.js";

type ConversationRow = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export default function AgentPage() {
  const queryClient = useQueryClient();
  const { activeConversationId, setActiveConversationId } = useAgent();

  const { data } = useQuery({
    queryKey: ["agent", "conversations"],
    queryFn: async (): Promise<{ conversations: ConversationRow[] }> => {
      const res = await fetch("/api/agent/conversations");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/agent/conversations/${id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: (_d, id) => {
      if (activeConversationId === id) setActiveConversationId(null);
      void queryClient.invalidateQueries({
        queryKey: ["agent", "conversations"],
      });
    },
  });

  const conversations = data?.conversations ?? [];

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-0 gap-4">
      <aside className="hidden w-64 shrink-0 flex-col rounded-lg border border-default bg-base md:flex">
        <div className="border-b border-default p-2">
          <button
            type="button"
            onClick={() => setActiveConversationId(null)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-strong px-3 py-1.5 text-sm font-medium hover:bg-subtle"
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden />
            New chat
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {conversations.length === 0 && (
            <p className="p-3 text-sm text-muted">No conversations yet.</p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5",
                c.id === activeConversationId
                  ? "bg-elevated"
                  : "hover:bg-subtle",
              )}
            >
              <button
                type="button"
                onClick={() => setActiveConversationId(c.id)}
                className="min-w-0 flex-1 truncate text-left text-sm"
                title={c.title}
              >
                {c.title}
              </button>
              <button
                type="button"
                onClick={() => archiveMutation.mutate(c.id)}
                className="invisible rounded p-1 text-muted hover:text-accent-danger group-hover:visible"
                title="Archive conversation"
                aria-label={`Archive ${c.title}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-default bg-base">
        <header className="flex items-center gap-2 border-b border-default px-4 py-2">
          <Sparkles className="h-4 w-4 text-accent-primary" aria-hidden />
          <h1 className="text-sm font-semibold">
            {conversations.find((c) => c.id === activeConversationId)?.title ??
              "New conversation"}
          </h1>
        </header>
        <div className="min-h-0 flex-1">
          <AgentChat conversationId={activeConversationId} autoFocus />
        </div>
      </section>

      <aside className="hidden w-72 shrink-0 flex-col gap-4 xl:flex">
        <SpendCard />
        <ReportsCard />
      </aside>
    </div>
  );
}

function SpendCard() {
  const { data } = useQuery({
    queryKey: ["agent", "spend"],
    queryFn: async () => {
      const res = await fetch("/api/agent/spend");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        spentUsd: number;
        budgetUsd: number;
        pct: number;
        bySurface: Array<{ surface: string; costUsd: number; calls: number }>;
      }>;
    },
    staleTime: 60_000,
  });
  if (!data) return null;
  const pct = Math.min(100, Math.round(data.pct));
  return (
    <div className="rounded-lg border border-default bg-base p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
        AI spend this month
      </h2>
      <p className="mt-1 text-lg font-semibold">
        ${data.spentUsd.toFixed(2)}
        <span className="text-xs font-normal text-muted">
          {" "}/ ${data.budgetUsd.toFixed(0)} budget
        </span>
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-elevated">
        <div
          className={
            pct >= 100
              ? "h-full bg-accent-danger"
              : pct >= 80
                ? "h-full bg-accent-warning"
                : "h-full bg-accent-success"
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="mt-2 space-y-0.5 text-xs text-secondary">
        {data.bySurface
          .slice()
          .sort((a, b) => b.costUsd - a.costUsd)
          .slice(0, 5)
          .map((r) => (
            <li key={r.surface} className="flex justify-between">
              <span>{r.surface.replace(/_/g, " ")}</span>
              <span>${r.costUsd.toFixed(2)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

function ReportsCard() {
  const { data } = useQuery({
    queryKey: ["agent", "reports"],
    queryFn: async () => {
      const res = await fetch("/api/agent/reports");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        reports: Array<{
          id: string;
          title: string;
          kind: string;
          createdAt: string;
        }>;
      }>;
    },
    staleTime: 30_000,
  });
  const reports = data?.reports ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-default bg-base p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
        Reports library
      </h2>
      {reports.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          Ask the agent for a PDF report or CSV export and it lands here.
        </p>
      )}
      <ul className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
        {reports.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-xs">
            <FileText className="h-3.5 w-3.5 shrink-0 text-accent-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={r.title}>
              {r.title}
            </span>
            <span className="uppercase text-muted">{r.kind}</span>
            <a
              href={`/api/agent/reports/${r.id}/download`}
              className="rounded p-1 text-muted hover:bg-subtle hover:text-primary"
              title="Download"
              aria-label={`Download ${r.title}`}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
