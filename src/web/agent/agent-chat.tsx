// The chat surface shared by the overlay panel and the /agent page:
// message history, live tool chips, input box, turn lifecycle. One
// component, two viewports (spec §6).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send, Sparkles, Wrench } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useEventStream } from "../lib/use-event-stream.js";
import { useAgent } from "./agent-store.js";

type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "tool_event";
  content: Record<string, unknown>;
  createdAt: string;
};

type ConversationResponse = {
  conversation: {
    id: string;
    title: string;
    turnInFlight: boolean;
  };
  messages: AgentMessage[];
};

function conversationKey(id: string) {
  return ["agent", "conversation", id] as const;
}

function ToolChip({ content }: { content: Record<string, unknown> }) {
  const tool = String(content.tool ?? "tool");
  const okFlag = content.ok !== false;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-default bg-elevated px-2 py-0.5 text-[11px] text-secondary",
        !okFlag && "border-accent-danger/40 text-accent-danger",
      )}
      title={okFlag ? "tool call" : "tool call failed"}
    >
      <Wrench className="h-3 w-3" aria-hidden />
      {tool}
    </span>
  );
}

function MessageBubble({ message }: { message: AgentMessage }) {
  if (message.role === "tool_event") {
    return (
      <div className="my-1">
        <ToolChip content={message.content} />
      </div>
    );
  }
  const text = String(message.content.text ?? "");
  const isUser = message.role === "user";
  const isError = message.content.error === true;
  return (
    <div
      className={cn(
        "max-w-[88%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed",
        isUser
          ? "ml-auto bg-accent-primary/10"
          : "border border-default bg-subtle",
        isError && "border-accent-danger/40 bg-accent-danger/5",
      )}
    >
      {text}
    </div>
  );
}

export function AgentChat({
  conversationId,
  autoFocus,
}: {
  conversationId: string | null;
  autoFocus?: boolean;
}) {
  const queryClient = useQueryClient();
  const { busy, setBusy, pageContext, setActiveConversationId } = useAgent();
  const [draft, setDraft] = useState("");
  const [turnError, setTurnError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { data, isPending } = useQuery({
    queryKey: conversationKey(conversationId ?? "none"),
    queryFn: async (): Promise<ConversationResponse> => {
      const res = await fetch(`/api/agent/conversations/${conversationId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: conversationId !== null,
  });

  // Live updates: any agent event for this conversation refreshes the
  // message list (tool chips + assistant text are persisted rows, so
  // invalidation is the single source of truth — no transient state to
  // drift).
  const invalidate = useCallback(() => {
    if (conversationId) {
      void queryClient.invalidateQueries({
        queryKey: conversationKey(conversationId),
      });
    }
  }, [conversationId, queryClient]);

  useEventStream("agent.tool", (e) => {
    if (e.conversationId === conversationId) invalidate();
  });
  useEventStream("agent.assistant", (e) => {
    if (e.conversationId === conversationId) invalidate();
  });
  useEventStream("agent.complete", (e) => {
    if (e.conversationId !== conversationId) return;
    setBusy(false);
    if (e.error) setTurnError(e.error);
    invalidate();
  });

  // Resume state on mount/refresh: server knows if a turn is running.
  useEffect(() => {
    if (data?.conversation.turnInFlight) setBusy(true);
  }, [data?.conversation.turnInFlight, setBusy]);

  // Pin to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data?.messages.length, busy]);

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      let id = conversationId;
      if (!id) {
        const created = await fetch("/api/agent/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!created.ok) throw new Error(`HTTP ${created.status}`);
        id = ((await created.json()) as { id: string }).id;
        setActiveConversationId(id);
      }
      const res = await fetch(`/api/agent/conversations/${id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, pageContext }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return id;
    },
    onMutate: () => {
      setTurnError(null);
      setBusy(true);
    },
    onSuccess: (id) => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: conversationKey(id) });
      void queryClient.invalidateQueries({
        queryKey: ["agent", "conversations"],
      });
    },
    onError: (err) => {
      setBusy(false);
      setTurnError(err instanceof Error ? err.message : "send failed");
    },
  });

  const messages = useMemo(() => data?.messages ?? [], [data?.messages]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    sendMutation.mutate(text);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="flex-1 space-y-2 overflow-y-auto p-3"
        aria-live="polite"
      >
        {conversationId === null && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <Sparkles className="h-6 w-6 text-accent-primary" aria-hidden />
            <p>
              Ask about any customer, balance, email thread or return — or
              tell me what to get done.
            </p>
          </div>
        )}
        {isPending && conversationId !== null && (
          <p className="text-sm text-muted">Loading conversation…</p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            working…
          </div>
        )}
        {turnError && (
          <p className="text-sm text-accent-danger">{turnError}</p>
        )}
      </div>
      <form
        onSubmit={onSubmit}
        className="flex items-end gap-2 border-t border-default p-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e);
            }
          }}
          rows={Math.min(4, Math.max(1, draft.split("\n").length))}
          placeholder="Message the agent…"
          autoFocus={autoFocus}
          className="flex-1 resize-none rounded-lg border border-strong bg-base px-3 py-2 text-sm outline-none focus:border-accent-primary"
          aria-label="Message the agent"
        />
        <button
          type="submit"
          disabled={busy || draft.trim().length === 0}
          className="inline-flex h-9 items-center gap-1 rounded-lg bg-accent-primary px-3 text-sm font-medium text-white disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden />
          Send
        </button>
      </form>
    </div>
  );
}
