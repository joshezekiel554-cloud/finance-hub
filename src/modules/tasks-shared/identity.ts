// Cross-app identity map (finance user ↔ inbox TeamMember).
//
// The hinge of the shared-tasks feature. Join key = email, LOWERCASED. A finance
// user's email is matched against an inbox member's `email` OR `googleEmail`
// (both — a member's googleEmail can be blank; see members.ts).
//
// Design: a PURE core (takes the member list as input → unit-testable with no
// network) plus thin wrappers that pull from the cached roster (members.ts).

import {
  listMembers,
  type InboxMember,
} from "../../integrations/inbox/members.js";

/** Minimal finance-user shape this module needs (Auth.js `user` row subset). */
export type FinanceUserLike = { email: string };

/**
 * Thrown when a finance user has no matching inbox TeamMember. Finance surfaces
 * this as a clear "you need an inbox account" message (the same dual-app account
 * requirement as sign-in).
 */
export class NoInboxAccountError extends Error {
  email: string;
  constructor(email: string) {
    super(
      `No inbox account for ${email} — ask an admin to add you in inbox → Members.`,
    );
    this.name = "NoInboxAccountError";
    this.email = email;
  }
}

function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** True when `email` matches the member's email OR (non-blank) googleEmail, case-insensitively. */
function memberMatchesEmail(member: InboxMember, email: string): boolean {
  const needle = lc(email);
  if (!needle) return false;
  const memberEmail = lc(member.email);
  const memberGoogle = lc(member.googleEmail);
  return memberEmail === needle || (memberGoogle !== "" && memberGoogle === needle);
}

// --- Pure core (no network) --------------------------------------------------

/**
 * Pure: find the inbox member matching a finance user, given the roster.
 * Returns null on no match.
 */
export function financeUserToMemberFrom(
  members: InboxMember[],
  user: FinanceUserLike,
): InboxMember | null {
  return members.find((m) => memberMatchesEmail(m, user.email)) ?? null;
}

/**
 * Pure: reverse direction — given an actor email (e.g. carried on a board
 * action), find the inbox member. Used for audit attribution. Returns null on
 * no match.
 */
export function findMemberForActorEmailFrom(
  members: InboxMember[],
  email: string,
): InboxMember | null {
  return members.find((m) => memberMatchesEmail(m, email)) ?? null;
}

// --- Cache-backed wrappers ---------------------------------------------------

/** Resolve a finance user to its inbox member via the cached roster, or null. */
export async function financeUserToMember(
  user: FinanceUserLike,
): Promise<InboxMember | null> {
  const members = await listMembers();
  return financeUserToMemberFrom(members, user);
}

/**
 * Resolve an actor email (reverse direction, for audit attribution) to its
 * inbox member via the cached roster, or null.
 */
export async function findMemberForActorEmail(
  email: string,
): Promise<InboxMember | null> {
  const members = await listMembers();
  return findMemberForActorEmailFrom(members, email);
}

/**
 * Resolve a finance user to its inbox member, throwing NoInboxAccountError when
 * there is no match. Finance call sites use this to gate task create/assign.
 */
export async function requireMemberForUser(
  user: FinanceUserLike,
): Promise<InboxMember> {
  const member = await financeUserToMember(user);
  if (!member) throw new NoInboxAccountError(user.email);
  return member;
}
