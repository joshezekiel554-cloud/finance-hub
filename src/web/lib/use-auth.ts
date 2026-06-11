// Current-user hook. The Auth.js session endpoint only exposes email;
// per-user agent threads need the user id, so this hits the agent's
// /me endpoint once and caches for the page lifetime.

import { useQuery } from "@tanstack/react-query";

export type CurrentUser = { id: string; email: string; name: string | null };

export function useAuth(): CurrentUser | null {
  const { data } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async (): Promise<CurrentUser> => {
      const res = await fetch("/api/agent/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: Infinity,
    retry: 1,
  });
  return data ?? null;
}
