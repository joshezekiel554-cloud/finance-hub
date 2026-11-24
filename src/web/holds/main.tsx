// Hold Orders SPA entry (holdorders.feldart.com). Second Vite page next to
// finance's index.html; shares the ui/ primitives + Tailwind tokens.
// Dev: http://localhost:5173/holds.html (Vite proxies /api to :3001).

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HoldsApp from "./App";
import "../styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: true, retry: 1 } },
});

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <HoldsApp />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
