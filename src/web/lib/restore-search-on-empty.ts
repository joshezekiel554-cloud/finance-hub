// src/web/lib/restore-search-on-empty.ts
//
// beforeLoad factory. If URL has search params → no-op (URL wins).
// If URL is empty AND storage has saved state for this user/route →
// redirect with the stored state. Component never sees the empty URL.

import { redirect } from "@tanstack/react-router";
import { readFilterStorage } from "./filter-storage";

// Mirrors the actual /api/me response shape — wrapped in `user`, not flat.
type MeResponse = { user: { id: string } };

// Reads the current user from the same query cache the rest of the app
// uses so we don't introduce a new auth dependency. The `me` query is
// populated at app boot in App.tsx.
function getCurrentUserId(): string | null {
  // Imported lazily to avoid a circular dep with the router setup.
  // queryClient is the same singleton used app-wide.
  const win = window as unknown as {
    __FH_QUERY_CLIENT__?: {
      getQueryData: (key: readonly unknown[]) => MeResponse | undefined;
    };
  };
  const qc = win.__FH_QUERY_CLIENT__;
  if (!qc) return null;
  const me = qc.getQueryData(["me"]);
  return me?.user?.id ?? null;
}

export function restoreSearchOnEmpty(routePath: string) {
  return ({ search }: { search: Record<string, unknown> }) => {
    const hasParams = Object.keys(search).length > 0;
    if (hasParams) return;
    const userId = getCurrentUserId();
    if (!userId) return;
    const stored = readFilterStorage(userId, routePath);
    if (!stored || Object.keys(stored).length === 0) return;
    throw redirect({
      to: routePath,
      search: stored,
      replace: true,
    });
  };
}
