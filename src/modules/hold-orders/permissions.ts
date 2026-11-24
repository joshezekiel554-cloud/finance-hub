// Hold Orders roles + permissions. PURE (shared by server + SPA).
//
//   admin — ADMIN_EMAILS (Josh, Shaya): everything, incl. editing customer
//           rules and links out to finance's customer pages.
//   holds — HOLDORDERS_EMAILS (sales@): operator decision 2026-11-24 option
//           (b): see every hold, Hold / Release / Pause / Note / record-only /
//           paid-outside-QBO release, and the normal held-order money context
//           (order amount, customer balance/overdue on hold rows). NO rules
//           editing, NO finance pages/APIs (enforced by requireAuth).
//
// Switching what the holds role can do is a one-line change below.

export type HoldsRole = "admin" | "holds";

export type HoldsPermission =
  | "view"
  | "note"
  | "hold"
  | "release"
  | "pause"
  | "recordOnly"
  | "seeBalances"
  | "editRules"
  | "financeLinks";

export type HoldsPermissions = Record<HoldsPermission, boolean>;

export const HOLDS_ROLE_PERMISSIONS: Record<HoldsRole, HoldsPermissions> = {
  admin: {
    view: true,
    note: true,
    hold: true,
    release: true,
    pause: true,
    recordOnly: true,
    seeBalances: true,
    editRules: true,
    financeLinks: true,
  },
  holds: {
    view: true,
    note: true,
    hold: true,
    release: true,
    pause: true,
    recordOnly: true,
    seeBalances: true,
    editRules: false,
    financeLinks: false,
  },
};

function csvHas(csv: string, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  return csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .some((s) => s === wanted);
}

export type HoldsAccessConfig = {
  adminEmails: string;
  holdsEmails: string;
  allowedEmails: string;
};

/** admin beats holds; anyone else has no Hold Orders access. */
export function holdsRoleFor(
  email: string | null | undefined,
  cfg: Pick<HoldsAccessConfig, "adminEmails" | "holdsEmails">,
): HoldsRole | null {
  if (!email) return null;
  if (csvHas(cfg.adminEmails, email)) return "admin";
  if (csvHas(cfg.holdsEmails, email)) return "holds";
  return null;
}

/**
 * A holds-ONLY account: on HOLDORDERS_EMAILS but not a finance user
 * (ALLOWED_EMAILS / ADMIN_EMAILS). Every non-holds finance route rejects
 * these (requireAuth → 403).
 */
export function isHoldsOnlyEmail(
  email: string | null | undefined,
  cfg: HoldsAccessConfig,
): boolean {
  if (!email) return false;
  return (
    csvHas(cfg.holdsEmails, email) &&
    !csvHas(cfg.allowedEmails, email) &&
    !csvHas(cfg.adminEmails, email)
  );
}

export function can(role: HoldsRole | null, perm: HoldsPermission): boolean {
  if (!role) return false;
  return HOLDS_ROLE_PERMISSIONS[role][perm];
}
