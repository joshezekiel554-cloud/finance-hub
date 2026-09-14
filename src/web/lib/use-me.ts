import { useQuery } from "@tanstack/react-query";
import { isHubEmbedded, postHubUnauthenticated } from "./hub-embed";

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

export type MeResponse = { user: Me };

export function useMe() {
  // The ["me"] cache holds the WRAPPED { user } shape — shared with UserPill,
  // useFilterPersistence and the invoice-reminder dialog, all of which cache +
  // read `data.user`. We must cache the SAME wrapped shape (caching the
  // unwrapped user here collided on the key and crashed those consumers). A
  // `select` unwraps it for our callers without touching the cache.
  return useQuery<MeResponse, Error, Me>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      // Framed by the hub and our session is gone: ask the hub to re-mint a
      // handoff token instead of showing finance's own login inside the frame.
      if (res.status === 401 && isHubEmbedded()) postHubUnauthenticated();
      if (!res.ok) throw new Error(`GET /api/me failed: ${res.status}`);
      return (await res.json()) as MeResponse;
    },
    select: (data) => data.user,
    // Identity is stable for a session — cache hard, don't refetch on focus.
    staleTime: 5 * 60_000,
  });
}
