// Shared section header for the two-book surfaces (origin-split-2 spec §1).
// Every page that shows both receivable books renders one of these per
// section: a 3px accent band (indigo for Feldart, amber for Torah Judaica),
// a colored dot + title, an optional KPI-chip strip, and a right-aligned
// actions slot. Designed to sit as the first child of a bordered section
// container (rounded-lg border bg-subtle) — the band rounds its own top
// corners so the container doesn't need overflow-hidden (which would break
// position:sticky table headers inside the section).

import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type Book = "feldart" | "tj";

const BAND: Record<Book, string> = {
  feldart: "bg-accent-primary",
  tj: "bg-accent-warning",
};

export function BookSectionHeader({
  book,
  title,
  subtitle,
  kpis,
  actions,
}: {
  book: Book;
  title: string;
  subtitle?: string;
  kpis?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div>
      <div className={cn("h-[3px] rounded-t-lg", BAND[book])} aria-hidden />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-default px-4 py-3">
        <span
          className={cn("size-2 shrink-0 rounded-full", BAND[book])}
          aria-hidden
        />
        <h2 className="text-sm font-semibold tracking-tight text-primary">
          {title}
        </h2>
        {subtitle ? (
          <span className="text-xs text-muted">{subtitle}</span>
        ) : null}
        {kpis ? (
          <div className="flex flex-wrap items-center gap-1.5">{kpis}</div>
        ) : null}
        {actions ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Small read-only stat chip for the header's KPI strip. Tones cover the
// delta chip (green when exposure fell, red when it rose) and the amber
// "Verifying N" chip; neutral is the default money/count chip.
export function KpiChip({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "danger" | "warning";
  title?: string;
}) {
  const tones: Record<NonNullable<typeof tone>, string> = {
    neutral: "border-default bg-base text-secondary",
    success: "border-accent-success/40 bg-accent-success/10 text-accent-success",
    danger: "border-accent-danger/40 bg-accent-danger/10 text-accent-danger",
    warning: "border-accent-warning/40 bg-accent-warning/10 text-accent-warning",
  };
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tabular-nums",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
