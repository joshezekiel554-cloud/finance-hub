// Sticky top app bar shown below the `md` breakpoint. Replaces the
// permanent sidebar on phones. Pages can render their own MobileAppBar
// (typically with a back chevron + page title); App.tsx renders a
// default one with the hamburger menu when no page-specific bar is
// in play.

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "../lib/cn";

type Props = {
  title: string;
  // When set, renders a back chevron on the left that calls this on tap.
  // When omitted, the slot is reserved for the parent (e.g. App.tsx's
  // hamburger) — pass `leftSlot` instead.
  back?: () => void;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  subtitle?: string;
  className?: string;
};

export function MobileAppBar({
  title,
  back,
  leftSlot,
  rightSlot,
  subtitle,
  className,
}: Props) {
  return (
    <header
      className={cn(
        "md:hidden sticky top-0 z-30",
        "flex items-center gap-2",
        "h-14 px-3 border-b border-default",
        "bg-base/95 backdrop-blur supports-[backdrop-filter]:bg-base/85",
        className,
      )}
    >
      <div className="flex w-10 shrink-0 items-center justify-start">
        {back ? (
          <button
            type="button"
            aria-label="Back"
            onClick={back}
            className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-primary hover:bg-elevated"
          >
            <ChevronLeft className="size-5" />
          </button>
        ) : (
          leftSlot
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold leading-tight">
          {title}
        </div>
        {subtitle ? (
          <div className="truncate text-[11px] text-muted leading-tight">
            {subtitle}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
        {rightSlot}
      </div>
    </header>
  );
}
