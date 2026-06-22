// Inbox TeamMember roster — the cross-app identity source.
//
// Finance does NOT store a duplicate member↔user mapping; it resolves live by
// fetching inbox's `GET /api/svc/members` and caching ~5 min (same pattern as
// the Gmail alias cache in integrations/gmail/aliases.ts). The pure email→member
// matching logic lives in modules/tasks-shared/identity.ts; this module only
// owns the fetch + cache + simple lookups.

import { createLogger } from "../../lib/logger.js";
import { inboxFetch } from "./client.js";

const log = createLogger({ component: "inbox.members" });

/** A single inbox TeamMember as returned by `GET /api/svc/members`. */
export type InboxMember = {
  teamMemberId: string;
  name: string;
  email: string;
  // A member's googleEmail can be blank (onboarding gotcha 2026-06-22: Hillel's
  // was empty, login == email). May arrive as "" or null — normalize to "".
  googleEmail: string;
  role: string;
  active: boolean;
};

type MembersResponse = { members: InboxMember[] };

// 5-minute TTL: the roster changes rarely (admin adds a member in inbox) but we
// don't want to hit the service on every task action / assignee-picker open.
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  members: InboxMember[];
  fetchedAt: number;
};

let cache: CacheEntry | undefined;

/** Drop the cached roster (tests / forced refresh). */
export function clearMembersCache(): void {
  cache = undefined;
}

function normalize(raw: InboxMember): InboxMember {
  return {
    teamMemberId: raw.teamMemberId,
    name: raw.name,
    email: (raw.email ?? "").trim(),
    // Tolerate "" | null | undefined from the wire.
    googleEmail: (raw.googleEmail ?? "").trim(),
    role: raw.role,
    active: Boolean(raw.active),
  };
}

/**
 * Fetch the inbox member roster, served from the 5-min cache when warm.
 * Pass `force` to bypass the cache.
 */
export async function listMembers(force = false): Promise<InboxMember[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.members;
  }

  const res = await inboxFetch<MembersResponse>("/api/svc/members");
  const members = (res.members ?? []).map(normalize);
  cache = { members, fetchedAt: Date.now() };
  log.info({ count: members.length }, "fetched inbox members");
  return members;
}

/**
 * Resolve a member by email — matches against BOTH `email` and `googleEmail`
 * (lowercased), since a member's googleEmail may be blank. Returns null when no
 * member matches the (non-empty) email.
 */
export async function resolveMemberByEmail(
  email: string,
): Promise<InboxMember | null> {
  const needle = email.trim().toLowerCase();
  if (!needle) return null;
  const members = await listMembers();
  return (
    members.find(
      (m) =>
        m.email.toLowerCase() === needle ||
        (m.googleEmail !== "" && m.googleEmail.toLowerCase() === needle),
    ) ?? null
  );
}

/** Resolve a member by stable teamMemberId. Returns null when not found. */
export async function resolveMemberById(
  teamMemberId: string,
): Promise<InboxMember | null> {
  const members = await listMembers();
  return members.find((m) => m.teamMemberId === teamMemberId) ?? null;
}
