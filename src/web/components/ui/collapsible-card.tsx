// CollapsibleCard — a Card whose body collapses behind a toggle bar.
// Used for secondary-information panels that operators need to access
// occasionally but shouldn't dominate the page (recipient lists,
// phones, tags). Defaults to collapsed so the page stays focused on
// action-relevant info.
//
// In collapsed state, the toggle bar shows the title + an optional
// one-line summary (operator at-a-glance — e.g. "1 TO · 2 CC · 1 BCC"
// for a recipients card). Click anywhere on the bar to toggle.
//
// State is local to the component — no prop control. If the parent
// needs persistence across remounts, lift state up explicitly.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "./card";
import { cn } from "../../lib/cn";

export function CollapsibleCard({
  title,
  summary,
  defaultCollapsed = true,
  children,
}: {
  title: string;
  // Optional one-line preview shown in the toggle bar when collapsed.
  // Hidden when expanded (the body itself shows the full content).
  summary?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <Card>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-elevated/40",
          // Slight visual separation between header band and body
          // when expanded so the click target reads as a header.
          !collapsed && "border-b border-default",
        )}
        aria-expanded={!collapsed}
      >
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-muted">
            {title}
          </div>
          {collapsed && summary ? (
            <div className="mt-0.5 truncate text-xs text-secondary">
              {summary}
            </div>
          ) : null}
        </div>
        {collapsed ? (
          <ChevronRight className="size-4 shrink-0 text-muted" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-muted" />
        )}
      </button>
      {!collapsed ? <div className="px-3 py-3">{children}</div> : null}
    </Card>
  );
}
