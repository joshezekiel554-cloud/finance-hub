// src/web/lib/use-filter-navigate.ts
//
// Write-side hook for URL-state filters. Wraps the merge-prev-and-navigate
// dance with sensible push-vs-replace defaults:
//   - Default replace=true so typing in a search box doesn't pollute history
//   - Pass { history: "push" } for toggles, tab changes, pagination

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

type SetFilterOptions = { history?: "push" | "replace" };

export function useFilterNavigate<TSearch extends Record<string, unknown>>(
  routeId: string,
) {
  const navigate = useNavigate({ from: routeId } as Parameters<typeof useNavigate>[0]);

  const setFilter = useCallback(
    <K extends keyof TSearch>(
      keyName: K,
      value: TSearch[K] | undefined,
      opts: SetFilterOptions = {},
    ) => {
      navigate({
        search: (prev: TSearch) => ({ ...prev, [keyName]: value }),
        replace: opts.history !== "push",
      } as Parameters<typeof navigate>[0]);
    },
    [navigate],
  );

  const setFilters = useCallback(
    (patch: Partial<TSearch>, opts: SetFilterOptions = {}) => {
      navigate({
        search: (prev: TSearch) => ({ ...prev, ...patch }),
        replace: opts.history !== "push",
      } as Parameters<typeof navigate>[0]);
    },
    [navigate],
  );

  const resetFilters = useCallback(() => {
    navigate({
      search: {} as unknown as TSearch,
      replace: false,
    } as unknown as Parameters<typeof navigate>[0]);
  }, [navigate]);

  return useMemo(
    () => ({ setFilter, setFilters, resetFilters }),
    [setFilter, setFilters, resetFilters],
  );
}
