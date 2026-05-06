// src/web/lib/use-filter-persistence.ts
//
// Subscribes to the route's useSearch() and debounce-writes to localStorage
// so the next nav-click to this route restores the same filters.

import { useEffect } from "react";
import { useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { writeFilterStorage } from "./filter-storage";

type Me = { id: string };

export function useFilterPersistence(routePath: string): void {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const meQuery = useQuery<Me>({ queryKey: ["me"], enabled: false });
  const userId = meQuery.data?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const handle = setTimeout(() => {
      writeFilterStorage(userId, routePath, search);
    }, 200);
    return () => clearTimeout(handle);
  }, [userId, routePath, search]);
}
