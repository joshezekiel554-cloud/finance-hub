// /agent — the deep-work surface (spec §6): conversation list + the
// docked chat (the overlay hides on this route; same store, same
// conversation). Reports library, memory browser and spend dashboard
// join this page in Wave C.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Sparkles, Trash2 } from "lucide-react";
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
    </div>
  );
}
