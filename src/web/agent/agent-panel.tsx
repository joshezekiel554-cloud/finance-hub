// The persistent overlay (spec §6): fixed slide-over on desktop,
// full-screen sheet on mobile, mounted at the App shell so it survives
// navigation. Hidden on /agent, where the same conversation docks into
// the page. Fixed positioning keeps it out of the window-scroll content
// div (sticky-header gotcha).

import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Expand, Sparkles, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { AgentChat } from "./agent-chat.js";
import { useAgent } from "./agent-store.js";

export function AgentPanel() {
  const {
    panelOpen,
    closePanel,
    activeConversationId,
    pageContext,
    onAgentPage,
  } = useAgent();

  // Esc closes (matches drawer/dialog conventions).
  useEffect(() => {
    if (!panelOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, closePanel]);

  if (!panelOpen || onAgentPage) return null;

  const subject = pageContext.customerName ?? null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 md:inset-auto md:bottom-0 md:right-0 md:top-0 md:w-[420px]",
      )}
      role="dialog"
      aria-label="AI agent"
    >
      {/* Mobile scrim */}
      <button
        type="button"
        aria-label="Close agent"
        onClick={closePanel}
        className="absolute inset-0 bg-black/30 md:hidden"
      />
      <div className="absolute inset-x-0 bottom-0 top-0 flex flex-col bg-base shadow-lg md:inset-auto md:bottom-0 md:right-0 md:top-0 md:w-[420px] md:border-l md:border-strong">
        <header className="flex items-center gap-2 border-b border-default px-3 py-2">
          <Sparkles className="h-4 w-4 text-accent-primary" aria-hidden />
          <span className="text-sm font-semibold">Agent</span>
          {subject && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-accent-success/10 px-2 py-0.5 text-[11px] font-semibold text-accent-success"
              title={`The agent can see you're viewing ${subject}`}
            >
              ● {subject}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <Link
              to="/agent"
              onClick={closePanel}
              className="rounded p-1 text-muted hover:bg-subtle hover:text-primary"
              title="Open the full agent page"
              aria-label="Expand to the agent page"
            >
              <Expand className="h-4 w-4" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={closePanel}
              className="rounded p-1 text-muted hover:bg-subtle hover:text-primary"
              title="Close (Esc)"
              aria-label="Close agent panel"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </span>
        </header>
        <div className="min-h-0 flex-1">
          <AgentChat conversationId={activeConversationId} autoFocus />
        </div>
      </div>
    </div>
  );
}
