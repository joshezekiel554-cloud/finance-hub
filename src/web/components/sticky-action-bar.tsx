// Fixed-to-bottom action bar shown only on mobile. Honors the iOS home
// indicator via env(safe-area-inset-bottom). Used for primary commits
// (Send to QBO, Save email recipients, etc.) so the operator's thumb
// always reaches them. Desktop renders nothing — pages keep their
// inline action rows.

import type { ReactNode } from "react";
import { cn } from "../lib/cn";

type Props = {
  children: ReactNode;
  className?: string;
};

export function StickyActionBar({ children, className }: Props) {
  return (
    <div
      className={cn(
        "md:hidden",
        "fixed left-0 right-0 bottom-0 z-30",
        "border-t border-default",
        "bg-base/95 backdrop-blur supports-[backdrop-filter]:bg-base/85",
        "px-3 pt-3",
        // Adds standard 12px plus the iOS home-indicator inset.
        "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
        "flex items-center gap-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

// Spacer that reserves vertical room on the scrollable page so the last
// row of content isn't hidden behind the StickyActionBar. Mount once
// near the bottom of the page below `md`.
export function StickyActionBarSpacer() {
  return (
    <div
      aria-hidden
      className="md:hidden h-[calc(4.5rem+env(safe-area-inset-bottom))]"
    />
  );
}
