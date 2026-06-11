// Agent UI state, mounted at the App shell (inside the router, outside
// the route outlet) so the panel + active conversation survive page
// navigation (spec §6). The /agent page docks the same conversation;
// everything routes through this store.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

export type AgentPageContext = {
  page: string;
  customerId?: string;
  customerName?: string;
};

type AgentStore = {
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  // True between sending a message and the agent.complete event.
  busy: boolean;
  setBusy: (b: boolean) => void;
  pageContext: AgentPageContext;
  // The /agent page docks the conversation; the overlay hides there.
  onAgentPage: boolean;
};

const AgentContext = createContext<AgentStore | null>(null);

export function useAgent(): AgentStore {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent outside AgentProvider");
  return ctx;
}

// Derive the context chip's subject from the current route. Customer
// pages resolve the display name from the query cache when present —
// best-effort, the id alone is still useful to the agent.
function useDerivedPageContext(): AgentPageContext {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();
  return useMemo(() => {
    const m = pathname.match(/^\/customers\/([^/]+)/);
    if (m) {
      const customerId = m[1]!;
      const cached = queryClient.getQueryData<{
        customer?: { displayName?: string };
      }>(["customer", customerId]);
      return {
        page: pathname,
        customerId,
        customerName: cached?.customer?.displayName,
      };
    }
    return { page: pathname };
  }, [pathname, queryClient]);
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const pageContext = useDerivedPageContext();
  const onAgentPage = pageContext.page === "/agent";

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const togglePanel = useCallback(() => setPanelOpen((v) => !v), []);

  // Global hotkey: Ctrl/Cmd+K toggles the panel (Esc handled in-panel).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPanelOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo(
    () => ({
      panelOpen,
      openPanel,
      closePanel,
      togglePanel,
      activeConversationId,
      setActiveConversationId,
      busy,
      setBusy,
      pageContext,
      onAgentPage,
    }),
    [
      panelOpen,
      openPanel,
      closePanel,
      togglePanel,
      activeConversationId,
      busy,
      pageContext,
      onAgentPage,
    ],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
