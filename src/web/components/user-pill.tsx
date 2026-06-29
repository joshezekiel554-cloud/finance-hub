// Top-right user identity pill. Shows initials + email + "Admin" badge
// when the signed-in user is in ADMIN_EMAILS. Sign-out lives in the
// sidebar footer; this is read-only identity at-a-glance.

import { useQuery } from "@tanstack/react-query";
import { cn } from "../lib/cn";

// The ["me"] query is cached in its WRAPPED shape ({ user: {...} }) — every
// consumer (this pill, useFilterPersistence, the invoice-reminder dialog, and
// useMe via a `select`) reads that same wrapped value. Don't cache an unwrapped
// shape under this key or it collides.
type MeResponse = {
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    isAdmin: boolean;
  };
};

function initialsFrom(name: string | null, email: string): string {
  const source = (name ?? email).trim();
  const words = source.split(/[\s@.]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function UserPill() {
  const { data, isPending } = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  if (isPending || !data?.user) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-default bg-subtle px-2.5 py-1 text-xs text-muted">
        <span className="size-6 animate-pulse rounded-full bg-base" />
        <span className="hidden sm:inline">…</span>
      </div>
    );
  }

  const { email, name, image, isAdmin } = data.user;
  const initials = initialsFrom(name, email);
  const label = name?.trim() || email;

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-default bg-subtle py-1 pl-1 pr-3 text-xs"
      title={`${label} <${email}>${isAdmin ? " — admin" : ""}`}
    >
      {image ? (
        <img
          src={image}
          alt=""
          className="size-6 rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="flex size-6 items-center justify-center rounded-full bg-accent-primary/15 text-[10px] font-medium text-accent-primary">
          {initials}
        </span>
      )}
      <span className="hidden max-w-[180px] truncate font-medium text-primary sm:inline">
        {label}
      </span>
      {isAdmin && (
        <span
          className={cn(
            "rounded bg-accent-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-primary",
          )}
        >
          Admin
        </span>
      )}
    </div>
  );
}
