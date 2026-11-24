// Hold Orders SPA — pure view logic (no DOM, unit-tested). Components stay
// thin; anything with a decision in it lives here.

import { HOLD_TABS, type HoldTab } from "../../../modules/hold-orders/board-classify";
import type { HoldsPermissions } from "../../../modules/hold-orders/permissions";

export type HoldMode = "notify" | "record_only";

export type EmailPreview = {
  to: string;
  cc?: string;
  role: "warehouse" | "customer" | "internal";
  template: string;
  subject: string;
  when: "now" | "next_sync";
};

export function parseTab(v: string | null | undefined): HoldTab {
  return (HOLD_TABS as readonly string[]).includes(v ?? "") ? (v as HoldTab) : "held";
}

export function formatMoney(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function daysLabel(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

const ROLE_LABEL: Record<EmailPreview["role"], string> = {
  warehouse: "Warehouse",
  customer: "Customer",
  internal: "Internal",
};

export function roleLabel(role: EmailPreview["role"]): string {
  return ROLE_LABEL[role];
}

/** One-line summary of who an action will email, for the confirm button. */
export function previewSummary(emails: readonly EmailPreview[], shadowMode: boolean): string {
  if (emails.length === 0) return "Nobody will be emailed.";
  const now = emails.filter((e) => e.when === "now");
  const later = emails.filter((e) => e.when === "next_sync");
  const parts: string[] = [];
  if (now.length) parts.push(`${now.map((e) => roleLabel(e.role).toLowerCase()).join(" + ")} emailed now`);
  if (later.length) parts.push(`${later.map((e) => roleLabel(e.role).toLowerCase()).join(" + ")} emailed on the next sync`);
  const s = parts.join("; ");
  return shadowMode ? `${s} (shadow mode — nothing actually sends)` : s;
}

export function holdConfirmLabel(mode: HoldMode, emails: readonly EmailPreview[]): string {
  if (mode === "record_only") return "Record hold — tell nobody";
  return emails.length ? "Hold & send these emails" : "Hold (nobody to email)";
}

export function releaseConfirmLabel(mode: HoldMode): string {
  return mode === "record_only" ? "Mark released — already told" : "Release & email warehouse";
}

export type DrawerActions = {
  canHold: boolean;
  canRelease: boolean;
  canPause: boolean;
  canResume: boolean;
  canNote: boolean;
  canRecordOnly: boolean;
};

export function drawerActions(
  row: { holdState: string; pausedUntil: string | null },
  perms: HoldsPermissions,
  now: Date = new Date(),
): DrawerActions {
  const held = row.holdState === "on_hold";
  const paused = Boolean(row.pausedUntil && new Date(row.pausedUntil).getTime() > now.getTime());
  return {
    canHold: perms.hold && !held && row.holdState !== "cancelled",
    canRelease: perms.release && held,
    canPause: perms.pause && held,
    canResume: perms.pause && held && paused,
    canNote: perms.note,
    canRecordOnly: perms.recordOnly,
  };
}

export type PaidOutsideMethod = "cheque" | "stripe" | "bank" | "other";

export type ReleaseDraft = {
  paidOutside: boolean;
  method: PaidOutsideMethod;
  paidNote: string;
  note: string;
};

/** Body for POST /release, or an error message to show. */
export function releaseBody(
  mode: HoldMode,
  d: ReleaseDraft,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = { mode };
  if (d.note.trim()) body.note = d.note.trim();
  if (d.paidOutside) {
    if (!d.paidNote.trim()) return { ok: false, error: "Say how it was paid (cheque number, Stripe ref…)." };
    body.paidOutsideQbo = { method: d.method, note: d.paidNote.trim() };
  }
  return { ok: true, body };
}

/** Next calendar day as YYYY-MM-DD (the pause picker's minimum). */
export function tomorrowYmd(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function holdStateLabel(s: string): string {
  switch (s) {
    case "on_hold":
      return "On hold";
    case "released":
      return "Released";
    case "cancelled":
      return "Cancelled";
    default:
      return "Not held";
  }
}
