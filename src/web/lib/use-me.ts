import { useQuery } from "@tanstack/react-query";

// Current signed-in user, from GET /api/me. Includes the server-derived
// `isAdmin` flag (ADMIN_EMAILS) — the canonical client-side admin signal used
// to show/hide admin-only nav + gate the Team Activity page.

export type Me = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  isAdmin: boolean;
};

type MeResponse = { user: Me };

export function useMe() {
  return useQuery<Me>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`GET /api/me failed: ${res.status}`);
      const data = (await res.json()) as MeResponse;
      return data.user;
    },
    // Identity is stable for a session — cache hard, don't refetch on focus.
    staleTime: 5 * 60_000,
  });
}
