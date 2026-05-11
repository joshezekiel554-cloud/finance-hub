// src/web/lib/use-filter-persistence.ts
//
// Subscribes to the route's useSearch() and writes to localStorage so the
// next nav-click to this route restores the same filters.
//
// Writes synchronously on every change rather than debouncing — earlier
// versions used a 200ms timeout, but the cleanup canceled pending writes
// when the user navigated away inside that window, silently losing the
// last filter change. localStorage.setItem is sub-millisecond; debouncing
// here was premature optimization that traded correctness for nothing.

import { useEffect } from "react";
import { useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { writeFilterStorage } from "./filter-storage";

// Mirrors the actual /api/me response shape — wrapped in `user`, not flat.
type MeResponse = { user: { id: string } };

export function useFilterPersistence(routePath: string): void {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  // Fetch the `me` query if no other page has — React Query dedupes by
  // queryKey, so this is cheap when the cache is already warm. We need
  // the user id to scope the storage key. Long staleTime so we don't
  // re-fire on every page navigation.
  const meQuery = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 60_000,
  });
  const userId = meQuery.data?.user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    writeFilterStorage(userId, routePath, search);
  }, [userId, routePath, search]);
}
