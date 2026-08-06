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
  // Computed by inbox from the same `isStaffRole` its proxy gates on (added
  // 2026-08-06). Optional so an older inbox deploy still parses — when absent
  // we fall back to reading `role` ourselves.
  staff?: boolean;
  active: boolean;
};

type MembersResponse = { members: InboxMember[] };

// Inbox roles that mean "Feldart staff". Anything else — today GUEST, the
// external designer added 2026-08-06 — is an outside collaborator who happens to
// live on the same roster. Finance surfaces (assignee picker, Team Activity
// subjects) must enumerate staff only: a finance task title carries a customer
// name and balance, and assigning one cross-lists it onto the assignee's board.
const STAFF_ROLES = new Set(["ADMIN", "MEMBER"]);

/**
 * True only for a recognised staff role. Fails CLOSED: an unknown or missing
 * role is NOT staff, so a role added in inbox drops out of finance's pickers
 * (visible, harmless) rather than silently gaining a finance-side surface.
 */
export function isStaffMemberRole(role: string | null | undefined): boolean {
  return STAFF_ROLES.has((role ?? "").toUpperCase());
}

/**
 * True when this member is Feldart staff. Prefers inbox's own `staff` flag —
 * it is computed by the same `isStaffRole` the inbox proxy gates on, so we
 * don't re-derive their role semantics — and falls back to reading the role
 * when an older inbox deploy omits the field.
 */
export function isStaffMember(member: Pick<InboxMember, "role" | "staff">): boolean {
  return member.staff ?? isStaffMemberRole(member.role);
}

/** The roster trimmed to staff — the correct source for anything finance-side. */
export async function listStaffMembers(force = false): Promise<InboxMember[]> {
  const members = await listMembers(force);
  const staff = members.filter(isStaffMember);
  if (staff.length !== members.length) {
    log.debug(
      { total: members.length, staff: staff.length },
      "non-staff inbox members excluded from finance surface",
    );
  }
  return staff;
}

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
    // Left undefined (not coerced to false) when absent, so isStaffMember can
    // tell "inbox says not staff" from "this deploy doesn't send the field".
    staff: typeof raw.staff === "boolean" ? raw.staff : undefined,
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
